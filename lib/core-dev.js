import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existingFileWithin, readJsonObject, resolveWorkingRoot } from './protocol.js';
import { environmentInvocation } from './project-environment.js';

const CORE_WEB_PACKAGES = ['client', 'vue', 'ui-vue', 'nuxt', 'uniapp', 'testing'];
const ALLOWED_CLIENTS = ['web', 'platform', 'pc', 'uniapp'];
const ACTION_ALIASES = new Map([
    ['status', 'status'],
    ['path', 'path'],
    ['link', 'path'],
    ['local', 'path'],
    ['release', 'release'],
    ['reset', 'release'],
    ['unlink', 'release'],
    ['fixed', 'release'],
]);

function fail(code) {
    throw new Error(`PEANUT_CORE_${code}`);
}

function safeRealpath(target) {
    try {
        return fs.realpathSync(target);
    } catch {
        return null;
    }
}

function regularJsonIfExists(file) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
    return readJsonObject(file);
}

function validateClientSelection(value) {
    if (value === 'all') return ALLOWED_CLIENTS;
    const parts = value.split(',');
    if (!parts.length || parts.some((part) => !ALLOWED_CLIENTS.includes(part)) || new Set(parts).size !== parts.length) {
        fail('CLIENT_INVALID');
    }
    return parts;
}

export function parseCoreArguments(raw) {
    const options = {};
    let action = null;
    const flags = new Map([
        ['--path', 'path'],
        ['--core-php', 'corePhp'],
        ['--core-web', 'coreWeb'],
        ['--client', 'client'],
    ]);
    for (let index = 0; index < raw.length; index += 1) {
        const argument = raw[index];
        if (!argument.startsWith('-')) {
            const mapped = ACTION_ALIASES.get(argument);
            if (!mapped || action !== null) fail('ARGUMENTS_INVALID');
            action = mapped;
            continue;
        }
        const split = argument.indexOf('=');
        const flag = split < 0 ? argument : argument.slice(0, split);
        const key = flags.get(flag);
        if (!key || Object.hasOwn(options, key)) fail('ARGUMENTS_INVALID');
        const value = split < 0 ? (raw[++index] ?? '') : argument.slice(split + 1);
        if (!value || value.startsWith('--')) fail('ARGUMENTS_INVALID');
        options[key] = value;
    }
    action ??= 'status';
    if (options.client !== undefined) validateClientSelection(options.client);
    if (action === 'release' && (options.corePhp !== undefined || options.coreWeb !== undefined)) {
        fail('ARGUMENTS_INVALID');
    }
    return { action, ...options };
}

function assertScaffoldOrModuleRoot(root) {
    if (!fs.existsSync(path.join(root, 'server/composer.json')) || !fs.existsSync(path.join(root, 'scripts/core-dev'))) {
        throw new Error(`PEANUT_CORE_PROJECT_INVALID: expected server/composer.json and scripts/core-dev in ${root}`);
    }
}

function resolveConfiguredSources(root, options = {}) {
    const selectionFile = path.join(root, '.local/core-dev.json');
    const selection = regularJsonIfExists(selectionFile);
    const hostFile = path.join(root, '.local/toolchain/host.json');
    const host = regularJsonIfExists(hostFile);
    const adjacentPhp = path.resolve(root, '../peanut-admin-core-php');
    const adjacentWeb = path.resolve(root, '../peanut-admin-core-web');
    const rawPhp = options.corePhp
        ?? (typeof selection?.php_core_dir === 'string' ? selection.php_core_dir : null)
        ?? (typeof host?.core?.php === 'string' ? host.core.php : null)
        ?? (fs.existsSync(path.join(adjacentPhp, 'composer.json')) ? adjacentPhp : null);
    const rawWeb = options.coreWeb
        ?? (typeof selection?.web_core_dir === 'string' ? selection.web_core_dir : null)
        ?? (typeof host?.core?.web === 'string' ? host.core.web : null)
        ?? (fs.existsSync(path.join(adjacentWeb, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(adjacentWeb, 'package.json'))
            ? adjacentWeb : null);
    return {
        selection_file_present: selection !== null,
        selection,
        expected_php_dir: rawPhp ? (safeRealpath(path.resolve(root, rawPhp)) ?? path.resolve(root, rawPhp)) : null,
        expected_web_dir: rawWeb ? (safeRealpath(path.resolve(root, rawWeb)) ?? path.resolve(root, rawWeb)) : null,
    };
}

function inspectPhpCore(root, expectedPhpDir) {
    const composerManifest = readJsonObject(path.join(root, 'server/composer.json'));
    const constraint = composerManifest.require?.['peanut-admin/core'] ?? null;
    const lock = regularJsonIfExists(path.join(root, 'server/composer.lock'));
    const lockedPkg = Array.isArray(lock?.packages)
        ? lock.packages.find((item) => item?.name === 'peanut-admin/core') ?? null
        : null;
    const lockedVersion = lockedPkg?.version ?? null;
    const lockedRef = lockedPkg?.source?.reference ?? null;
    const autoloadReady = fs.existsSync(path.join(root, 'server/vendor/autoload.php'));
    const servicesReady = fs.existsSync(path.join(root, 'server/vendor/services.php'));
    const installedData = regularJsonIfExists(path.join(root, 'server/vendor/composer/installed.json'));
    const installedPackages = Array.isArray(installedData) ? installedData : (installedData?.packages ?? []);
    const installedPkg = Array.isArray(installedPackages)
        ? installedPackages.find((item) => item?.name === 'peanut-admin/core') ?? null
        : null;
    const coreDir = path.join(root, 'server/vendor/peanut-admin/core');
    const stat = fs.lstatSync(coreDir, { throwIfNoEntry: false });
    if (!stat) {
        return {
            present: false,
            vendor_installed: autoloadReady,
            mode: 'missing',
            constraint,
            locked_version: lockedVersion,
            installed_version: null,
            symlink_target: null,
            services_ready: servicesReady,
            synced: false,
        };
    }
    if (stat.isSymbolicLink()) {
        const resolved = safeRealpath(coreDir);
        const manifest = resolved ? regularJsonIfExists(path.join(resolved, 'composer.json')) : null;
        const validPackage = manifest?.name === 'peanut-admin/core';
        const matchesExpected = !expectedPhpDir || resolved === expectedPhpDir;
        const synced = Boolean(resolved && validPackage && matchesExpected && autoloadReady && servicesReady);
        return {
            present: true,
            vendor_installed: autoloadReady,
            mode: 'local-path',
            constraint,
            locked_version: lockedVersion,
            installed_version: installedPkg?.version ?? manifest?.version ?? null,
            symlink_target: resolved,
            valid_checkout: validPackage,
            services_ready: servicesReady,
            synced,
        };
    }
    const installedVersion = installedPkg?.version ?? null;
    const installedRef = installedPkg?.source?.reference ?? null;
    const sameRef = !lockedRef || !installedRef || lockedRef === installedRef;
    const synced = Boolean(autoloadReady && servicesReady && lockedVersion && installedVersion === lockedVersion && sameRef);
    return {
        present: true,
        vendor_installed: autoloadReady,
        mode: 'release',
        constraint,
        locked_version: lockedVersion,
        installed_version: installedVersion,
        symlink_target: null,
        services_ready: servicesReady,
        synced,
    };
}

function inspectWebCore(root, expectedWebDir, clients) {
    const result = {};
    for (const client of clients) {
        const manifestPath = path.join(root, client, 'package.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = readJsonObject(manifestPath);
        const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
        const coreDeps = CORE_WEB_PACKAGES
            .map((shortName) => [shortName, `@peanut-admin/${shortName}`])
            .filter(([, fullName]) => typeof declared[fullName] === 'string');
        const nodeModulesDir = path.join(root, client, 'node_modules');
        const nodeModulesReal = safeRealpath(nodeModulesDir);
        const packages = {};
        const clientModes = new Set();
        let clientSynced = Boolean(nodeModulesReal);
        for (const [shortName, fullName] of coreDeps) {
            const expectedSpec = declared[fullName];
            const pkgDir = path.join(nodeModulesDir, fullName);
            const stat = fs.lstatSync(pkgDir, { throwIfNoEntry: false });
            if (!stat || !nodeModulesReal) {
                packages[fullName] = {
                    expected_version: expectedSpec,
                    mode: 'missing',
                    installed_version: null,
                    symlink_target: null,
                    dist_ready: false,
                    synced: false,
                };
                clientModes.add('missing');
                clientSynced = false;
                continue;
            }
            const resolved = safeRealpath(pkgDir);
            const isExternal = Boolean(resolved && !resolved.startsWith(nodeModulesReal + path.sep));
            const pkgManifest = resolved ? regularJsonIfExists(path.join(resolved, 'package.json')) : null;
            const installedVersion = pkgManifest?.version ?? null;
            const distReady = Boolean(resolved
                && fs.existsSync(path.join(resolved, 'dist/index.js'))
                && fs.existsSync(path.join(resolved, 'dist/index.d.ts')));
            if (isExternal) {
                const expectedPkgDir = expectedWebDir ? path.join(expectedWebDir, 'packages', shortName) : null;
                const matchesExpected = !expectedPkgDir || resolved === (safeRealpath(expectedPkgDir) ?? expectedPkgDir);
                const validName = pkgManifest?.name === fullName;
                const synced = Boolean(validName && matchesExpected && distReady);
                packages[fullName] = {
                    expected_version: expectedSpec,
                    mode: 'local-path',
                    installed_version: installedVersion,
                    symlink_target: resolved,
                    dist_ready: distReady,
                    synced,
                };
                clientModes.add('local-path');
                if (!synced) clientSynced = false;
            } else {
                const exactVersion = !/^(workspace:|file:|link:|[~^])/.test(expectedSpec);
                const synced = Boolean(pkgManifest?.name === fullName
                    && (!exactVersion || installedVersion === expectedSpec)
                    && distReady);
                packages[fullName] = {
                    expected_version: expectedSpec,
                    mode: 'release',
                    installed_version: installedVersion,
                    symlink_target: null,
                    dist_ready: distReady,
                    synced,
                };
                clientModes.add('release');
                if (!synced) clientSynced = false;
            }
        }
        const mode = clientModes.size === 0 ? 'none' : clientModes.size === 1 ? [...clientModes][0] : 'mixed';
        result[client] = {
            installed: Boolean(nodeModulesReal),
            mode,
            synced: clientSynced,
            packages,
        };
    }
    return result;
}

export function inspectCoreStatus(root, options = {}) {
    assertScaffoldOrModuleRoot(root);
    const clients = validateClientSelection(options.client ?? 'all');
    const sources = resolveConfiguredSources(root, options);
    const versions = regularJsonIfExists(path.join(root, 'release-versions.json'));
    const php = inspectPhpCore(root, sources.expected_php_dir);
    const web = inspectWebCore(root, sources.expected_web_dir, clients);
    const modes = new Set([php.mode, ...Object.values(web).filter((item) => item.mode !== 'none').map((item) => item.mode)]);
    const overallMode = modes.size === 1 ? [...modes][0] : 'mixed';
    const allWebSynced = Object.values(web).every((item) => item.synced);
    const selectionConsistent = overallMode === 'local-path'
        ? sources.selection_file_present
        : overallMode === 'release'
            ? !sources.selection_file_present
            : false;
    const synced = php.synced && allWebSynced && (overallMode === 'local-path' || overallMode === 'release') && selectionConsistent;
    return {
        status: synced ? 'ok' : 'out_of_sync',
        mode: overallMode,
        root,
        core_sources: {
            php: sources.expected_php_dir,
            web: sources.expected_web_dir,
            selection_file_present: sources.selection_file_present,
        },
        release_contract: {
            php: versions?.core_php?.resolved_version ?? null,
            web: versions?.core_web?.packages?.['@peanut-admin/client']?.version ?? null,
        },
        php,
        web,
    };
}

export async function runCoreDev(options = {}) {
    const root = resolveWorkingRoot(options.path);
    assertScaffoldOrModuleRoot(root);
    const action = options.action ?? 'status';
    if (action === 'status') {
        return inspectCoreStatus(root, options);
    }
    const coreDevScript = existingFileWithin(root, path.join(root, 'scripts/core-dev'), 'PEANUT_CORE_SCRIPT_REQUIRED');
    const execution = environmentInvocation(root, null, 'run');
    const args = [];
    if (action === 'path') {
        args.push('install');
        if (options.corePhp) args.push('--php-core-dir', path.resolve(root, options.corePhp));
        if (options.coreWeb) args.push('--web-core-dir', path.resolve(root, options.coreWeb));
        if (options.client) args.push('--client', options.client);
    } else if (action === 'release') {
        args.push('reset');
        if (options.client) args.push('--client', options.client);
    } else {
        fail('ACTION_UNSUPPORTED');
    }
    const result = spawnSync(execution.executable, [...execution.args, 'bash', coreDevScript, ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
        fail(`COMMAND_FAILED: ${result.error?.message ?? result.status}`);
    }
    return inspectCoreStatus(root, options);
}
