import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { releaseDatabaseBackup } from './release-database-backup.js';
const fail = (code) => { throw new Error(`PEANUT_CONFIG_${code}`); };
const resolvePath = (root, value) => path.resolve(root, value);
const probeEnvironment = { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0' };

function candidates(name) {
    const pathValue = process.env.PATH?.split(path.delimiter) ?? [];
    return [...new Set([...pathValue, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])]
        .map((directory) => path.join(directory, name))
        .filter((file) => { try { return fs.statSync(file).isFile() && fs.accessSync(file, fs.constants.X_OK) === undefined; } catch { return false; } });
}

function version(binary, flag = '--version') {
    const result = spawnSync(binary, [flag], { encoding: 'utf8', timeout: 10000, env: probeEnvironment });
    if (result.error || result.status !== 0) return null;
    return `${result.stdout}\n${result.stderr}`.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function composerVersion(binary, php) {
    const cli = cliFile(binary, 'composer');
    if (!cli) return null;
    const result = spawnSync(php, [cli, '--no-plugins', '--no-scripts', '--version'], { encoding: 'utf8', timeout: 10000, env: probeEnvironment });
    if (result.error || result.status !== 0) return null;
    return `${result.stdout}\n${result.stderr}`.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function resolveOne(root, name, preferred, interpreter = null) {
    const values = preferred ? [resolvePath(root, preferred)] : candidates(name);
    const found = values.filter((file) => {
        try {
            if (!fs.statSync(file).isFile() || fs.accessSync(file, fs.constants.X_OK) !== undefined) return false;
            const real = fs.realpathSync(file);
            if (name === 'pnpm' && /(?:^|[/\\])corepack(?:[/\\]|$)/i.test(real)) {
                const packageRoot = path.dirname(path.dirname(real));
                const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
                if (manifest.name !== 'pnpm' || typeof manifest.bin?.pnpm !== 'string'
                    || path.resolve(packageRoot, manifest.bin.pnpm) !== real) return false;
            }
            return true;
        } catch { return false; }
    });
    if (!found.length) fail(`TOOL_MISSING: ${name}`);
    const available = found.map((file) => ({
        path: fs.realpathSync(file),
        storedPath: preferred && !path.isAbsolute(preferred) ? path.relative(root, fs.realpathSync(file)) : fs.realpathSync(file),
        version: name === 'composer' && interpreter ? composerVersion(file, interpreter) : version(file),
    })).filter((item) => item.version);
    if (!available.length) fail(`TOOL_VERSION_UNAVAILABLE: ${name}`);
    return available;
}

async function choose(label, items, recommended) {
    if (items.length === 1) return items[0];
    if (!process.stdin.isTTY || !process.stderr.isTTY) fail(`TOOL_SELECTION_REQUIRED: ${label}`);
    process.stderr.write(`${label} versions found:\n` + items.map((item, i) => `  ${i + 1}) ${item.version} ${item.path}${item.version === recommended ? ' (recommended)' : ''}\n`).join(''));
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = Number((await prompt.question(`${label} [1-${items.length}]: `)).trim());
        if (!Number.isInteger(answer) || answer < 1 || answer > items.length) fail(`TOOL_SELECTION_INVALID: ${label}`);
        return items[answer - 1];
    } finally { prompt.close(); }
}

function cliFile(binary, manager) {
    const result = manager === 'composer' ? null : spawnSync(binary, ['root', '-g'], { encoding: 'utf8', timeout: 10000, env: probeEnvironment });
    if (manager === 'npm' && result.status === 0) {
        const file = path.join(result.stdout.trim(), 'npm', 'bin', 'npm-cli.js');
        if (fs.existsSync(file)) return file;
    }
    if (manager === 'pnpm' && result.status === 0) {
        const file = path.join(result.stdout.trim(), 'pnpm', 'bin', 'pnpm.cjs');
        if (fs.existsSync(file)) return file;
    }
    const real = fs.realpathSync(binary);
    if (manager === 'pnpm' && fs.existsSync(real) && /\.c?js$/.test(real)) return real;
    if (manager === 'composer' && /\.phar$/.test(real)) return real;
    if (manager === 'composer' && fs.existsSync(real)) {
        const header = fs.readFileSync(real).subarray(0, 128).toString('utf8');
        if (header.startsWith('#!/usr/bin/env php') || header.startsWith('<?php')) return real;
    }
    return null;
}

function projectRequirements(root, mainProject) {
    const file = path.join(root, 'tools/toolchain.json');
    const files = [];
    if (fs.existsSync(file)) {
        files.push({ path: 'tools/toolchain.json', sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
        const tools = JSON.parse(fs.readFileSync(file, 'utf8')).tools;
        for (const [name, spec] of Object.entries(tools)) {
            if (spec.package_manager_file) {
                const manifestPath = path.resolve(root, spec.package_manager_file);
                const managerContents = fs.readFileSync(manifestPath);
                files.push({ path: path.relative(root, manifestPath), sha256: createHash('sha256').update(managerContents).digest('hex') });
                const manager = JSON.parse(managerContents.toString('utf8')).packageManager ?? '';
                const match = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/.exec(manager);
                if (!match) fail(`RECOMMENDATION_UNRESOLVED: ${name} package_manager_file`);
                spec.version = match[1];
                spec.recommendation_declared = manager;
                spec.recommendation_source = spec.package_manager_file;
            }
            if (spec.project_composer_file) {
                const sourcePath = path.resolve(root, spec.project_composer_file);
                const source = fs.readFileSync(sourcePath, 'utf8');
                files.push({ path: path.relative(root, sourcePath), sha256: createHash('sha256').update(source).digest('hex') });
                const versionMatch = /^VERSION='(\d+\.\d+\.\d+)'$/m.exec(source);
                const shaMatch = /^SHA256='([a-f0-9]{64})'$/m.exec(source);
                if (!versionMatch || !shaMatch) fail(`RECOMMENDATION_UNRESOLVED: ${name} project_composer_file`);
                spec.version = versionMatch[1];
                spec.sha256 = shaMatch[1];
                spec.recommendation_declared = { version: versionMatch[1], sha256: shaMatch[1] };
                spec.fixedPhar = `.local/toolchain/composer-${versionMatch[1]}.phar`;
                spec.recommendation_source = spec.project_composer_file;
            }
        }
        if (mainProject) {
            for (const [tool, relative] of [['php', 'server/composer.json'], ['node', 'web/package.json']]) {
                if (!tools[tool]) continue;
                const manifestPath = path.join(root, relative);
                try { if (!fs.statSync(manifestPath).isFile()) fail(`REQUIREMENT_FILE_MISSING: ${relative}`); }
                catch { fail(`REQUIREMENT_FILE_MISSING: ${relative}`); }
                const content = fs.readFileSync(manifestPath);
                files.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex') });
            }
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        Object.defineProperty(tools, 'source_files', { value: files, enumerable: false });
        return tools;
    }
    if (mainProject) fail('TOOLCHAIN_MISSING');
    const result = {};
    const composer = path.join(root, 'composer.json');
    const packageFile = path.join(root, 'package.json');
    if (fs.existsSync(composer)) {
        const contents = fs.readFileSync(composer);
        files.push({ path: 'composer.json', sha256: createHash('sha256').update(contents).digest('hex') });
        const manifest = JSON.parse(contents.toString('utf8'));
        if (typeof manifest.require?.php === 'string') {
            result.php = { constraint: manifest.require.php };
            result.composer = { constraint: 'selected-local-binding' };
        }
    }
    if (fs.existsSync(packageFile)) {
        const contents = fs.readFileSync(packageFile);
        files.push({ path: 'package.json', sha256: createHash('sha256').update(contents).digest('hex') });
        const manifest = JSON.parse(contents.toString('utf8'));
        if (typeof manifest.engines?.node === 'string') result.node = { constraint: manifest.engines.node };
        const runtime = manifest.devEngines?.runtime;
        if (runtime && (runtime.name === undefined || runtime.name === 'node') && typeof runtime.version === 'string') {
            (result.node ??= { manifest_constraints: [] }).manifest_constraints.push(['devEngines.runtime.version', runtime.version]);
        } else if (runtime) fail('CORE_RUNTIME_REQUIREMENT_UNSUPPORTED');
        const manager = /^pnpm@(\d+\.\d+\.\d+)/.exec(manifest.packageManager ?? '');
        if (manager) (result.pnpm ??= {}).version = manager[1];
        const devManager = manifest.devEngines?.packageManager;
        if (devManager) {
            if (!['npm', 'pnpm'].includes(devManager.name) || typeof devManager.version !== 'string') fail('CORE_PACKAGE_MANAGER_REQUIREMENT_UNSUPPORTED');
            (result[devManager.name] ??= { manifest_constraints: [] }).manifest_constraints.push(['devEngines.packageManager.version', devManager.version]);
        }
    }
    if (!Object.keys(result).length) fail('CORE_MANIFEST_REQUIREMENTS_MISSING');
    files.sort((a, b) => a.path.localeCompare(b.path));
    Object.defineProperty(result, 'source_files', { value: files, enumerable: false });
    return result;
}

function storedPath(root, file) {
    const absolute = path.resolve(file);
    const relative = path.relative(root, absolute);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : absolute;
}

function readHostFile(file) {
    if (!fs.existsSync(file)) return null;
    let host;
    try { host = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { fail('HOST_CONFIGURATION_INVALID'); }
    if (!host || typeof host !== 'object' || Array.isArray(host) || host.schema_version !== 1
        || !host.commands || typeof host.commands !== 'object' || Array.isArray(host.commands)) fail('HOST_CONFIGURATION_INCOMPATIBLE');
    if ((host.path_base !== undefined && (typeof host.path_base !== 'string' || !path.isAbsolute(host.path_base)))
        || (host.extra_path !== undefined && (!Array.isArray(host.extra_path) || host.extra_path.some((item) => typeof item !== 'string')))
        || (host.watch_paths !== undefined && (!Array.isArray(host.watch_paths) || host.watch_paths.some((item) => typeof item !== 'string')))
        || (host.caches !== undefined && (!host.caches || typeof host.caches !== 'object' || Array.isArray(host.caches)
            || Object.values(host.caches).some((item) => typeof item !== 'string')))
        || (host.paths !== undefined && (!host.paths || typeof host.paths !== 'object' || Array.isArray(host.paths)
            || Object.values(host.paths).some((item) => typeof item !== 'string')))
        || (host.core !== undefined && (!host.core || typeof host.core !== 'object' || Array.isArray(host.core)
            || Object.values(host.core).some((item) => item !== null && typeof item !== 'string')))) fail('HOST_CONFIGURATION_INCOMPATIBLE');
    return host;
}

function hostCommand(host, stateRoot, name, interpreterPath = null) {
    const argv = host?.commands?.[name];
    if (!Array.isArray(argv) || argv.length !== (['npm', 'pnpm', 'composer'].includes(name) ? 2 : 1)
        || argv.some((part) => typeof part !== 'string' || part === '')) fail(`HOST_TOOL_CONFIGURATION_INVALID: ${name}`);
    const base = host.path_base === undefined ? stateRoot : host.path_base;
    if (typeof base !== 'string' || base === '') fail('HOST_PATH_BASE_INVALID');
    const isManager = ['npm', 'pnpm', 'composer'].includes(name);
    const absolute = argv.map((part, index) => isManager && index === 0 && interpreterPath
        ? path.resolve(interpreterPath) : path.resolve(base, part));
    for (const [index, file] of absolute.entries()) {
        try {
            if (!fs.statSync(file).isFile()
                || fs.accessSync(file, index === 0 || !['npm', 'pnpm', 'composer'].includes(name) ? fs.constants.X_OK : fs.constants.R_OK) !== undefined) {
                fail(`HOST_TOOL_UNAVAILABLE: ${name}`);
            }
        }
        catch { fail(`HOST_TOOL_UNAVAILABLE: ${name}`); }
    }
    return absolute;
}

function savedTool(host, stateRoot, name, interpreterPath = null) {
    const argv = hostCommand(host, stateRoot, name, interpreterPath);
    const isManager = ['npm', 'pnpm', 'composer'].includes(name);
    if (!isManager) {
        const real = fs.realpathSync(argv[0]);
        const foundVersion = version(real);
        if (!foundVersion) fail(`HOST_TOOL_VERSION_UNAVAILABLE: ${name}`);
        return { path: real, version: foundVersion };
    }
    const interpreter = fs.realpathSync(argv[0]);
    const cli = fs.realpathSync(argv[1]);
    const result = spawnSync(interpreter, [cli, '--version'], { encoding: 'utf8', timeout: 10000, env: probeEnvironment });
    const foundVersion = !result.error && result.status === 0
        ? `${result.stdout}\n${result.stderr}`.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
    if (!foundVersion) fail(`HOST_TOOL_VERSION_UNAVAILABLE: ${name}`);
    return { path: cli, cli, version: foundVersion };
}

async function planProject(root, options, configureCores = true, stateRoot = root, hostFile = null, inheritedTools = {}) {
    root = fs.realpathSync(root);
    stateRoot = fs.realpathSync(stateRoot);
    const mainProject = !hostFile;
    const target = hostFile ?? path.join(root, '.local/toolchain/host.json');
    const existing = readHostFile(target);
    const requirements = projectRequirements(root, mainProject);
    const selected = {};
    const executable = { php: 'php', node: 'node', npm: 'npm', pnpm: 'pnpm', composer: 'composer', python3: 'python3' };
    for (const [tool, spec] of Object.entries(requirements)) {
        if (options[tool] !== undefined) {
            const list = resolveOne(root, executable[tool], options[tool], tool === 'composer' ? selected.php?.path : null);
            selected[tool] = await choose(tool, list, spec.version);
        } else if (Object.hasOwn(existing?.commands ?? {}, tool)) {
            if (tool === 'composer') {
                const composerCommand = hostCommand(existing, stateRoot, tool, selected.php?.path);
                const fixedPath = requirements.composer?.fixedPhar
                    && path.resolve(composerCommand[1]) === path.resolve(root, requirements.composer.fixedPhar);
                if (!fixedPath) {
                    const binding = existing.selected_tools?.composer;
                    if (!binding || typeof binding.path !== 'string' || typeof binding.version !== 'string' || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? '')) fail('HOST_COMPOSER_BINDING_INVALID');
                    const base = existing.path_base ?? stateRoot;
                    const boundPath = path.resolve(base, binding.path);
                    if (fs.realpathSync(boundPath) !== fs.realpathSync(composerCommand[1])
                        || createHash('sha256').update(fs.readFileSync(composerCommand[1])).digest('hex') !== binding.sha256) fail('HOST_COMPOSER_BINDING_CHANGED');
                }
            }
            selected[tool] = savedTool(existing, stateRoot, tool, ['npm', 'pnpm'].includes(tool) ? selected.node?.path : tool === 'composer' ? selected.php?.path : null);
        } else if (inheritedTools[tool]) {
            const inherited = inheritedTools[tool];
            if (['npm', 'pnpm', 'composer'].includes(tool)) {
                const interpreter = tool === 'composer' ? selected.php?.path : selected.node?.path;
                if (!interpreter) fail(`TOOL_MISSING: ${tool === 'composer' ? 'php' : 'node'}`);
                const result = spawnSync(interpreter, [inherited.cli, '--version'], { encoding: 'utf8', timeout: 10000, env: probeEnvironment });
                const actualVersion = !result.error && result.status === 0
                    ? `${result.stdout}\n${result.stderr}`.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
                if (!actualVersion || actualVersion !== inherited.version) fail(`INHERITED_TOOL_INVALID: ${tool}`);
                selected[tool] = { ...inherited, version: actualVersion };
            } else {
                const foundVersion = version(inherited.path);
                if (!foundVersion || foundVersion !== inherited.version) fail(`INHERITED_TOOL_INVALID: ${tool}`);
                selected[tool] = { ...inherited, version: foundVersion };
            }
        } else {
            const list = resolveOne(root, executable[tool], null, tool === 'composer' ? selected.php?.path : null);
            selected[tool] = await choose(tool, list, spec.version);
        }
        if (spec.version && selected[tool].version !== spec.version) {
            process.stderr.write(`Warning: ${tool} recommended ${spec.version}, selected ${selected[tool].version}; manifest/package-manager compatibility remains independently enforced.\n`);
        }
    }
    const commands = {};
    for (const [tool, item] of Object.entries(selected)) {
        if (tool === 'node' || tool === 'php' || tool === 'python3') commands[tool] = [storedPath(stateRoot, item.path)];
        if (['npm', 'pnpm', 'composer'].includes(tool)) {
            const cli = item.cli ?? cliFile(item.path, tool);
            if (!cli) fail(`CLI_FILE_MISSING: ${tool}`);
            const interpreter = tool === 'composer' ? 'php' : 'node';
            if (!selected[interpreter]) fail(`TOOL_MISSING: ${interpreter}`);
            commands[tool] = [storedPath(stateRoot, selected[interpreter].path), storedPath(stateRoot, cli)];
        }
    }
    const cacheNames = Object.keys(commands).filter((name) => ['npm', 'pnpm', 'composer'].includes(name));
    const coreScopeName = hostFile ? path.basename(path.dirname(hostFile)) : null;
    const defaultPrefix = mainProject ? '.local/toolchain/cache' : `.local/toolchain/cores/${coreScopeName}/cache`;
    const caches = Object.fromEntries(cacheNames.map((name) => [name, options[`${name}Cache`] ?? existing?.caches?.[name] ?? path.posix.join(defaultPrefix, name)]));
    const composerCli = selected.composer ? cliFile(selected.composer.path, 'composer') : null;
    const fixedComposer = requirements.composer?.fixedPhar
        && selected.composer
        && path.resolve(selected.composer.path) === path.resolve(root, requirements.composer.fixedPhar);
    if (existing && options.composer === undefined && Object.hasOwn(existing.commands ?? {}, 'composer') && !fixedComposer
        && existing.selected_tools.composer.version !== selected.composer.version) fail('HOST_COMPOSER_BINDING_CHANGED');
    const selectedTools = selected.composer && !fixedComposer ? { composer: {
        path: storedPath(stateRoot, composerCli), version: selected.composer.version,
        sha256: createHash('sha256').update(fs.readFileSync(composerCli)).digest('hex'),
    } } : {};
    const isMain = mainProject;
    const discoverAdjacentCore = !fs.existsSync(path.join(root, '.peanut/application-manifest.json'));
    const adjacentPhp = path.resolve(root, '../peanut-admin-core-php');
    const adjacentWeb = path.resolve(root, '../peanut-admin-core-web');
    const phpCore = options.corePhp ?? (Object.hasOwn(existing?.core ?? {}, 'php') ? existing.core.php : discoverAdjacentCore && fs.existsSync(path.join(adjacentPhp, 'composer.json')) ? adjacentPhp : null);
    const webCore = options.coreWeb ?? (Object.hasOwn(existing?.core ?? {}, 'web') ? existing.core.web : discoverAdjacentCore && fs.existsSync(path.join(adjacentWeb, 'package.json')) ? adjacentWeb : null);
    const host = {
        ...(existing ?? {}),
        schema_version: 1,
        commands: { ...(existing?.commands ?? {}), ...commands },
        ...(Object.keys(selectedTools).length ? { selected_tools: selectedTools } : {}),
        ...(hostFile ? { path_base: stateRoot } : {}),
        extra_path: options.extraPaths ?? existing?.extra_path ?? [...new Set([...(selected.node ? [path.dirname(selected.node.path)] : []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])],
        caches,
        watch_paths: options.watchPaths ?? existing?.watch_paths ?? [],
        ...(isMain ? {
            release_database_backup: releaseDatabaseBackup(root, existing?.release_database_backup, options),
            core: {
                php: typeof phpCore === 'string' ? path.resolve(root, phpCore) : phpCore,
                web: typeof webCore === 'string' ? path.resolve(root, webCore) : webCore,
            },
            paths: {
                release: options.releasePath ?? existing?.paths?.release ?? 'release',
                backups: options.backupsPath ?? existing?.paths?.backups ?? '../backups',
            },
        } : {}),
    };
    const coreConfigs = {};
    const plans = [{ root, stateRoot, target, host, caches, selected, requirements }];
    if (configureCores) {
        for (const [name, configured] of Object.entries(host.core)) {
            if (!configured) continue;
            const coreRoot = path.resolve(root, configured);
            const expectedManifest = name === 'php' ? 'composer.json' : 'package.json';
            if (!fs.existsSync(path.join(coreRoot, expectedManifest))) fail(`CORE_PROJECT_INVALID: ${name}`);
            const scope = path.join(root, '.local/toolchain/cores', name);
            const scopedOptions = {};
            for (const tool of Object.keys(requirements)) {
                if (options[tool] !== undefined) scopedOptions[tool] = path.resolve(root, options[tool]);
            }
            if (options.extraPaths) scopedOptions.extraPaths = options.extraPaths;
            if (options.watchPaths) scopedOptions.watchPaths = options.watchPaths;
            const inherited = Object.fromEntries(Object.entries(selected).map(([tool, item]) => [tool,
                ['npm', 'pnpm', 'composer'].includes(tool)
                    ? { path: item.path, cli: item.cli ?? cliFile(item.path, tool), version: item.version }
                    : { path: item.path, version: item.version },
            ]));
            const child = await planProject(coreRoot, scopedOptions, false, root, path.join(scope, 'host.json'), inherited);
            plans.push(...child.plans);
            coreConfigs[name] = child.result;
        }
    }
    const coreName = hostFile ? path.relative(path.join(stateRoot, '.local/toolchain/cores'), path.dirname(target)) : null;
    const scopeDirectory = coreName ? path.join(stateRoot, '.local/toolchain/cores', coreName) : path.join(stateRoot, '.local/toolchain/project-env');
    const temporaryDirectory = coreName ? path.join(stateRoot, '.local/toolchain/cores', coreName, 'tmp/project-env') : path.join(stateRoot, '.local/tmp/project-env');
    plans[0].scopeDirectory = scopeDirectory;
    plans[0].temporaryDirectory = temporaryDirectory;
    return { plans, result: { status: 'configured', host: path.relative(stateRoot, target), tools: Object.fromEntries(Object.entries(selected).map(([name, item]) => [name, { path: item.path, version: item.version, recommendation: requirements[name]?.version ?? null, recommendation_source: requirements[name]?.recommendation_source ?? null }])), paths: host.paths, core: coreConfigs } };
}

async function confirmSave(plans, yes) {
    const summary = plans.map(({ root, stateRoot, target, host, selected, requirements, scopeDirectory, temporaryDirectory }) => ({
        project: root,
        host_file: target,
        tools: Object.fromEntries(Object.entries(selected).map(([name, item]) => [name, {
            selected: { path: item.path, version: item.version },
            recommended: requirements[name]?.version ?? null,
            recommendation_declared: requirements[name]?.recommendation_declared ?? null,
            recommendation_source: requirements[name]?.recommendation_source ?? null,
            difference: requirements[name]?.version ? item.version !== requirements[name].version : null,
        }])),
        paths: { core: host.core ?? null, release: host.paths?.release ?? null, backups: host.paths?.backups ?? null, caches: host.caches, extra_path: host.extra_path, watch_paths: host.watch_paths },
        release_database_backup: host.release_database_backup ?? null,
        files: requirements.source_files ?? [],
        writes: [target, ...Object.values(host.caches).map((value) => resolvePath(stateRoot, value)), scopeDirectory, temporaryDirectory],
        prepare_outputs: { directory: path.join(scopeDirectory, 'project-env', '<fingerprint>'), files: ['prepared.json', ...Object.keys(host.commands).map((name) => `bin/${name}`)] },
    }));
    process.stderr.write(`配置预览（尚未写入）：\n${JSON.stringify(summary, null, 2)}\n`);
    if (yes) return;
    if (!process.stdin.isTTY || !process.stderr.isTTY) fail('CONFIRMATION_REQUIRED: use --yes after reviewing the preview');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = (await prompt.question('确认保存以上配置并准备工具环境？ [y/N] ')).trim().toLowerCase();
        if (!['y', 'yes'].includes(answer)) fail('CONFIGURATION_DECLINED');
    } finally { prompt.close(); }
}

export async function configureProject(root, options) {
    root = fs.realpathSync(root);
    const plan = await planProject(root, options);
    await confirmSave(plan.plans, Boolean(options.yes));
    for (const item of plan.plans) {
        for (const directory of Object.values(item.caches)) fs.mkdirSync(resolvePath(item.stateRoot, directory), { recursive: true });
        fs.mkdirSync(path.dirname(item.target), { recursive: true });
        fs.writeFileSync(item.target, `${JSON.stringify(item.host, null, 2)}\n`, { mode: 0o600 });
        fs.chmodSync(item.target, 0o600);
    }
    for (const item of plan.plans) {
        const runner = path.join(item.stateRoot, 'scripts/project-env');
        const args = [runner, '--root', item.root, '--state-root', item.stateRoot, '--host', item.target, 'prepare'];
        const prepare = spawnSync(plan.plans[0].selected.python3.path, args, { cwd: item.stateRoot, stdio: 'inherit' });
        if (prepare.error || prepare.status !== 0) fail(`PROJECT_ENV_PREPARE_FAILED: ${prepare.error?.message ?? prepare.status}`);
    }
    return plan.result;
}
