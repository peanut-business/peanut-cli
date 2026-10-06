import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Release consumption can point at an independently installed published package.
// Source mode is used only for the focused repair rerun, never as release proof.
const packageRoot = path.resolve(process.env.PEANUT_CLI_TEST_PACKAGE_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { discoverUpgrade, upgradeProject } = await import(pathToFileURL(path.join(packageRoot, 'lib/upgrade-project.js')));
const { sha256 } = await import(pathToFileURL(path.join(packageRoot, 'lib/protocol.js')));
const bin = path.join(packageRoot, 'bin/peanut.js');

const repository = 'peanut-business/peanut-admin-code';
const version = '4.0.0-rc.19';
const filename = `peanut-admin-${version}-standalone-upgrade.tar.gz`;
const archiveRoot = filename.slice(0, -7);
const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40), inventory_sha256: 'c'.repeat(64) };
const compatibility = { major_policy: 'same-major', source: { minimum_inclusive: '4.0.0-rc.18', maximum_exclusive: version } };
const application = { schema_version: 2, protocol: 'peanut.application-scaffold.v2',
    application: { name: 'Customer', slug: 'customer', package_identity: 'customer/app', version: '0.1.7', edition: 'standalone', profile: 'standard' },
    template: { version: '4.0.0-rc.18' }, files: [] };
const url = (name) => `https://github.com/${repository}/releases/download/v${version}/${name}`;
const release = { draft: false, prerelease: true, tag_name: `v${version}`, assets: [filename, filename + '.manifest.json'].map((name) => ({ name, browser_download_url: url(name) })) };

// Synthetic public metadata, Git source, native PHP and Composer protocol fixture:
// these tests prove CLI rejection/delegation contracts, not remote or DB validity.
function fixture(t, mode = 'ready', sourceOverrides = {}, dependencyMode = 'installed') {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-upgrade-'));
    const app = path.join(temp, 'app');
    fs.mkdirSync(path.join(app, '.peanut'), { recursive: true });
    fs.mkdirSync(path.join(app, 'server/vendor'), { recursive: true });
    fs.writeFileSync(path.join(app, 'server/vendor/autoload.php'), '<?php\n');
    const sourceRoot = path.join(temp, 'source');
    fs.mkdirSync(path.join(sourceRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, 'scaffold'));
    const sourceInventory = JSON.stringify({ protocol: 'fixture-inventory' });
    fs.writeFileSync(path.join(sourceRoot, 'scaffold/application-template-inventory.json'), sourceInventory);
    fs.writeFileSync(path.join(app, '.peanut/application-manifest.json'), JSON.stringify(application));
    fs.writeFileSync(path.join(app, 'custom.txt'), 'downstream-owned');
    const protectedFiles = ['custom.txt', '.peanut/application-manifest.json'];
    const protectedBefore = protectedFiles.map((file) => fs.readFileSync(path.join(app, file)));
    const assertProtected = () => protectedFiles.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(app, file)), protectedBefore[index], file));
    t.after(() => { try { assertProtected(); } finally { fs.rmSync(temp, { recursive: true, force: true }); } });
    fs.mkdirSync(path.join(sourceRoot, 'server'));
    fs.writeFileSync(path.join(sourceRoot, '.gitignore'), 'server/vendor/\n');
    fs.writeFileSync(path.join(sourceRoot, 'server/composer.json'), JSON.stringify({ name: 'fixture/engine', require: { 'fixture/dependency': '1.0.0' } }));
    if (dependencyMode !== 'missing-lock') fs.writeFileSync(path.join(sourceRoot, 'server/composer.lock'), JSON.stringify({ packages: [{ name: 'fixture/dependency', version: '1.0.0' }], 'packages-dev': [] }));
    const tools = path.join(temp, 'bin');
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'composer'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), server = args[args.indexOf('--working-dir') + 1];
if (${JSON.stringify(dependencyMode)} === 'failed') { console.error('synthetic locked install failure'); process.exit(1); }
if (args.includes('install')) {
 const vendor = path.join(server, 'vendor');
 fs.mkdirSync(path.join(vendor, 'composer'), {recursive: true});
 fs.mkdirSync(path.join(vendor, 'fixture/dependency'), {recursive: true});
 if (${JSON.stringify(dependencyMode)} !== 'missing-autoload') fs.writeFileSync(path.join(vendor, 'autoload.php'), '<?php\\n');
 fs.writeFileSync(path.join(vendor, 'fixture/dependency/library.php'), '<?php // synthetic dependency\\n');
 fs.writeFileSync(path.join(vendor, 'composer/installed.json'), JSON.stringify({dev:false, packages:[{name:'fixture/dependency', version:'1.0.0', 'install-path':'../fixture/dependency'}]}));
}
`, { mode: 0o755 });
    fs.writeFileSync(path.join(sourceRoot, 'scripts/scaffold-upgrade'), `<?php
$options = [];
foreach (array_slice($argv, 2) as $arg) { preg_match('/^--([^=]+)=(.*)$/', $arg, $m); $options[$m[1]] = $m[2]; }
$root = $options['project-root'];
$command = $argv[1];
$behavior = getenv('PEANUT_FIXTURE_NATIVE') ?: '';
file_put_contents($root . '/calls.jsonl', json_encode([$command, $options]) . "\\n", FILE_APPEND);
if ($command === 'preflight' || $command === 'resolve') {
    if ($command === 'preflight') {
        $source = json_decode(file_get_contents($options['package'] . '/upgrade-manifest.json'), true)['build_source'];
        $identity = ['to' => ['version' => '${version}', 'source_commit' => $source['commit'], 'source_tree' => $source['tree'], 'inventory_sha256' => $source['inventory_sha256']]];
    } else { $identity = json_decode(file_get_contents($options['plan']), true)['identity']; }
    $plan = ['protocol' => 'peanut.scaffold-upgrade-plan.v2', 'status' => str_starts_with($behavior, 'blocked-') ? 'blocked' : ($command === 'resolve' ? 'ready' : '${mode}'), 'plan_sha256' => 'sha256:' . str_repeat('d', 64), 'plan_path' => '.peanut/upgrades/plans/' . ($command === 'resolve' ? 'resolved' : 'fixture') . '.json', 'identity' => $identity, 'actions' => [['path' => 'managed.txt', 'action' => 'conflict']]];
    @mkdir($root . '/.peanut/upgrades/plans', 0700, true);
    file_put_contents($root . '/' . $plan['plan_path'], json_encode($plan));
    echo json_encode($plan);
    if (str_contains($behavior, 'stderr')) fwrite(STDERR, 'synthetic native error');
    if ($behavior === 'blocked-exit1') exit(1);
    if ($behavior === 'blocked-exit0' || $behavior === 'success-stderr') exit(0);
    exit($plan['status'] === 'blocked' ? 2 : 0);
}
echo json_encode(['status' => ['apply' => 'applied', 'verify' => 'verified', 'recover' => 'recovered'][$command]]);
if ($behavior === 'success-stderr') fwrite(STDERR, 'synthetic native error');
if ($behavior === 'error-exit1') exit(1);
`);
    const git = (...args) => {
        const result = spawnSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '-b', 'dev');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Peanut Test');
    git('add', '.');
    git('commit', '-m', 'native source fixture');
    git('tag', `v${version}`);
    const source = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), inventory_sha256: sha256(sourceInventory), ...sourceOverrides };
    const previous = Object.fromEntries(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'PATH', 'PEANUT_FIXTURE_NATIVE'].map((key) => [key, process.env[key]]));
    process.env.PATH = tools + path.delimiter + process.env.PATH;
    delete process.env.PEANUT_FIXTURE_NATIVE;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.${sourceRoot}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = `https://github.com/${repository}.git`;
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const packagePath = path.join(temp, archiveRoot);
    fs.mkdirSync(path.join(packagePath, 'META-INF'), { recursive: true });
    const manifest = JSON.stringify({ schema_version: 1, protocol: 'peanut.edition-upgrade-package.v1', target: { version }, edition: { name: 'standalone' }, build_source: source });
    const inventory = sha256(manifest) + '  upgrade-manifest.json\n';
    fs.writeFileSync(path.join(packagePath, 'upgrade-manifest.json'), manifest);
    fs.writeFileSync(path.join(packagePath, 'META-INF/files.sha256'), inventory);
    const packed = spawnSync('tar', ['-czf', path.join(temp, filename), '-C', temp, archiveRoot], { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    assert.equal(packed.status, 0, packed.stderr);
    const archive = fs.readFileSync(path.join(temp, filename));
    const artifact = { schema_version: 1, protocol: 'peanut.edition-upgrade-artifact.v1', product: { version }, edition: { name: 'standalone' }, source, compatibility,
        package: { manifest_sha256: sha256(manifest), inventory_sha256: sha256(inventory) },
        archive: { filename, root: archiveRoot, format: 'tar.gz', sha256: sha256(archive), bytes: archive.length } };
    const calls = [];
    const fetcher = async (address) => {
        calls.push(address);
        const body = address === url(filename) ? archive : address === url(filename + '.manifest.json') ? artifact : address.includes('/tags/') ? release : [release];
        return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => body };
    };
    const nativeCalls = () => fs.existsSync(path.join(app, 'calls.jsonl')) ? fs.readFileSync(path.join(app, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { app, temp, fetcher, calls, artifact, archive, nativeCalls, source, assertProtected };
}

test('upgrade check discovers public release source without changing APP or fetching archive', async (t) => {
    const { app, fetcher, calls, nativeCalls, source } = fixture(t);
    const before = fs.readFileSync(path.join(app, '.peanut/application-manifest.json'));
    const result = await upgradeProject({ path: app, check: true }, fetcher);
    assert.equal(result.status, 'available');
    assert.equal(result.selection.channel, 'prerelease');
    assert.deepEqual(result.selection.source, source);
    assert.equal(calls.includes(url(filename)), false);
    assert.deepEqual(nativeCalls(), []);
    assert.equal(fs.existsSync(path.join(app, '.peanut/upgrades')), false);
    assert.deepEqual(fs.readFileSync(path.join(app, '.peanut/application-manifest.json')), before);
});

test('version refs normalize to published tags; stable source excludes prereleases', async (t) => {
    const { fetcher, calls } = fixture(t);
    await discoverUpgrade(application, { ref: version }, fetcher);
    assert.ok(calls[0].endsWith('/tags/v4.0.0-rc.19'));
    await assert.rejects(discoverUpgrade(application, { channel: 'stable' }, fetcher), /RELEASE_NOT_FOUND/);
    await assert.rejects(discoverUpgrade(application, { ref: 'dev' }, fetcher), /SEMVER_INVALID/);
    await assert.rejects(discoverUpgrade(application, { ref: version, channel: 'stable' }, fetcher), /CHANNEL_MISMATCH/);
});

test('already-current baseline validates release identity without requiring upgrade assets', async () => {
    const lock = Buffer.from(JSON.stringify({ protocol: 'peanut.release-candidate-lock.v1', version, tag: `v${version}`, candidate: source }));
    const manifest = { version, tag: `v${version}`, repository: `https://github.com/${repository}`, commit: source.commit, candidate_lock: { sha256: sha256(lock) } };
    const baseline = { ...release, assets: ['RELEASE_MANIFEST.json', 'RELEASE_CANDIDATE_LOCK.json'].map((name) => ({ name, browser_download_url: url(name) })) };
    const fetcher = async (address) => ({ ok: true, json: async () => address === url('RELEASE_MANIFEST.json') ? manifest : baseline, arrayBuffer: async () => lock });
    const template = { version, source_commit: source.commit, source_tree: source.tree };
    const result = await discoverUpgrade({ ...application, template }, { ref: version }, fetcher);
    assert.equal(result.status, 'up_to_date');
    assert.deepEqual(result.source, source);
    const different = await discoverUpgrade({ ...application, template: { ...template, source_commit: 'f'.repeat(40) } }, { ref: version }, fetcher);
    assert.equal(different.status, 'source_identity_mismatch');
    assert.equal(different.source_alignment, 'different');
    const unknown = await discoverUpgrade({ ...application, template: { version } }, { ref: version }, fetcher);
    assert.equal(unknown.status, 'version_current');
    assert.equal(unknown.source_alignment, 'unknown');
    manifest.candidate_lock.sha256 = 'f'.repeat(64);
    await assert.rejects(discoverUpgrade({ ...application, template: { version } }, { ref: version }, fetcher), /RELEASE_IDENTITY_INVALID/);
});

test('plan downloads authenticated transport and delegates only native preflight', async (t) => {
    const { app, fetcher, nativeCalls, artifact } = fixture(t);
    const result = await upgradeProject({ path: app, plan: true }, fetcher);
    assert.equal(result.status, 'ready');
    assert.equal(fs.existsSync(path.join(app, 'scripts/scaffold-upgrade')), false);
    const bindings = path.join(app, '.peanut/upgrades/engine-bindings');
    assert.equal(fs.readdirSync(bindings).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bindings, fs.readdirSync(bindings)[0]))).selection.source, artifact.source);
    assert.deepEqual(nativeCalls().map(([command]) => command), ['preflight']);
    assert.ok(nativeCalls()[0][1].package.endsWith(`${artifact.archive.sha256}/${archiveRoot}`));
    assert.equal(fs.readFileSync(path.join(app, 'custom.txt'), 'utf8'), 'downstream-owned');
});

test('default upgrade delegates preflight apply verify and retains APP identity/source inputs', async (t) => {
    const { app, fetcher, nativeCalls } = fixture(t);
    const before = fs.readFileSync(path.join(app, '.peanut/application-manifest.json'));
    const result = await upgradeProject({ path: app }, fetcher);
    assert.equal(result.status, 'verified');
    assert.deepEqual(nativeCalls().map(([command]) => command), ['preflight', 'apply', 'verify']);
    assert.deepEqual(fs.readFileSync(path.join(app, '.peanut/application-manifest.json')), before);
    assert.ok(fs.existsSync(nativeCalls()[0][1].package));
});

test('blocked conflicts require explicit native resolution and support native recovery', async (t) => {
    const { app, fetcher, nativeCalls } = fixture(t, 'blocked');
    const result = await upgradeProject({ path: app }, fetcher);
    assert.equal(result.status, 'blocked');
    assert.match(result.conflict_resolution.command, /--confirm-plan-sha256/);
    assert.deepEqual(nativeCalls().map(([command]) => command), ['preflight']);
    await upgradeProject({ path: app, applyPlan: result.plan.plan_path, confirmPlanSha256: result.plan.plan_sha256, preservePaths: 'managed.txt', replacePaths: '-' });
    assert.deepEqual(nativeCalls().map(([command]) => command), ['preflight', 'resolve', 'apply', 'verify']);
    await upgradeProject({ path: app, recoverPlan: '.peanut/upgrades/plans/resolved.json' });
    assert.equal(nativeCalls().at(-1)[0], 'recover');
    await assert.rejects(upgradeProject({ path: app, applyPlan: '../outside.json' }), /PLAN_OUTSIDE_STATE/);
});

test('archive digest mismatch fails before any native command', async (t) => {
    const { app, fetcher, artifact, nativeCalls } = fixture(t);
    artifact.archive.sha256 = 'e'.repeat(64);
    await assert.rejects(upgradeProject({ path: app }, fetcher), /ARCHIVE_DIGEST_MISMATCH/);
    assert.deepEqual(nativeCalls(), []);
    assert.equal(fs.readFileSync(path.join(app, 'custom.txt'), 'utf8'), 'downstream-owned');
});

test('archive links are rejected before native package authentication', async (t) => {
    const { app, temp, artifact, fetcher, nativeCalls } = fixture(t);
    fs.symlinkSync('/tmp', path.join(temp, archiveRoot, 'outside'));
    assert.equal(spawnSync('tar', ['-czf', path.join(temp, 'linked.tar.gz'), '-C', temp, archiveRoot], { env: { ...process.env, COPYFILE_DISABLE: '1' } }).status, 0);
    const linked = fs.readFileSync(path.join(temp, 'linked.tar.gz'));
    artifact.archive.sha256 = sha256(linked);
    artifact.archive.bytes = linked.length;
    const linkedFetcher = async (address, options) => address === url(filename) ? { ok: true, arrayBuffer: async () => linked } : fetcher(address, options);
    await assert.rejects(upgradeProject({ path: app }, linkedFetcher), /ARCHIVE_MEMBER_INVALID/);
    assert.deepEqual(nativeCalls(), []);
});

test('upgrade parser rejects incompatible modes and missing option values before network access', () => {
    for (const args of [['--check', '--plan'], ['--ref'], ['--check', '--preserve-paths', 'a'], ['--apply-plan', 'x', '--ref', version]]) {
        const result = spawnSync(process.execPath, [bin, 'upgrade', ...args], { encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /UPGRADE_ARGUMENTS_INVALID/);
    }
});

test('saved plans reject changed source bytes, hidden untracked runtime and plan tampering', async (t) => {
    const { app, fetcher, artifact, nativeCalls } = fixture(t);
    const result = await upgradeProject({ path: app, plan: true }, fetcher);
    const engine = path.join(app, '.peanut/upgrades/engines', artifact.source.commit);
    const entry = path.join(engine, 'scripts/scaffold-upgrade');
    const original = fs.readFileSync(entry);
    spawnSync('git', ['-C', engine, 'update-index', '--assume-unchanged', 'scripts/scaffold-upgrade']);
    fs.appendFileSync(entry, '\n// changed execution bytes');
    await assert.rejects(upgradeProject({ path: app, applyPlan: result.plan.plan_path }), /ENGINE_CONTENT_MISMATCH/);
    fs.writeFileSync(entry, original);
    fs.writeFileSync(path.join(engine, 'scripts/hidden.php'), '<?php');
    await assert.rejects(upgradeProject({ path: app, recoverPlan: result.plan.plan_path }), /ENGINE_UNTRACKED_CONTENT/);
    fs.unlinkSync(path.join(engine, 'scripts/hidden.php'));
    fs.unlinkSync(entry);
    fs.symlinkSync(path.join(app, 'custom.txt'), entry);
    await assert.rejects(upgradeProject({ path: app, applyPlan: result.plan.plan_path }), /SYMLINK_REJECTED/);
    fs.unlinkSync(entry);
    fs.writeFileSync(entry, original);
    fs.appendFileSync(path.join(app, result.plan.plan_path), ' ');
    await assert.rejects(upgradeProject({ path: app, recoverPlan: result.plan.plan_path }), /PLAN_BINDING_MISMATCH/);
    assert.deepEqual(nativeCalls().map(([command]) => command), ['preflight']);
});

test('public artifact source mismatch rejects fixed Git checkout before native execution', async (t) => {
    const { app, fetcher, nativeCalls } = fixture(t, 'ready', { tree: 'f'.repeat(40) });
    // Keep archive/manifest binding valid; the fixed public Git tree must still
    // match the selected artifact identity before a native command can execute.
    await assert.rejects(upgradeProject({ path: app, plan: true }, fetcher), /ENGINE_IDENTITY_MISMATCH/);
    assert.deepEqual(nativeCalls(), []);
});

for (const [dependencyMode, error] of [['failed', /ENGINE_DEPENDENCY_PREPARATION_FAILED/], ['missing-autoload', /ENGINE_DEPENDENCIES_REQUIRED/], ['missing-lock', /ENGINE_LOCK_REQUIRED/]]) {
    test(`engine dependency failure ${dependencyMode} rejects before native execution`, async (t) => {
        const f = fixture(t, 'ready', {}, dependencyMode);
        await assert.rejects(upgradeProject({ path: f.app, plan: true }, f.fetcher), error);
        assert.deepEqual(f.nativeCalls(), []);
        f.assertProtected();
    });
}

test('saved plans reject dependency identity bytes extra inputs and links', async (t) => {
    const f = fixture(t);
    const result = await upgradeProject({ path: f.app, plan: true }, f.fetcher);
    const engine = path.join(f.app, '.peanut/upgrades/engines', f.source.commit);
    const installed = path.join(engine, 'server/vendor/composer/installed.json');
    const originalInstalled = fs.readFileSync(installed);
    const changed = JSON.parse(originalInstalled);
    changed.packages[0].version = '2.0.0';
    fs.writeFileSync(installed, JSON.stringify(changed));
    await assert.rejects(upgradeProject({ path: f.app, applyPlan: result.plan.plan_path }), /DEPENDENCY_LOCK_MISMATCH/);
    f.assertProtected();
    fs.writeFileSync(installed, originalInstalled);
    const library = path.join(engine, 'server/vendor/fixture/dependency/library.php');
    const originalLibrary = fs.readFileSync(library);
    fs.appendFileSync(library, '// changed dependency');
    await assert.rejects(upgradeProject({ path: f.app, recoverPlan: result.plan.plan_path }), /DEPENDENCY_BINDING_MISMATCH/);
    f.assertProtected();
    fs.writeFileSync(library, originalLibrary);
    const extra = path.join(engine, 'server/vendor/shadow.php');
    fs.writeFileSync(extra, '<?php');
    await assert.rejects(upgradeProject({ path: f.app, applyPlan: result.plan.plan_path }), /DEPENDENCY_BINDING_MISMATCH/);
    f.assertProtected();
    fs.unlinkSync(extra);
    fs.unlinkSync(library);
    fs.symlinkSync(path.join(f.app, 'custom.txt'), library);
    await assert.rejects(upgradeProject({ path: f.app, recoverPlan: result.plan.plan_path }), /SYMLINK_REJECTED/);
    f.assertProtected();
    assert.deepEqual(f.nativeCalls().map(([command]) => command), ['preflight']);
});

test('saved plans reject missing or changed dependency bindings', async (t) => {
    const f = fixture(t);
    const result = await upgradeProject({ path: f.app, plan: true }, f.fetcher);
    const binding = path.join(f.app, '.peanut/upgrades/engine-dependencies', f.source.commit + '.json');
    const bytes = fs.readFileSync(binding);
    fs.unlinkSync(binding);
    await assert.rejects(upgradeProject({ path: f.app, applyPlan: result.plan.plan_path }), /DEPENDENCY_BINDING_REQUIRED/);
    f.assertProtected();
    const changed = JSON.parse(bytes);
    changed.source.commit = 'f'.repeat(40);
    fs.writeFileSync(binding, JSON.stringify(changed));
    await assert.rejects(upgradeProject({ path: f.app, recoverPlan: result.plan.plan_path }), /DEPENDENCY_BINDING_MISMATCH/);
    f.assertProtected();
    assert.deepEqual(f.nativeCalls().map(([command]) => command), ['preflight']);
});

for (const behavior of ['success-stderr', 'blocked-stderr', 'blocked-exit1', 'blocked-exit0']) {
    test(`native failure contract rejects ${behavior}`, async (t) => {
        const f = fixture(t);
        process.env.PEANUT_FIXTURE_NATIVE = behavior;
        await assert.rejects(upgradeProject({ path: f.app, plan: true }, f.fetcher), /NATIVE_(FAILED|OUTPUT_INVALID)/);
        assert.deepEqual(f.nativeCalls().map(([command]) => command), ['preflight']);
        f.assertProtected();
    });
}

for (const behavior of ['success-stderr', 'error-exit1']) {
    test(`native CLI failure contract maps ${behavior} to exit 2 with stderr`, async (t) => {
        const f = fixture(t);
        const plan = await upgradeProject({ path: f.app, plan: true }, f.fetcher);
        const result = spawnSync(process.execPath, [bin, 'upgrade', '--path', f.app, '--apply-plan', plan.plan.plan_path],
            { encoding: 'utf8', env: { ...process.env, PEANUT_FIXTURE_NATIVE: behavior } });
        assert.equal(result.status, 2, result.stdout);
        assert.match(result.stderr, /PEANUT_UPGRADE_NATIVE_FAILED/);
        assert.equal(result.stdout, '');
        assert.deepEqual(f.nativeCalls().map(([command]) => command), ['preflight', 'apply']);
        f.assertProtected();
    });
}
