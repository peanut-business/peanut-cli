import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compareSemver, existingFileWithin, projectPath, projectRoot, readJsonObject, validateSemver } from './protocol.js';
import { downloadModule, moduleCandidates, officialModuleKey, publishedModuleIndex, MODULE_INDEX, MODULE_REPOSITORY } from './module-release.js';
import { listOfficialReleases } from './release-source.js';
import { environmentInvocation } from './project-environment.js';

export const MODULE_OPERATIONS = [
    'create', 'check', 'compile', 'pack', 'adopt', 'install', 'upgrade', 'updates',
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
    return { key, ...values, channel };
}

/** Read-only update discovery: one verified catalog snapshot per Release, never per installed module.
 * Native dry-run remains the authority for dependency closure, Edition/Kernel and migrations.
 */
export async function checkModuleUpdates(root, channel = 'stable', fetcher = fetch) {
    if (!['stable', 'prerelease'].includes(channel)) throw new Error('PEANUT_MODULE_CHANNEL_INVALID');
    const lock = readJsonObject(existingFileWithin(root, path.join(root, 'modules.lock'), 'PEANUT_MODULE_LOCK_REQUIRED'));
    const manifest = readJsonObject(existingFileWithin(root, path.join(root, '.peanut/application-manifest.json'), 'PEANUT_MODULE_APP_REQUIRED'));
    const edition = manifest.edition?.name;
    if (lock.schema_version !== 1 || !Array.isArray(lock.modules)
        || !['standalone', 'multi-tenant'].includes(edition)) throw new Error('PEANUT_MODULE_UPDATE_SOURCE_INVALID');
    const installed = new Map();
    for (const row of lock.modules) {
        if (!row || typeof row.key !== 'string' || typeof row.version !== 'string') throw new Error('PEANUT_MODULE_LOCK_INVALID');
        if (!officialModuleKey(row.key)) continue;
        if (installed.has(row.key)) throw new Error('PEANUT_MODULE_LOCK_DUPLICATE');
        validateSemver(row.version);
        installed.set(row.key, row.version);
    }
    const latest = new Map(), identities = new Map();
    const catalogTags = [];
    for (const release of await listOfficialReleases(fetcher, MODULE_REPOSITORY)) {
        if (release?.draft !== false || !release.published_at || typeof release.prerelease !== 'boolean'
            || !release.assets?.some((asset) => asset.name === MODULE_INDEX)) continue;
        const { index } = await publishedModuleIndex(release, fetcher);
        catalogTags.push(index.tag);
        for (const row of Object.values(index.modules)) {
            const identity = `${row.key}@${row.version}`;
            const previous = identities.get(identity);
            if (previous && previous !== row.sha256) throw new Error('PEANUT_MODULE_VERSION_IDENTITY_CONFLICT');
            identities.set(identity, row.sha256);
            if (!installed.has(row.key) || !row.editions.includes(edition)
                || channel === 'stable' && (release.prerelease || row.version.split('+')[0].includes('-'))) continue;
            const chosen = latest.get(row.key);
            if (!chosen || compareSemver(row.version, chosen.version) > 0) {
                latest.set(row.key, { version: row.version, sha256: row.sha256, tag: index.tag });
            }
        }
    }
    const modules = [...installed].sort(([left], [right]) => left.localeCompare(right)).map(([key, current]) => {
        const target = latest.get(key) ?? null;
        return { key, installed_version: current, available_version: target?.version ?? null,
            available_sha256: target?.sha256 ?? null, catalog_tag: target?.tag ?? null,
            status: !target ? 'no_published_candidate' : compareSemver(target.version, current) > 0 ? 'update_available'
                : compareSemver(target.version, current) === 0 ? 'current' : 'installed_newer' };
    });
    return { schema_version: 1, status: 'checked', channel, edition,
        catalog_tags: catalogTags, modules,
        updates_available: modules.filter((row) => row.status === 'update_available').length,
        scope: 'read-only catalog and modules.lock; native upgrade preflight and runtime tests not run',
        changed: false };
}

export async function runModule(options, fetcher = fetch) {
    const root = projectRoot(options.root ?? process.cwd());
    if (options.operation === 'updates') {
        let channel = 'stable';
        if (options.arguments.length) {
            const args = options.arguments;
            if (args.length === 2 && args[0] === '--channel') channel = args[1];
            else if (args.length === 1 && args[0].startsWith('--channel=')) channel = args[0].slice(10);
            else throw new Error('PEANUT_MODULE_ARGUMENTS_INVALID');
        }
        process.stdout.write(JSON.stringify(await checkModuleUpdates(root, channel, fetcher), null, 2) + '\n');
        return 0;
    }
    const online = onlineArguments(options);
    const entry = existingFileWithin(root, path.join(root, 'server/module'), 'PEANUT_MODULE_ENTRY_REQUIRED');
    const scope = ['check', 'pack', 'create', 'lock'].includes(options.operation) ? 'php,python3' : null;
    const execution = environmentInvocation(root, scope);
    const invoke = (request, capture = false) => {
        const child = spawnSync(execution.executable, [...execution.args, 'php', entry], {
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
        const preflight = invoke({ operation: options.operation, arguments: [...arguments_, '--dry-run'] }, true);
        let result;
        try { result = JSON.parse(preflight.stdout); } catch {
            if (preflight.status !== 0) return forward(preflight);
            throw new Error('PEANUT_MODULE_PREFLIGHT_RESPONSE_INVALID');
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('PEANUT_MODULE_PREFLIGHT_RESPONSE_INVALID');
        if (preflight.status !== 0) {
            // Native install and update both require a successful read-only admission plan.
            if (!online.version && incompatible.has(result.code ?? result.error)) {
                lastPreflight = preflight;
                continue;
            }
            return forward(preflight);
        }
        const expectedOperation = options.operation === 'install' ? 'install' : 'update';
        const sourceValid = expectedOperation === 'install'
            ? result.source === null || typeof result.source?.version === 'string'
            : typeof result.source?.version === 'string';
        if (result.schema_version !== 1 || result.operation !== expectedOperation || result.dry_run !== true
            || result.package_key !== online.key || result.target?.version !== candidate.version
            || result.target?.archive_sha256 !== candidate.sha256
            || !sourceValid || !Array.isArray(result.target?.modules)
            || !result.target.modules.includes(online.key)) {
            throw new Error('PEANUT_MODULE_PREFLIGHT_IDENTITY_INVALID');
        }
        if (result.source && compareSemver(candidate.version, result.source.version) < 0) {
            throw new Error('PEANUT_MODULE_DOWNGRADE_REJECTED');
        }
        if (online.dryRun) return forward(preflight);
        return invoke({ operation: options.operation, arguments: arguments_ }).status;
    }
    if (lastPreflight) return forward(lastPreflight);
    throw new Error('PEANUT_MODULE_RELEASE_NOT_FOUND');
}
