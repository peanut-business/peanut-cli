import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { projectRoot, projectPath, existingFileWithin } from './protocol.js';

const ACTIONS = ['plan', 'enable', 'status', 'disable'];
const KEYS = ['protocol', 'schema_version', 'action', 'instance_id', 'edition', 'config_revision', 'config_sha256', 'desired_enabled', 'applied_revision', 'runtime_state', 'checks', 'drain', 'redacted_secret_refs', 'gaps', 'error_code', 'restart_required'];
const REF_KEYS = ['COLLABORATION_SERVICE_SECRET_FILE', 'COLLABORATION_TICKET_SECRET_FILE'];
const DRAIN_KEYS = ['protocol', 'drain_id', 'plan_sha256', 'targets_sha256', 'durably_drained', 'room_count'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nullableText = (value) => value === null || typeof value === 'string';
const invalid = () => { throw new Error('PEANUT_COLLABORATION_NATIVE_UNCONFIRMED'); };

export function parseCollaborationArguments(raw) {
    const action = raw[0];
    if (!ACTIONS.includes(action)) throw new Error('PEANUT_COLLABORATION_ARGUMENTS_INVALID');
    const options = { action };
    const flags = new Map([['--path', 'path'], ['--configuration', 'configuration'], ['--expected-revision', 'expectedRevision'], ['--drain-id', 'drainId'], ['--probe', 'probe']]);
    for (let index = 1; index < raw.length; index += 1) {
        const argument = raw[index];
        const equals = argument.indexOf('=');
        const flag = equals < 0 ? argument : argument.slice(0, equals);
        const key = flags.get(flag);
        if (!key || Object.hasOwn(options, key)) throw new Error('PEANUT_COLLABORATION_ARGUMENTS_INVALID');
        if (key === 'probe') {
            if (equals >= 0) throw new Error('PEANUT_COLLABORATION_ARGUMENTS_INVALID');
            options.probe = true;
        } else {
            const value = equals < 0 ? raw[++index] : argument.slice(equals + 1);
            if (!value || value.startsWith('-') || value.includes('\0')) throw new Error('PEANUT_COLLABORATION_ARGUMENTS_INVALID');
            options[key] = value;
        }
    }
    if (!options.path || (options.probe && action !== 'status')
        || (options.configuration && !['plan', 'enable'].includes(action))
        || (options.expectedRevision !== undefined && action !== 'enable')
        || (options.drainId !== undefined && action !== 'disable')
        || (action === 'enable' && (!options.configuration || options.expectedRevision === undefined))
        || (action === 'disable' && !options.drainId)) throw new Error('PEANUT_COLLABORATION_ARGUMENTS_INVALID');
    if (options.expectedRevision !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(options.expectedRevision) || !integer(Number(options.expectedRevision))) throw new Error('PEANUT_COLLABORATION_REVISION_INVALID');
        options.expectedRevision = Number(options.expectedRevision);
    }
    if (options.drainId && !/^[A-Za-z0-9_-]{1,128}$/.test(options.drainId)) throw new Error('PEANUT_COLLABORATION_DRAIN_ID_INVALID');
    return options;
}

export function validateCollaborationResult(value, action, exitCode, probe = false, drainId) {
    if (!exact(value, KEYS) || value.protocol !== 'peanut.collaboration.lifecycle.v1' || value.schema_version !== 1 || value.action !== action
        || !nullableText(value.instance_id) || !['engine', 'standalone', 'multi-tenant', null].includes(value.edition)
        || !integer(value.config_revision) || !nullableText(value.config_sha256)
        || !(value.desired_enabled === null || typeof value.desired_enabled === 'boolean') || !(value.applied_revision === null || integer(value.applied_revision))
        || !['disabled', 'prepared', 'starting', 'ready', 'draining', 'stopped', 'unknown'].includes(value.runtime_state)
        || !Array.isArray(value.checks) || !value.checks.every((check) => exact(check, ['key', 'state']) && typeof check.key === 'string' && ['ok', 'failed', 'not_probed', 'unknown'].includes(check.state))
        || !(value.drain === null || object(value.drain)) || !exact(value.redacted_secret_refs, REF_KEYS) || !REF_KEYS.every((key) => typeof value.redacted_secret_refs[key] === 'boolean')
        || !Array.isArray(value.gaps) || !value.gaps.every((gap) => typeof gap === 'string') || !nullableText(value.error_code)
        || typeof value.restart_required !== 'boolean' || ![0, 2, 3, 4].includes(exitCode)) invalid();
    if (action === 'disable' && drainId !== undefined && value.drain !== null && value.drain.drain_id !== drainId) invalid();
    if (exitCode !== 0) {
        if (!value.error_code || value.runtime_state !== 'unknown') invalid();
        if (value.desired_enabled === null && (value.applied_revision !== null || value.instance_id !== null || value.edition !== null
            || value.config_sha256 !== null || value.config_revision !== 0 || !value.checks.some((check) => check.key === 'desired_configuration' && check.state === 'unknown')
            || !value.gaps.includes('configuration_unobserved'))) invalid();
        return { result: value, exitCode };
    }
    if (value.error_code !== null || value.desired_enabled === null) invalid();
    if (value.runtime_state === 'unknown' || value.checks.some((check) => ['failed', 'unknown'].includes(check.state))) return { result: value, exitCode: 4 };
    const checked = (key) => value.checks.some((check) => check.key === key && check.state === 'ok');
    if (['plan', 'enable'].includes(action) || (action === 'status' && !probe)) {
        if (!['prepared', 'disabled'].includes(value.runtime_state) || value.applied_revision !== null || value.checks.length === 0 || value.checks.some((check) => check.state !== 'not_probed')) invalid();
    }
    if (action === 'enable' && (value.runtime_state !== 'prepared' || !value.desired_enabled || !value.restart_required)) invalid();
    if (action === 'disable' && (!['disabled', 'stopped'].includes(value.runtime_state) || value.desired_enabled)) invalid();
    if (action === 'status' && probe && value.runtime_state === 'ready'
        && (!value.desired_enabled || value.applied_revision !== value.config_revision
            || !checked('signed_runtime') || !checked('paired_native_runtime'))) invalid();
    if (action === 'disable' && value.runtime_state === 'stopped') {
        // The APP verifies protocol-2 room captures and the exact native stop;
        // the CLI never signs control requests or reconstructs room operations.
        const receipt = value.drain;
        if (!exact(receipt, DRAIN_KEYS) || receipt.protocol !== 2
            || typeof receipt.drain_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.drain_id)
            || (drainId !== undefined && receipt.drain_id !== drainId)
            || !digest(receipt.plan_sha256) || !digest(receipt.targets_sha256)
            || receipt.durably_drained !== true || !integer(receipt.room_count)
            || !checked('native_room_drain') || !checked('durable_drain') || !checked('native_stop')
            || value.applied_revision !== null || !value.restart_required) invalid();
    }
    return { result: value, exitCode };
}

export function serviceCollaboration(options) {
    let root;
    let entry;
    let configuration;
    // Only generic codes cross this boundary; filesystem exception paths are not diagnostics.
    try {
        // Inspect the original spelling before realpath can erase an alias.
        const input = path.isAbsolute(options.path) ? options.path : `${process.cwd()}${path.sep}${options.path}`;
        const volumeRoot = path.parse(input).root;
        let cursor = volumeRoot;
        if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error();
        for (const segment of input.slice(volumeRoot.length).split(path.sep)) {
            if (segment === '') continue;
            cursor = path.join(cursor, segment);
            if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error();
        }
        root = projectRoot(options.path);
        entry = existingFileWithin(root, projectPath(root, 'server/docker/scripts/configure-collaboration.py'), 'PEANUT_COLLABORATION_ENTRY_INVALID');
        if (options.configuration) {
            const candidate = path.resolve(root, options.configuration);
            const volume = path.parse(candidate).root;
            const relative = path.relative(volume, candidate).split(path.sep).join('/');
            configuration = existingFileWithin(volume, projectPath(volume, relative), 'PEANUT_COLLABORATION_CONFIGURATION_INVALID');
        }
    } catch { throw new Error('PEANUT_COLLABORATION_PATH_INVALID'); }
    const args = [entry, options.action, '--app-root', root];
    if (configuration) args.push('--configuration', configuration);
    if (options.expectedRevision !== undefined) args.push('--expected-revision', String(options.expectedRevision));
    if (options.drainId) args.push('--drain-id', options.drainId);
    if (options.probe) args.push('--probe');
    const native = spawnSync('python3', args, { cwd: root, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (native.error || native.signal || native.stderr?.trim()) invalid();
    let value;
    try { value = JSON.parse(native.stdout); } catch { invalid(); }
    return validateCollaborationResult(value, options.action, native.status, options.probe === true, options.drainId);
}
