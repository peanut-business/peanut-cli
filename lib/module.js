import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compareSemver, existingFileWithin, projectPath, projectRoot, readJsonObject, validateSemver } from './protocol.js';
import { downloadModule, moduleCandidates, officialModuleKey } from './module-release.js';

export const MODULE_OPERATIONS = [
    'create', 'check', 'compile', 'pack', 'adopt', 'install', 'upgrade',
    'disable', 'uninstall', 'sync', 'reconcile', 'make', 'lock', 'release-composition', 'work',
];

export function parseModuleArguments(raw) {
    const operation = raw[0];
    if (!MODULE_OPERATIONS.includes(operation)) throw new Error('PEANUT_MODULE_OPERATION_UNSUPPORTED');
    const arguments_ = [];
    let root;
    for (let index = 1; index < raw.length; index += 1) {
        const argument = raw[index];
        if (argument === '--') {
            arguments_.push(...raw.slice(index + 1));
            break;
        }
        if (argument === '--root' || argument.startsWith('--root=')) {
            if (root !== undefined) throw new Error('PEANUT_MODULE_ROOT_DUPLICATE');
            root = argument === '--root' ? raw[++index] : argument.slice(7);
            if (!root || root.startsWith('--')) throw new Error('PEANUT_MODULE_ROOT_REQUIRED');
        } else {
            arguments_.push(argument);
        }
    }
    return { operation, arguments: arguments_, root };
}

function onlineArguments(options) {
    const [key, ...raw] = options.arguments;
    if (!['upgrade', 'install'].includes(options.operation) || !key?.startsWith('peanut.')
        || key.includes('/') || key.endsWith('.tar') || raw.includes('--help') || raw.includes('-h')) return null;
    if (!officialModuleKey(key)) throw new Error('PEANUT_MODULE_KEY_INVALID');
    const values = {};
    const flags = new Map([['--version', 'version'], ['--channel', 'channel'], ['--dry-run', 'dryRun']]);
    for (let index = 0; index < raw.length; index += 1) {
        const [flag, ...parts] = raw[index].split('=');
        const name = flags.get(flag);
        if (!name || Object.hasOwn(values, name)) throw new Error('PEANUT_MODULE_ARGUMENTS_INVALID');
        if (name === 'dryRun') {
            if (parts.length) throw new Error('PEANUT_MODULE_ARGUMENTS_INVALID');
            values[name] = true;
        } else {
            const value = parts.length ? parts.join('=') : raw[++index];
            if (!value || value.startsWith('--')) throw new Error('PEANUT_MODULE_ARGUMENTS_INVALID');
            values[name] = value;
        }
    }
    const channel = values.channel ?? 'stable';
    if (!['stable', 'prerelease'].includes(channel)) throw new Error('PEANUT_MODULE_CHANNEL_INVALID');
    if (values.version) {
        validateSemver(values.version);
        if (channel === 'stable' && values.version.split('+')[0].includes('-')) throw new Error('PEANUT_MODULE_PRERELEASE_OPT_IN_REQUIRED');
    }
    if (options.operation === 'install' && values.dryRun) throw new Error('PEANUT_MODULE_INSTALL_DRY_RUN_UNSUPPORTED: native install has no dry-run');
    return { key, ...values, channel };
}

export async function runModule(options, fetcher = fetch) {
    const online = onlineArguments(options);
    const root = projectRoot(options.root ?? process.cwd());
    const entry = existingFileWithin(root, path.join(root, 'server/module'), 'PEANUT_MODULE_ENTRY_REQUIRED');
    const runner = existingFileWithin(root, path.join(root, 'scripts/project-env'), 'PEANUT_MODULE_PROJECT_ENV_REQUIRED');
    const hostPath = path.join(root, '.local/toolchain/host.json');
    if (!fs.existsSync(hostPath)) throw new Error('PEANUT_MODULE_CONFIG_REQUIRED: run peanut config first');
    const host = readJsonObject(existingFileWithin(root, hostPath, 'PEANUT_MODULE_CONFIG_INVALID'));
    const python = host.commands?.python3;
    if (!Array.isArray(python) || typeof python[0] !== 'string' || !python[0]) {
        throw new Error('PEANUT_MODULE_CONFIG_TOOL_MISSING: python3');
    }
    const executable = path.resolve(root, host.path_base ?? '.', python[0]);
    const invoke = (request, capture = false) => {
        const child = spawnSync(executable, [runner, '--root', root, '--state-root', root, '--host', hostPath,
            'exec', '--', 'php', entry], {
            cwd: root,
            input: JSON.stringify(request) + '\n',
            stdio: capture ? 'pipe' : ['pipe', 'inherit', 'inherit'],
            encoding: 'utf8',
        });
        if (child.error) throw new Error(`PEANUT_MODULE_COMMAND_FAILED: ${child.error.message}`);
        return { ...child, status: child.status ?? 128 + (constants.signals[child.signal] ?? 0) };
    };
    if (!online) return invoke({ operation: options.operation, arguments: options.arguments }).status;

    const incompatible = new Set(['MODULE_EDITION_UNSUPPORTED', 'MODULE_HOST_CAPABILITY_MISSING',
        'MODULE_HOST_CAPABILITY_INCOMPATIBLE', 'MODULE_PACKAGE_DEPENDENCY_MISSING', 'MODULE_PACKAGE_DEPENDENCY_INCOMPATIBLE']);
    const candidates = await moduleCandidates(online, fetcher);
    let lastPreflight;
    const forward = (child) => {
        process.stdout.write(child.stdout);
        process.stderr.write(child.stderr);
        return child.status;
    };
    for (const candidate of candidates) {
        const bytes = await downloadModule(candidate, online.key, fetcher);
        const directory = projectPath(root, '.local/module-downloads/' + candidate.sha256);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const archive = projectPath(root, `.local/module-downloads/${candidate.sha256}/${candidate.asset}`);
        // Always replace with this invocation's verified download, never trust cached bytes.
        if (fs.existsSync(archive)) existingFileWithin(root, archive, 'PEANUT_MODULE_CACHE_INVALID');
        fs.writeFileSync(archive, bytes, { mode: 0o600 });
        const arguments_ = [archive, '--sha256', candidate.sha256];
        const preflight = invoke({ operation: 'upgrade', arguments: [...arguments_, '--dry-run'] }, true);
        let result;
        try { result = JSON.parse(preflight.stdout); } catch {
            if (preflight.status !== 0) return forward(preflight);
            throw new Error('PEANUT_MODULE_PREFLIGHT_RESPONSE_INVALID');
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('PEANUT_MODULE_PREFLIGHT_RESPONSE_INVALID');
        if (preflight.status !== 0) {
            // Native update verifies archive, Edition and dependencies before checking installation.
            // A new install may proceed only past that exact not-installed result.
            if (options.operation === 'install' && result.code === 'PLUGIN_NOT_INSTALLED') {
                return invoke({ operation: 'install', arguments: arguments_ }).status;
            }
            if (!online.version && incompatible.has(result.code)) {
                lastPreflight = preflight;
                continue;
            }
            return forward(preflight);
        }
        if (options.operation === 'install') throw new Error('PEANUT_MODULE_ALREADY_INSTALLED: use module upgrade');
        if (result.schema_version !== 1 || result.operation !== 'update' || result.dry_run !== true
            || result.package_key !== online.key || result.target?.version !== candidate.version
            || result.target?.archive_sha256 !== candidate.sha256 || typeof result.source?.version !== 'string') {
            throw new Error('PEANUT_MODULE_PREFLIGHT_IDENTITY_INVALID');
        }
        if (compareSemver(candidate.version, result.source.version) < 0) throw new Error('PEANUT_MODULE_DOWNGRADE_REJECTED');
        if (online.dryRun) return forward(preflight);
        return invoke({ operation: 'upgrade', arguments: arguments_ }).status;
    }
    if (lastPreflight) return forward(lastPreflight);
    throw new Error('PEANUT_MODULE_RELEASE_NOT_FOUND');
}
