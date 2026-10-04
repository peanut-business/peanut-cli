import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverUpgrade, upgradeProject } from '../lib/upgrade-project.js';
import { sha256 } from '../lib/protocol.js';

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

function fixture(t, mode = 'ready') {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-upgrade-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const app = path.join(temp, 'app');
    fs.mkdirSync(path.join(app, '.peanut'), { recursive: true });
    fs.mkdirSync(path.join(app, 'scripts'));
    fs.writeFileSync(path.join(app, '.peanut/application-manifest.json'), JSON.stringify(application));
    fs.writeFileSync(path.join(app, 'custom.txt'), 'downstream-owned');
    fs.writeFileSync(path.join(app, 'scripts/scaffold-upgrade'), `<?php
$options = [];
foreach (array_slice($argv, 2) as $arg) { preg_match('/^--([^=]+)=(.*)$/', $arg, $m); $options[$m[1]] = $m[2]; }
$root = $options['project-root'];
$command = $argv[1];
file_put_contents($root . '/calls.jsonl', json_encode([$command, $options]) . "\\n", FILE_APPEND);
if ($command === 'preflight' || $command === 'resolve') {
    $plan = ['protocol' => 'peanut.scaffold-upgrade-plan.v2', 'status' => $command === 'resolve' ? 'ready' : '${mode}', 'plan_sha256' => 'sha256:' . str_repeat('d', 64), 'plan_path' => '.peanut/upgrades/plans/fixture.json', 'actions' => [['path' => 'managed.txt', 'action' => 'conflict']]];
    @mkdir($root . '/.peanut/upgrades/plans', 0700, true);
    file_put_contents($root . '/' . $plan['plan_path'], json_encode($plan));
    echo json_encode($plan);
    exit($plan['status'] === 'blocked' ? 2 : 0);
}
echo json_encode(['status' => ['apply' => 'applied', 'verify' => 'verified', 'recover' => 'recovered'][$command]]);
`);
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
    return { app, temp, fetcher, calls, artifact, archive, nativeCalls };
}

test('upgrade check discovers public release source without changing APP or fetching archive', async (t) => {
    const { app, fetcher, calls, nativeCalls } = fixture(t);
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
    await upgradeProject({ path: app, recoverPlan: result.plan.plan_path });
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
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/peanut.js');
    for (const args of [['--check', '--plan'], ['--ref'], ['--check', '--preserve-paths', 'a'], ['--apply-plan', 'x', '--ref', version]]) {
        const result = spawnSync(process.execPath, [bin, 'upgrade', ...args], { encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /UPGRADE_ARGUMENTS_INVALID/);
    }
});
