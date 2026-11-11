import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseModuleArguments, runModule } from '../lib/module.js';
import { MODULE_INDEX, MODULE_REPOSITORY, moduleCandidates } from '../lib/module-release.js';
import { sha256 } from '../lib/protocol.js';
import { archive } from './helpers/template-fixture.js';

const cli = fileURLToPath(new URL('../bin/peanut.js', import.meta.url));
const api = `https://api.github.com/repos/${MODULE_REPOSITORY}/releases`;
const encode = (value) => Buffer.from(JSON.stringify(value));

function moduleTar(version, key = 'peanut.file', mutate = () => {}) {
    const files = new Map([
        [`server/app/modules/peanut/${key.slice(7).replaceAll('-', '_')}/module.json`, encode({ key, version,
            license: 'Apache-2.0', kernel_constraint: '^1.0', dependencies: [] })],
        ['server/app/modules/peanut/file/composer.json', encode({ extra: { peanut: { editions: ['standalone', 'multi-tenant'] } } })],
    ]);
    const inventory = [...files].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => `${name}\0${sha256(bytes)}\n`).join('');
    files.set('META-INF/files.sha256', Buffer.from(inventory));
    mutate(files);
    return gunzipSync(archive([...files]));
}

function fixture(t, { installed = '1.0.40', errors = {}, response = {} } = {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'peanut-module-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['scripts', 'server', '.local/toolchain']) fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, 'server/module'), 'native application entry placeholder');
    fs.writeFileSync(path.join(root, '.local/toolchain/host.json'), JSON.stringify({ commands: { python3: [process.execPath] } }));
    fs.writeFileSync(path.join(root, '.local/native-state.json'), JSON.stringify({ installed, errors, response }));
    // Simulates the existing APP JSON bridge, never PHP business behavior or a real database.
    fs.writeFileSync(path.join(root, 'scripts/project-env'), `
const fs = require('node:fs');
const path = require('node:path');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const state = JSON.parse(fs.readFileSync('.local/native-state.json', 'utf8'));
fs.appendFileSync('.local/native-calls.jsonl', JSON.stringify(request) + '\\n');
const dryRun = request.arguments.includes('--dry-run');
const name = path.basename(request.arguments[0] || '');
const version = name.replace(/^peanut\\.file-/, '').replace(/\\.tar$/, '');
const pin = request.arguments[request.arguments.indexOf('--sha256') + 1];
if (dryRun) {
    const code = state.errors[version] || (request.operation === 'upgrade' && state.installed === null ? 'PLUGIN_NOT_INSTALLED' : null);
    if (code) { console.log(JSON.stringify({ code, reason: version })); process.exit(7); }
    console.log(JSON.stringify({ schema_version: 1,
        operation: request.operation === 'install' ? 'install' : 'update', dry_run: true,
        package_key: 'peanut.file', source: state.installed === null ? null : { version: state.installed },
        target: { version, archive_sha256: pin, modules: ['peanut.file'] }, ...state.response }));
} else {
    fs.writeFileSync('.local/applied.json', JSON.stringify(request));
    console.log(JSON.stringify({ operation: request.operation, applied: true }));
    process.exit(state.exit || 0);
}
`);
    const releases = [], bytes = new Map(), calls = [];
    const fetcher = async (url) => {
        calls.push(url);
        if (url === `${api}?per_page=100&page=1`) return { ok: true, json: async () => structuredClone(releases) };
        assert.ok(bytes.has(url), `unexpected network request: ${url}`);
        return { ok: true, arrayBuffer: async () => bytes.get(url) };
    };
    function add(version, { key = 'peanut.file', prerelease = version.includes('-'), ...overrides } = {}, mutateTar) {
        const id = releases.length + 1;
        const tag = 'bundle-' + id;
        const base = `https://github.com/${MODULE_REPOSITORY}/releases/download/${tag}/`;
        const name = `${key}-${version}.tar`;
        const tar = moduleTar(version, key, mutateTar);
        const index = { schema_version: 1, protocol: 'peanut.module-release-index.v1',
            repository: MODULE_REPOSITORY, tag, commit: 'a'.repeat(40),
            modules: [{ key, version, asset: name, sha256: sha256(tar), bytes: tar.length,
                license: 'Apache-2.0', editions: ['multi-tenant', 'standalone'],
                kernel_constraint: '^1.0', dependencies: [] }] };
        const release = { id, url: `${api}/${id}`, html_url: `https://github.com/${MODULE_REPOSITORY}/releases/tag/${tag}`,
            tag_name: tag, draft: false, prerelease, published_at: '2026-11-10T00:00:00Z', assets: [], ...overrides };
        const seal = () => {
            bytes.set(base + name, tar);
            bytes.set(base + MODULE_INDEX, encode(index));
            release.assets = [name, MODULE_INDEX].map((asset) => ({ name: asset, browser_download_url: base + asset,
                digest: 'sha256:' + sha256(bytes.get(base + asset)) }));
        };
        seal();
        releases.push(release);
        return { release, index, tar, name, base, seal, asset: (asset = name) => release.assets.find((row) => row.name === asset) };
    }
    const nativeCalls = () => fs.existsSync(path.join(root, '.local/native-calls.jsonl'))
        ? fs.readFileSync(path.join(root, '.local/native-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    const run = (args = [], operation = 'upgrade') => runModule({ root, operation, arguments: ['peanut.file', ...args] }, fetcher);
    return { root, releases, bytes, calls, fetcher, add, nativeCalls, run,
        applied: () => fs.existsSync(path.join(root, '.local/applied.json')) };
}

test('online upgrade independently selects the highest stable module across multi-module Releases', async (t) => {
    const f = fixture(t);
    const newest = f.add('1.0.47');
    newest.index.modules.push({ ...newest.index.modules[0], key: 'peanut.article', version: '9.0.0', asset: 'peanut.article-9.0.0.tar', sha256: 'f'.repeat(64) });
    newest.seal();
    f.add('1.0.42'); // Later Release tag, lower module version.
    f.add('2.0.0-rc.1');
    assert.equal(await f.run(), 0);
    const [preflight, apply] = f.nativeCalls();
    assert.deepEqual(preflight.arguments, [...apply.arguments, '--dry-run']);
    assert.equal(apply.operation, 'upgrade');
    assert.equal(apply.arguments[2], sha256(newest.tar));
    assert.match(apply.arguments[0], /\.local\/module-downloads\/[a-f0-9]{64}\/peanut\.file-1\.0\.47\.tar$/);
    assert.equal(f.calls.filter((url) => url.endsWith(newest.name)).length, 1);
    assert.equal(f.calls.filter((url) => url.startsWith(api)).length, 1);
    assert.equal(f.calls.some((url) => /latest|tags\/|raw|HEAD|2\.0\.0-rc/.test(url)), false);
    assert.equal(f.applied(), true);
});

test('online exact stable, RC opt-in and prerelease discovery stay exact', async (t) => {
    for (const args of [['--version', '1.0.47'], ['--version=1.0.48-rc.2', '--channel=prerelease'], ['--channel', 'prerelease']]) {
        const f = fixture(t);
        f.add('1.0.47'); f.add('1.0.48-rc.2');
        assert.equal(await f.run([...args, '--dry-run']), 0);
        assert.equal(f.nativeCalls().length, 1);
        assert.match(f.nativeCalls()[0].arguments[0], args[0] === '--version' ? /1\.0\.47\.tar$/ : /1\.0\.48-rc\.2\.tar$/);
        assert.equal(f.applied(), false);
    }
    const f = fixture(t);
    await assert.rejects(f.run(['--version', '1.0.48-rc.2']), /PRERELEASE_OPT_IN_REQUIRED/);
    assert.equal(f.calls.length, 0);
});

test('drafts, unpublished releases, absent exact versions and RCs mislabeled stable are not selected', async (t) => {
    const f = fixture(t);
    f.add('1.0.47', { draft: true });
    f.add('1.0.48', { published_at: null });
    f.add('1.0.49-rc.1', { prerelease: false });
    await assert.rejects(f.run(), /RELEASE_NOT_FOUND/);
    await assert.rejects(f.run(['--version', '9.0.0']), /RELEASE_NOT_FOUND/);
    assert.equal(f.calls.some((url) => url.endsWith('.tar')), false);
    assert.equal(f.applied(), false);
});

test('default selection uses native Edition, host and dependency preflight without a second solver', async (t) => {
    for (const code of ['MODULE_EDITION_UNSUPPORTED', 'MODULE_HOST_CAPABILITY_MISSING', 'MODULE_HOST_CAPABILITY_INCOMPATIBLE',
        'MODULE_PACKAGE_DEPENDENCY_MISSING', 'MODULE_PACKAGE_DEPENDENCY_INCOMPATIBLE']) {
        const f = fixture(t, { errors: { '2.0.0': code } });
        f.add('1.0.47'); f.add('2.0.0');
        assert.equal(await f.run(), 0);
        assert.equal(f.nativeCalls().length, 3);
        assert.match(f.nativeCalls()[2].arguments[0], /1\.0\.47\.tar$/);
        assert.equal(f.calls.filter((url) => url.endsWith('.tar')).length, 2);
    }
});

test('exact incompatibility, downgrade, permission and runtime failures stop before native writes', async (t) => {
    for (const [code, args] of [['MODULE_EDITION_UNSUPPORTED', ['--version', '2.0.0']],
        ['PLUGIN_DOWNGRADE_REJECTED', []], ['MODULE_PACKAGE_UPDATE_FAILED', []], ['MODULE_MAINTENANCE_ACCESS_DENIED', []]]) {
        const f = fixture(t, { errors: { '2.0.0': code } });
        f.add('1.0.47'); f.add('2.0.0');
        assert.equal(await f.run(args), 7);
        assert.equal(f.nativeCalls().length, 1);
        assert.equal(f.applied(), false);
    }
    const f = fixture(t, { installed: '9.0.0' });
    f.add('1.0.47');
    await assert.rejects(f.run(), /DOWNGRADE_REJECTED/);
    assert.equal(f.applied(), false);
});

test('online install obtains a native install plan before exact native apply', async (t) => {
    const f = fixture(t, { installed: null, errors: { '2.0.0': 'MODULE_PACKAGE_DEPENDENCY_INCOMPATIBLE' } });
    f.add('2.0.0'); f.add('1.0.47');
    assert.equal(await f.run([], 'install'), 0);
    assert.deepEqual(f.nativeCalls().map((call) => call.operation), ['install', 'install', 'install']);
    assert.match(f.nativeCalls()[2].arguments[0], /1\.0\.47\.tar$/);
    assert.deepEqual(f.nativeCalls()[1].arguments, [...f.nativeCalls()[2].arguments, '--dry-run']);
    assert.equal(f.calls.filter((url) => url.startsWith(api)).length, 1);
    const installed = fixture(t);
    installed.add('1.0.47');
    assert.equal(await installed.run([], 'install'), 0);
    assert.equal(installed.applied(), true);
});

test('API digests bind actual index and tar bytes independently of index self-claims', async (t) => {
    const mutations = [
        [(_f, r) => { delete r.asset(MODULE_INDEX).digest; }, /ASSET_DIGEST_REQUIRED/],
        [(f, r) => f.bytes.set(r.base + MODULE_INDEX, Buffer.from('{}')), /ASSET_DIGEST_MISMATCH/],
        [(_f, r) => { delete r.asset().digest; }, /ASSET_DIGEST_REQUIRED/],
        [(f, r) => f.bytes.set(r.base + r.name, Buffer.from('corrupt')), /ASSET_DIGEST_MISMATCH/],
        [(_f, r) => { r.index.modules[0].sha256 = '0'.repeat(64); r.seal(); }, /INDEX_DIGEST_MISMATCH/],
        [(_f, r) => { r.index.modules[0].bytes += 1; r.seal(); }, /INDEX_SIZE_MISMATCH/],
    ];
    for (const [mutate, error] of mutations) {
        const f = fixture(t); const r = f.add('1.0.47'); mutate(f, r);
        await assert.rejects(f.run(), error);
        assert.equal(f.nativeCalls().length, 0);
        assert.equal(f.applied(), false);
    }
});

test('foreign repositories, tags, URLs and duplicate assets are rejected before binary use', async (t) => {
    const mutations = [
        [r => { r.release.url = r.release.url.replace(MODULE_REPOSITORY, 'foreign/repo'); }, /RELEASE_IDENTITY_INVALID/],
        [r => { r.release.html_url = r.release.html_url.replace(MODULE_REPOSITORY, 'foreign/repo'); }, /RELEASE_IDENTITY_INVALID/],
        [r => { r.release.tag_name = 'different-tag'; }, /RELEASE_IDENTITY_INVALID/],
        [r => { r.asset(MODULE_INDEX).browser_download_url = 'https://foreign.invalid/index'; }, /ASSET_INVALID/],
        [r => { r.asset().browser_download_url = r.asset().browser_download_url.replace(MODULE_REPOSITORY, 'foreign/repo'); }, /ASSET_INVALID/],
        [r => { r.asset().browser_download_url += '?redirect=other'; }, /ASSET_INVALID/],
        [r => r.release.assets.push(r.asset(MODULE_INDEX)), /ASSET_INVALID/],
        [r => r.release.assets.push(r.asset()), /ASSET_INVALID/],
    ];
    for (const [mutate, error] of mutations) {
        const f = fixture(t); const r = f.add('1.0.47'); mutate(r);
        await assert.rejects(f.run(), error);
        assert.equal(f.nativeCalls().length, 0);
        assert.equal(f.calls.some((url) => /foreign|redirect=/.test(url)), false);
    }
});

test('archive metadata, file inventory and same-version immutable identities are enforced', async (t) => {
    for (const mutate of [
        files => files.set('server/app/modules/peanut/file/module.json', encode({ key: 'peanut.other', version: '1.0.47' })),
        files => files.set('server/app/modules/peanut/file/module.json', encode({ key: 'peanut.file', version: '1.0.46' })),
        files => files.set('META-INF/files.sha256', Buffer.from('invalid\n')),
        files => files.set('undeclared', Buffer.from('extra')),
    ]) {
        const f = fixture(t); f.add('1.0.47', {}, mutate);
        await assert.rejects(f.run(), /ARCHIVE_(IDENTITY|INVENTORY)_INVALID/);
        assert.equal(f.nativeCalls().length, 0);
    }
    const f = fixture(t); f.add('1.0.47');
    const other = f.add('1.0.47'); other.index.modules[0].sha256 = 'f'.repeat(64); other.seal();
    await assert.rejects(f.run(), /VERSION_IDENTITY_CONFLICT/);
    assert.equal(f.applied(), false);
});

test('malformed index schema, protocol, commit, key, version and asset cannot become candidates', async (t) => {
    for (const mutate of [
        index => { index.schema_version = 2; }, index => { index.protocol = 'other'; },
        index => { index.commit = 'HEAD'; }, index => { index.modules = []; },
        index => { index.repository = 'foreign/repo'; }, index => { index.tag = 'different-tag'; },
        index => { index.modules = { 'peanut.file': index.modules[0] }; },
        index => { index.modules.push({ ...index.modules[0] }); },
        index => { index.modules.push({ ...index.modules[0], key: 'foreign.file' }); },
        index => { index.modules[0].version = '^1.0.47'; },
        index => { index.modules[0].asset = '../module.tar'; },
        index => { index.modules[0].bytes = 0; }, index => { index.modules[0].editions = ['enterprise']; },
        index => { index.modules[0].dependencies = [null]; },
        index => { index.modules[0].dependencies = [{ module_key: 'peanut.identity', version: 4 }]; },
    ]) {
        const f = fixture(t); const r = f.add('1.0.47'); mutate(r.index); r.seal();
        await assert.rejects(f.run(), /RELEASE_INDEX_INVALID|SEMVER_INVALID/);
        assert.equal(f.nativeCalls().length, 0);
    }
});

test('index metadata must match the downloaded manifest and composer Edition declaration', async (t) => {
    for (const mutate of [
        row => { row.license = 'MIT'; },
        row => { row.kernel_constraint = '^2.0'; },
        row => { row.dependencies = [{ module_key: 'peanut.identity', version: '^4.0.0-rc.32' }]; },
        row => { row.editions = ['standalone']; },
    ]) {
        const f = fixture(t); const r = f.add('1.0.47'); mutate(r.index.modules[0]); r.seal();
        await assert.rejects(f.run(), /RELEASE_INDEX_INVALID|ARCHIVE_METADATA_INVALID/);
        assert.equal(f.nativeCalls().length, 0);
    }
});

test('an archive reused under a different version is rejected even with matching API and index SHA', async (t) => {
    const f = fixture(t); const original = f.add('1.0.47'); const successor = f.add('1.0.48');
    successor.index.modules[0].sha256 = sha256(original.tar);
    successor.index.modules[0].bytes = original.tar.length;
    successor.seal();
    f.bytes.set(successor.base + successor.name, original.tar);
    successor.asset().digest = 'sha256:' + sha256(original.tar);
    await assert.rejects(f.run(), /ARCHIVE_IDENTITY_INVALID/);
    assert.equal(f.nativeCalls().length, 0);
});

test('immutable version SHA conflicts are rejected across channels before candidate filtering', async (t) => {
    for (const prereleaseFirst of [false, true]) {
        for (const args of [[], ['--version', '1.0.47'], ['--channel', 'prerelease']]) {
            const f = fixture(t);
            f.add('1.0.47', { prerelease: prereleaseFirst });
            const conflict = f.add('1.0.47', { prerelease: !prereleaseFirst });
            conflict.index.modules[0].sha256 = 'f'.repeat(64); conflict.seal();
            await assert.rejects(f.run(args), /VERSION_IDENTITY_CONFLICT/);
            assert.equal(f.calls.filter((url) => url.endsWith('.tar')).length, 0);
            assert.equal(f.nativeCalls().length, 0);
        }
    }
    const f = fixture(t);
    f.add('1.0.47', { prerelease: true }); const stable = f.add('1.0.47', { prerelease: false });
    assert.equal(await f.run(['--dry-run']), 0);
    assert.equal(f.calls.filter((url) => url.endsWith('.tar')).length, 1);
    assert.ok(f.calls.includes(stable.base + stable.name));
});

test('preflight result is bound to the selected key/version/SHA and must be a native update plan', async (t) => {
    for (const response of [{ package_key: 'peanut.other' }, { dry_run: false }, { operation: 'install' },
        { target: { version: '1.0.46', archive_sha256: '0'.repeat(64) } }]) {
        const f = fixture(t, { response }); f.add('1.0.47');
        await assert.rejects(f.run(), /PREFLIGHT_IDENTITY_INVALID/);
        assert.equal(f.applied(), false);
    }
});

test('native install preflight rejects falsified install plan identity before product writes', async (t) => {
    for (const response of [{ operation: 'update' }, { package_key: 'peanut.other' },
        { source: { version: '9.0.0' } }, { target: { version: '1.0.47',
            archive_sha256: '0'.repeat(64), modules: ['peanut.other'] } }]) {
        const f = fixture(t, { installed: null, response }); f.add('1.0.47');
        await assert.rejects(f.run([], 'install'), /PREFLIGHT_IDENTITY_INVALID|DOWNGRADE_REJECTED/);
        assert.equal(f.nativeCalls().length, 1);
        assert.equal(f.applied(), false);
    }
});

test('install dry-run obtains a real native install plan without applying product state', async (t) => {
    const f = fixture(t, { installed: null }); f.add('1.0.47');
    assert.equal(await f.run(['--dry-run'], 'install'), 0);
    assert.equal(f.nativeCalls().length, 1);
    assert.equal(f.nativeCalls()[0].operation, 'install');
    assert.ok(f.nativeCalls()[0].arguments.includes('--dry-run'));
    assert.equal(f.calls.filter((url) => url.endsWith('.tar')).length, 1);
    assert.equal(f.applied(), false);
});

test('install admission errors stop and a missing installation is never an upgrade success', async (t) => {
    for (const code of ['MODULE_PACKAGE_UPDATE_FAILED', 'MODULE_MAINTENANCE_ACCESS_DENIED', 'PLUGIN_STATE_INVALID']) {
        const f = fixture(t, { installed: null, errors: { '1.0.47': code } });
        f.add('1.0.47');
        assert.equal(await f.run([], 'install'), 7);
        assert.deepEqual(f.nativeCalls().map((call) => call.operation), ['install']);
        assert.equal(f.applied(), false);
    }
    const f = fixture(t, { installed: null }); f.add('1.0.47');
    assert.equal(await f.run(), 7);
    assert.deepEqual(f.nativeCalls().map((call) => call.operation), ['upgrade']);
    assert.equal(f.applied(), false);
});

test('online native apply failure is returned without a second candidate or write retry', async (t) => {
    for (const operation of ['install', 'upgrade']) {
        const f = fixture(t, { installed: operation === 'install' ? null : '1.0.40' });
        f.add('1.0.46'); f.add('1.0.47');
        const stateFile = path.join(f.root, '.local/native-state.json');
        const state = JSON.parse(fs.readFileSync(stateFile));
        fs.writeFileSync(stateFile, encode({ ...state, exit: 9 }));
        assert.equal(await f.run([], operation), 9);
        assert.equal(f.nativeCalls().length, 2);
        assert.equal(f.nativeCalls()[1].operation, operation);
        assert.deepEqual(f.nativeCalls()[0].arguments, [...f.nativeCalls()[1].arguments, '--dry-run']);
        assert.equal(f.calls.filter((url) => url.endsWith('.tar')).length, 1);
    }
});

test('a failed cache refresh never invokes native commands using stale verified bytes', async (t) => {
    const f = fixture(t); const r = f.add('1.0.47');
    assert.equal(await f.run(['--dry-run']), 0);
    const cached = f.nativeCalls()[0].arguments[0];
    fs.writeFileSync(cached, 'tampered cache');
    f.bytes.set(r.base + r.name, Buffer.from('tampered download'));
    await assert.rejects(f.run(), /ASSET_DIGEST_MISMATCH/);
    assert.equal(f.nativeCalls().length, 1);
    assert.equal(f.applied(), false);
});

test('each invocation downloads and verifies bytes again instead of trusting the APP cache', async (t) => {
    const f = fixture(t); const r = f.add('1.0.47');
    assert.equal(await f.run(['--dry-run']), 0);
    const cached = f.nativeCalls()[0].arguments[0];
    fs.writeFileSync(cached, 'tampered cache');
    assert.equal(await f.run(['--dry-run']), 0);
    assert.deepEqual(fs.readFileSync(cached), r.tar);
    assert.equal(f.calls.filter((url) => url === r.base + r.name).length, 2);
    assert.equal(f.calls.filter((url) => url === r.base + MODULE_INDEX).length, 2);
});

test('repeated identical module versions across Releases download the chosen tar only once', async (t) => {
    const f = fixture(t); f.add('1.0.47'); f.add('1.0.47');
    assert.equal(await f.run(['--dry-run']), 0);
    assert.equal(f.calls.filter((url) => url.endsWith('.tar')).length, 1);
    assert.equal(f.nativeCalls().length, 1);
});

test('discovery paginates once and fails closed on an incomplete release list', async (t) => {
    const f = fixture(t); const r = f.add('1.0.47');
    const urls = [];
    const result = await moduleCandidates({ key: 'peanut.file', channel: 'stable' }, async (url) => {
        urls.push(url);
        if (url === `${api}?per_page=100&page=1`) return { ok: true, json: async () => Array.from({ length: 100 }, () => ({ draft: true })) };
        if (url === `${api}?per_page=100&page=2`) return { ok: true, json: async () => [r.release] };
        return f.fetcher(url);
    });
    assert.equal(result[0].version, '1.0.47');
    assert.equal(urls.length, 3);
    let pages = 0;
    await assert.rejects(moduleCandidates({ key: 'peanut.file', channel: 'stable' }, async () => {
        pages += 1; return { ok: true, json: async () => Array.from({ length: 100 }, () => ({ draft: true })) };
    }), /DISCOVERY_LIMIT/);
    assert.equal(pages, 20);
});

test('local tar syntax, root parsing, passthrough, other operations and native exit codes stay compatible', async (t) => {
    const f = fixture(t);
    const local = ['/absolute/module.tar', '--sha256', 'a'.repeat(64)];
    assert.deepEqual(parseModuleArguments(['upgrade', ...local, '--root', f.root]), { operation: 'upgrade', arguments: local, root: f.root });
    assert.deepEqual(parseModuleArguments(['check', '--root=' + f.root, '--', '--root', 'native']),
        { operation: 'check', arguments: ['--root', 'native'], root: f.root });
    for (const operation of ['upgrade', 'install', 'check', 'work']) {
        assert.equal(await runModule({ operation, root: f.root, arguments: local }, f.fetcher), 0);
        assert.deepEqual(f.nativeCalls().at(-1), { operation, arguments: local });
    }
    const relative = ['peanut.file-1.0.47.tar', '--sha256', 'a'.repeat(64)];
    assert.equal(await runModule({ operation: 'upgrade', root: f.root, arguments: relative }, f.fetcher), 0);
    assert.deepEqual(f.nativeCalls().at(-1).arguments, relative);
    fs.writeFileSync(path.join(f.root, '.local/native-state.json'), JSON.stringify({ exit: 9 }));
    const result = spawnSync(process.execPath, [cli, 'module', 'upgrade', ...local, '--root', f.root], { encoding: 'utf8' });
    assert.equal(result.status, 9);
    assert.equal(f.calls.length, 0);
    assert.throws(() => parseModuleArguments(['check', '--root']), /ROOT_REQUIRED/);
    assert.throws(() => parseModuleArguments(['check', '--root', f.root, '--root', f.root]), /ROOT_DUPLICATE/);
});

test('online argument mistakes fail before discovery; help explains online and local forms', async (t) => {
    const f = fixture(t);
    for (const args of [['--channel', 'nightly'], ['--channel'], ['--version', 'latest'], ['--version', '1.0.47', '--version', '1.0.48'],
        ['--dry-run=true'], ['--sha256', 'a'.repeat(64)]]) await assert.rejects(f.run(args));
    assert.equal(f.calls.length, 0);
    const help = spawnSync(process.execPath, [cli, 'help', 'module'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /peanut\.file/);
    assert.match(help.stdout, /--channel stable\|prerelease/);
    assert.match(help.stdout, /assets\[\]\.digest/);
    assert.match(help.stdout, /install.*dry-run/);
});
