import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fixture, archive } from './helpers/template-fixture.js';
import { createProject } from '../lib/create-project.js';
import { sha256 } from '../lib/protocol.js';
import { MODULE_PRESETS_PATH } from '../lib/module-selection.js';
import { MODULE_INDEX, MODULE_REPOSITORY } from '../lib/module-release.js';

const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
const bin = fileURLToPath(new URL('../bin/peanut.js', import.meta.url));

function selectionFixture(t, mutate = () => {}, native = false, edition = 'multi-tenant') {
    // Synthetic product membership; production membership is owned solely by Code.
    const composition = { schema_version: 1, protocol: 'peanut.application-module-composition.v1', version: '1.0.0',
        mandatory: ['peanut.identity'], default: ['peanut.file'], optional: ['peanut.task'] };
    mutate(composition);
    const f = fixture(t, ({ create, release, app, files, payload }) => {
        app.application.edition = edition;
        app.edition.name = edition;
        const bytes = encode(composition);
        payload.set(MODULE_PRESETS_PATH, bytes);
        const entry = { path: MODULE_PRESETS_PATH, source: `defaults/${MODULE_PRESETS_PATH}`, mode: 0o644,
            classification: 'app-owned', sha256: sha256(bytes), render: false };
        files.push(entry);
        const { source, render, ...recorded } = entry;
        app.files.push(recorded);
        if (native) {
            // Protocol stand-in only. Real Code admission/recovery is tested separately.
            const bridge = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const request = JSON.parse(fs.readFileSync(input.arguments[1], 'utf8'));
const index = JSON.parse(fs.readFileSync(request.index.path, 'utf8'));
const composition = JSON.parse(fs.readFileSync('server/config/module_composition.json', 'utf8'));
const roots = [...composition.mandatory, ...(request.preset === 'standard' ? composition.default : []), ...request.optional].sort();
const plan = { schema_version: 1, protocol: 'peanut.module-source-composition-plan.v1', status: 'ready', edition: request.edition,
  roots, composition: { sha256: request.composition_sha256, preset: request.preset },
  index: { repository: index.repository, tag: index.tag, commit: index.commit, sha256: request.index.sha256 },
  modules: index.modules.map(row => ({ key: row.key, version: row.version, installation: 'uninstalled' })),
  runtime_database_mutated: false, changed: fs.existsSync('changed') };
const hash = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const result = { plan, plan_sha256: hash, recovery: { status: 'clean' } };
if (input.arguments.includes('--plan-sha256')) {
  if (input.arguments.at(-1) !== hash) { console.log(JSON.stringify({ error: 'MODULE_COMPOSITION_PLAN_CHANGED', recovery: { status: 'clean' } })); process.exit(1); }
  if (fs.existsSync('fail-prepare')) {
    fs.mkdirSync('.local/module-source-adoption/tx', { recursive: true });
    fs.writeFileSync('.local/module-source-adoption/journal.json', 'preserve me');
    console.log(JSON.stringify({ error: 'MODULE_PACKAGE_RECOVERY_REQUIRED', recovery: { status: 'pending', transaction: 'fixed-tx', journal: '.local/module-source-adoption/journal.json', completed_writes: ['server/app/modules/peanut/file'], resume: { operation: 'adopt', arguments: ['--recover'] } } })); process.exit(1);
  }
  fs.writeFileSync('modules.lock', JSON.stringify({ schema_version: 1, modules: index.modules }));
  result.status = 'source-prepared';
  result.completed_writes = ['modules.lock'];
  result.recovery = { status: 'recovered', transaction: 'fixed-tx', receipt: '.local/module-source-adoption/fixed-tx/transaction.json' };
}
if (fs.existsSync('wrong-identity')) result.plan.index.commit = 'e'.repeat(40);
console.log(JSON.stringify(result));
`;
            for (const [name, bytes] of [
                ['server/module', Buffer.from(bridge)], ['server/vendor/autoload.php', Buffer.from('<?php')],
                ['server/vendor/topthink/framework/src/helper.php', Buffer.from('<?php')],
            ]) {
                const item = { path: name, source: 'files/' + name, mode: 0o644, classification: 'managed', sha256: sha256(bytes), render: false };
                payload.set(name, bytes); files.push(item);
                release.files.push({ ...item, template_sha256: item.sha256 });
                const { source, render, ...record } = item;
                app.files.push(record);
            }
        }
        create.scaffold_manifest_sha256 = sha256(encode(release));
    });
    const tag = 'modules-1.0.0-rc.1';
    const index = { schema_version: 1, protocol: 'peanut.module-release-index.v1', repository: MODULE_REPOSITORY,
        tag, commit: 'a'.repeat(40), modules: ['identity', 'file', 'task'].map((name) => ({
            key: `peanut.${name}`, version: '1.0.0-rc.1', asset: `peanut.${name}-1.0.0-rc.1.tar`,
            sha256: (name === 'identity' ? 'b' : name === 'file' ? 'c' : 'd').repeat(64), bytes: 1234,
            license: 'Apache-2.0', editions: ['multi-tenant', 'standalone'], kernel_constraint: '^5.0',
            dependencies: name === 'identity' ? [{ module_key: 'peanut.file', version: '^1.0.0-rc.1' }] : [],
        })) };
    const release = { id: 7, url: `https://api.github.com/repos/${MODULE_REPOSITORY}/releases/7`,
        html_url: `https://github.com/${MODULE_REPOSITORY}/releases/tag/${tag}`, tag_name: tag,
        draft: false, immutable: true, published_at: '2026-11-11T00:00:00Z', prerelease: true, assets: [] };
    const indexPath = path.join(f.root, MODULE_INDEX);
    const tarBytes = new Map();
    for (const row of index.modules) {
        const base = `server/app/modules/peanut/${row.key.slice(7)}`;
        const contents = new Map([[base + '/module.json', encode({ key: row.key, version: row.version,
            license: row.license, kernel_constraint: row.kernel_constraint, dependencies: row.dependencies })],
        [base + '/composer.json', encode({ extra: { peanut: { editions: row.editions } } })]]);
        const inventory = [...contents].sort(([a], [b]) => a < b ? -1 : 1).map(([name, bytes]) => `${name}\0${sha256(bytes)}\n`).join('');
        contents.set('META-INF/files.sha256', Buffer.from(inventory));
        const tar = gunzipSync(archive([...contents]));
        row.sha256 = sha256(tar); row.bytes = tar.length;
        fs.writeFileSync(path.join(f.root, row.asset), tar);
        tarBytes.set(row.asset, tar);
    }
    function seal() {
        const bytes = encode(index);
        fs.writeFileSync(indexPath, bytes);
        release.assets = [{ name: MODULE_INDEX,
            browser_download_url: `https://github.com/${MODULE_REPOSITORY}/releases/download/${tag}/${MODULE_INDEX}`,
            digest: 'sha256:' + sha256(bytes) }, ...index.modules.map((row) => ({ name: row.asset,
                browser_download_url: `https://github.com/${MODULE_REPOSITORY}/releases/download/${tag}/${row.asset}`,
                digest: 'sha256:' + sha256(tarBytes.get(row.asset)) }))];
        return sha256(bytes);
    }
    const indexSha = seal();
    const calls = [];
    const fetcher = async (url) => {
        calls.push(url);
        if (url === `https://api.github.com/repos/${MODULE_REPOSITORY}/releases/tags/${tag}`) return { ok: true, json: async () => release };
        const asset = release.assets.find((item) => item.browser_download_url === url);
        assert.ok(asset, url);
        return { ok: true, arrayBuffer: async () => asset.name === MODULE_INDEX ? fs.readFileSync(indexPath) : tarBytes.get(asset.name) };
    };
    const options = { ...f.options, plan: true, moduleRelease: tag, moduleChannel: 'prerelease', ...(native ? { modulePhp: process.execPath } : {}) };
    const offline = { ...options, moduleIndex: indexPath, moduleIndexSha256: indexSha };
    const noNetwork = () => { throw new Error('offline planning must not access network'); };
    return { ...f, options, offline, index, release, calls, fetcher, composition, seal, noNetwork };
}

test('MT standard selection uses only template membership and preserves exact online/offline index identity', async (t) => {
    const f = selectionFixture(t);
    const online = await createProject(f.options, f.fetcher);
    const offline = await createProject(f.offline, f.noNetwork);
    assert.equal(online.status, 'blocked');
    assert.deepEqual(online.roots, ['peanut.file', 'peanut.identity']);
    assert.deepEqual(online.selected, offline.selected);
    assert.deepEqual(online.catalog, offline.catalog);
    assert.equal(online.source.index_sha256, f.offline.moduleIndexSha256);
    assert.equal(online.source.index_sha256, offline.source.index_sha256);
    assert.equal(online.source.provenance, 'github-release-api-digest');
    assert.equal(offline.source.provenance, 'digest-pinned-local');
    assert.equal(online.preset.sha256, sha256(encode(f.composition)));
    assert.equal(f.calls.length, 5);
    assert.equal(online.dependency_resolution, 'not-run');
    assert.deepEqual(online.blockers.map((row) => row.code), ['CODE_NATIVE_DEPENDENCIES_REQUIRED']);
    assert.deepEqual(online.blockers[0].missing, ['server/module', 'server/vendor/autoload.php', 'server/vendor/topthink/framework/src/helper.php']);
    assert.equal(sha256(fs.readFileSync(path.join(online.composition_stage, MODULE_INDEX))), online.source.index_sha256);
    assert.equal(fs.existsSync(path.join(online.staged_application, '.local')), false);
    assert.equal(online.target_mutated, false);
    assert.equal(online.database_mutated, false);
    assert.equal(fs.existsSync(f.options.target), false);
});

test('standalone official Module composition plans the same source graph without changing database or target', async (t) => {
    const f = selectionFixture(t, () => {}, true, 'standalone');
    const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /ST\/MT create --plan/);
    const planned = await createProject(f.offline, f.noNetwork);
    assert.equal(planned.status, 'ready', JSON.stringify(planned));
    assert.equal(planned.edition, 'standalone');
    assert.equal(planned.composition_request.edition, 'standalone');
    assert.equal(planned.native.plan.edition, 'standalone');
    assert.deepEqual(planned.roots, ['peanut.file', 'peanut.identity']);
    assert.match(fs.readFileSync(path.join(planned.staged_application, 'server/.env'), 'utf8'),
        /DEPLOYMENT_MODE=standalone/);
    assert.equal(planned.database_mutated, false);
    assert.equal(planned.installation, 'not-run');
    assert.equal(fs.existsSync(f.options.target), false);
    const approved = { ...f.offline, plan: false,
        compositionStage: planned.composition_stage, planSha256: planned.plan_sha256 };
    const created = await createProject(approved, f.noNetwork);
    assert.equal(created.status, 'source-created', JSON.stringify(created));
    assert.equal(created.native.plan.edition, 'standalone');
    assert.equal(created.recovery.transaction, 'fixed-tx');
    assert.equal(created.database_mutated, false);
    assert.equal(created.installation, 'not-run');
    assert.equal(fs.existsSync(path.join(f.options.target, 'modules.lock')), true);
});

test('standalone refuses a Module catalog that only supports multi-tenant before native source adoption', async (t) => {
    const f = selectionFixture(t, () => {}, false, 'standalone');
    const row = f.index.modules.find((item) => item.key === 'peanut.identity');
    row.editions = ['multi-tenant'];
    const reviewed = f.seal();
    const selection = await createProject({ ...f.offline, moduleIndexSha256: reviewed }, f.noNetwork);
    assert.equal(selection.status, 'blocked');
    assert.deepEqual(selection.blockers.map((item) => item.code), ['MODULE_EDITION_UNSUPPORTED']);
    assert.equal(selection.target_mutated, false);
    assert.equal(selection.database_mutated, false);
    assert.equal(fs.existsSync(f.options.target), false);
});

test('minimal and optional selection do not impersonate a dependency closure', async (t) => {
    const f = selectionFixture(t);
    const plan = await createProject({ ...f.offline, modulePreset: 'minimal', modules: 'peanut.task' }, f.noNetwork);
    assert.deepEqual(plan.roots, ['peanut.identity', 'peanut.task']);
    assert.deepEqual(plan.selected[0].dependencies, f.index.modules[0].dependencies);
    assert.equal(plan.catalog.some((row) => row.key === 'peanut.file'), true);
    assert.equal(plan.selected.some((row) => row.key === 'peanut.file'), false);
    assert.equal(plan.source_adoption, 'not-run');
    assert.equal(plan.installation, 'not-run');
    for (const modules of ['peanut.unknown', 'peanut.task,peanut.task', 'peanut.identity', '']) {
        await assert.rejects(createProject({ ...f.offline, modules }, f.noNetwork), /OPTIONAL_SELECTION_INVALID/);
    }
});

test('current S3 manifest without optional classification remains explicitly blocked', async (t) => {
    const f = selectionFixture(t, (composition) => { delete composition.optional; });
    const plan = await createProject(f.offline, f.noNetwork);
    assert.equal(plan.preset.modules.optional, null);
    assert.equal(plan.blockers.some((row) => row.code === 'CODE_OPTIONAL_MODULE_CLASSIFICATION_REQUIRED'), true);
    await assert.rejects(createProject({ ...f.offline, modules: 'peanut.task' }, f.noNetwork), /OPTIONAL_SELECTION_INVALID/);
});

test('selection reports missing and wrong-Edition roots before any source adoption', async (t) => {
    const f = selectionFixture(t);
    f.index.modules = f.index.modules.filter((row) => row.key !== 'peanut.identity');
    f.index.modules[0].editions = ['standalone'];
    const pin = f.seal();
    const plan = await createProject({ ...f.offline, moduleIndexSha256: pin }, f.noNetwork);
    assert.deepEqual(plan.selected, []);
    assert.deepEqual(plan.blockers.map((row) => row.code), [
        'MODULE_EDITION_UNSUPPORTED', 'MODULE_NOT_IN_SNAPSHOT',
    ]);
    assert.equal(fs.existsSync(f.options.target), false);
});

test('offline planning rejects digest changes, unpinned indexes and unverified stable Release channel', async (t) => {
    const f = selectionFixture(t);
    await assert.rejects(createProject({ ...f.offline, moduleIndexSha256: 'f'.repeat(64) }, f.noNetwork), /INDEX_DIGEST_MISMATCH/);
    await assert.rejects(createProject({ ...f.offline, moduleIndexSha256: undefined }, f.noNetwork), /OFFLINE_SOURCE_INVALID/);
    await assert.rejects(createProject({ ...f.offline, moduleChannel: 'stable' }, f.noNetwork), /OFFLINE_RELEASE_CHANNEL_UNVERIFIED/);
    await assert.rejects(createProject({ ...f.offline, moduleRelease: 'other-tag' }, f.noNetwork), /RELEASE_INDEX_INVALID/);
});

test('online planning requires independent API digest, published exact Release and RC opt-in', async (t) => {
    const f = selectionFixture(t);
    await assert.rejects(createProject({ ...f.options, moduleChannel: 'stable' }, f.fetcher), /PRERELEASE_OPT_IN_REQUIRED/);
    f.release.assets[0].digest = 'sha256:' + 'f'.repeat(64);
    await assert.rejects(createProject(f.options, f.fetcher), /ASSET_DIGEST_MISMATCH/);
    delete f.release.assets[0].digest;
    await assert.rejects(createProject(f.options, f.fetcher), /ASSET_DIGEST_REQUIRED/);
    f.seal();
    f.release.draft = true;
    await assert.rejects(createProject(f.options, f.fetcher), /RELEASE_NOT_PUBLISHED/);
    f.release.draft = false;
    f.release.immutable = false;
    await assert.rejects(createProject(f.options, f.fetcher), /IMMUTABLE_RELEASE_REQUIRED/);
    f.release.immutable = true;
    f.release.tag_name = 'other-tag';
    await assert.rejects(createProject(f.options, f.fetcher), /RELEASE_IDENTITY_INVALID/);
});

test('manifest and explicit composition requests cannot bypass the planning boundary', async (t) => {
    const f = selectionFixture(t);
    await assert.rejects(createProject({ ...f.options, plan: false }, f.noNetwork), /COMPOSITION_REVIEW_REQUIRED/);
    const old = fixture(t, ({ app, create, release }) => {
        app.application.edition = 'multi-tenant'; app.edition.name = 'multi-tenant';
        create.scaffold_manifest_sha256 = sha256(encode(release));
    });
    await assert.rejects(createProject({ ...old.options, plan: true }, f.noNetwork), /PRESETS_REQUIRED/);
    const duplicate = selectionFixture(t, (composition) => { composition.default = [...composition.mandatory]; });
    await assert.rejects(createProject(duplicate.offline, duplicate.noNetwork), /PRESETS_INVALID/);
    fs.mkdirSync(f.options.target);
    fs.writeFileSync(path.join(f.options.target, '.keep'), 'WIP');
    await assert.rejects(createProject(f.offline, f.noNetwork), /TARGET_NOT_EMPTY/);
    assert.equal(fs.readFileSync(path.join(f.options.target, '.keep'), 'utf8'), 'WIP');
});

test('CLI create --plan returns a blocked MT JSON selection and exit 1 with no target writes', (t) => {
    const f = selectionFixture(t);
    const args = Object.entries(f.offline).flatMap(([key, value]) => {
        if (key === 'target') return [];
        if (key === 'plan') return ['--plan'];
        const flag = '--' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
        return [flag, value];
    });
    const child = spawnSync(process.execPath, [bin, 'create', f.options.target, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'blocked');
    assert.equal(result.source.index_sha256, f.offline.moduleIndexSha256);
    assert.equal(fs.existsSync(f.options.target), false);
    for (const flag of ['--plan=false', '--plan']) {
        const invalid = spawnSync(process.execPath, [bin, 'create', f.options.target, '--plan', flag], { encoding: 'utf8', timeout: 10000 });
        assert.equal(invalid.status, 2);
        assert.match(invalid.stderr, /ARGUMENTS_INVALID/);
    }
});

test('native plan identity is bound to exact index bytes and staging leaves target/source/lock untouched', async (t) => {
    const f = selectionFixture(t, () => {}, true);
    const result = await createProject({ ...f.offline, modulePreset: 'minimal' }, f.noNetwork);
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.dependency_resolution, 'code-native');
    assert.equal(result.source_adoption, 'not-run');
    assert.equal(result.database_mutated, false);
    assert.equal(fs.existsSync(f.options.target), false);
    for (const name of ['.local', 'modules.lock', 'server/app/modules']) assert.equal(fs.existsSync(path.join(result.staged_application, name)), false);
    assert.equal(fs.statSync(path.join(result.staged_application, 'server/.env')).mode & 0o777, 0o600);
    assert.deepEqual(result.roots, ['peanut.identity']);
    const request = result.composition_request;
    assert.equal(request.protocol, 'peanut.module-source-composition-request.v1');
    assert.equal(request.index.sha256, f.offline.moduleIndexSha256);
    assert.equal(request.composition_sha256, sha256(encode(f.composition)));
    assert.deepEqual(Object.keys(request.archives), ['peanut.file', 'peanut.identity', 'peanut.task']);
    assert.equal(fs.readFileSync(request.index.path).equals(fs.readFileSync(f.offline.moduleIndex)), true);
});

test('reviewed native hash prepares same consumer before target promotion; application identity cannot change', async (t) => {
    const f = selectionFixture(t, () => {}, true);
    const plan = await createProject(f.offline, f.noNetwork);
    const apply = { ...f.offline, plan: false, compositionStage: plan.composition_stage, planSha256: plan.plan_sha256 };
    await assert.rejects(createProject({ ...apply, slug: 'other' }, f.noNetwork), /STAGE_IDENTITY_MISMATCH/);
    const unknownHash = await createProject({ ...apply, planSha256: 'f'.repeat(64) }, f.noNetwork);
    assert.equal(unknownHash.status, 'blocked');
    assert.match(unknownHash.blockers[0].code, /REVIEWED_PLAN_REQUIRED/);
    assert.equal(fs.existsSync(f.options.target), false);
    const created = await createProject(apply, f.noNetwork);
    assert.equal(created.status, 'source-created', JSON.stringify(created));
    assert.equal(created.native.status, 'source-prepared');
    assert.equal(created.recovery.transaction, 'fixed-tx');
    assert.equal(created.installation, 'not-run');
    assert.equal(created.database_mutated, false);
    assert.equal(fs.existsSync(path.join(f.options.target, 'modules.lock')), true);
    assert.equal(fs.existsSync(plan.staged_application), false);
});

test('native rejects changed plan and CLI preserves stage plus partial-write recovery identity on errors', async (t) => {
    const f = selectionFixture(t, () => {}, true);
    const plan = await createProject(f.offline, f.noNetwork);
    const apply = { ...f.offline, plan: false, compositionStage: plan.composition_stage, planSha256: plan.plan_sha256 };
    fs.writeFileSync(path.join(plan.staged_application, 'changed'), 'changed');
    const changed = await createProject(apply, f.noNetwork);
    assert.equal(changed.blockers[0].code, 'MODULE_COMPOSITION_PLAN_CHANGED');
    assert.equal(changed.native_process.exit_code, 1);
    assert.equal(fs.existsSync(f.options.target), false);
    fs.unlinkSync(path.join(plan.staged_application, 'changed'));
    fs.writeFileSync(path.join(plan.staged_application, 'fail-prepare'), 'fail');
    const failed = await createProject(apply, f.noNetwork);
    assert.equal(failed.blockers[0].code, 'MODULE_PACKAGE_RECOVERY_REQUIRED');
    assert.equal(failed.recovery.transaction, 'fixed-tx');
    assert.deepEqual(failed.recovery.resume, { operation: 'adopt', arguments: ['--recover'] });
    assert.equal(fs.readFileSync(path.join(failed.staged_application, failed.recovery.journal), 'utf8'), 'preserve me');
    assert.equal(fs.existsSync(f.options.target), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(failed.composition_stage, 'native-result.json'))).native.recovery.transaction, 'fixed-tx');
});

test('candidate tampering and native response identity never expose a target', async (t) => {
    const f = selectionFixture(t, () => {}, true);
    const plan = await createProject(f.offline, f.noNetwork);
    const resume = { ...f.offline, compositionStage: plan.composition_stage };
    fs.writeFileSync(path.join(plan.staged_application, 'wrong-identity'), 'bad');
    const wrong = await createProject(resume, f.noNetwork);
    assert.equal(wrong.blockers[0].code, 'CODE_NATIVE_PLAN_IDENTITY_INVALID');
    fs.appendFileSync(Object.values(plan.composition_request.archives)[0], 'corrupt');
    const corrupt = await createProject(resume, f.noNetwork);
    assert.match(corrupt.blockers[0].code, /ARCHIVE_DIGEST_MISMATCH/);
    assert.equal(fs.existsSync(f.options.target), false);
    const second = selectionFixture(t);
    fs.appendFileSync(path.join(second.root, second.index.modules[0].asset), 'corrupt');
    const badOffline = await createProject(second.offline, second.noNetwork);
    assert.match(badOffline.blockers[0].code, /ARCHIVE_DIGEST_MISMATCH/);
});

test('stable rejects a transitive RC reported by native closure without preparing sources', async (t) => {
    const f = selectionFixture(t, () => {}, true);
    // Keep the template roots stable in the fixed index; the native closure contains a dependency RC.
    f.index.modules.filter((row) => ['peanut.identity', 'peanut.file'].includes(row.key)).forEach((row) => {
        const original = row.version;
        row.version = '1.0.0';
        row.asset = `${row.key}-${row.version}.tar`;
        const base = `server/app/modules/peanut/${row.key.slice(7)}`;
        const contents = new Map([[base + '/module.json', encode({ key: row.key, version: row.version,
            license: row.license, kernel_constraint: row.kernel_constraint, dependencies: row.dependencies })],
        [base + '/composer.json', encode({ extra: { peanut: { editions: row.editions } } })]]);
        contents.set('META-INF/files.sha256', Buffer.from([...contents].sort(([a], [b]) => a < b ? -1 : 1)
            .map(([name, bytes]) => `${name}\0${sha256(bytes)}\n`).join('')));
        const bytes = gunzipSync(archive([...contents]));
        row.bytes = bytes.length; row.sha256 = sha256(bytes);
        fs.writeFileSync(path.join(f.root, row.asset), bytes);
        const asset = f.release.assets.find((item) => item.name === `${row.key}-${original}.tar`);
        asset.name = row.asset;
        asset.browser_download_url = asset.browser_download_url.slice(0, asset.browser_download_url.lastIndexOf('/') + 1) + row.asset;
        asset.digest = 'sha256:' + sha256(bytes);
    });
    f.release.prerelease = false;
    const indexBytes = encode(f.index);
    fs.writeFileSync(f.offline.moduleIndex, indexBytes);
    f.release.assets[0].digest = 'sha256:' + sha256(indexBytes);
    const fetcher = async (url) => {
        if (url.startsWith('https://api.github.com/')) return { ok: true, json: async () => f.release };
        const asset = f.release.assets.find((row) => row.browser_download_url === url);
        return { ok: true, arrayBuffer: async () => fs.readFileSync(path.join(f.root, asset.name)) };
    };
    const result = await createProject({ ...f.options, moduleChannel: 'stable' }, fetcher);
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(result.blockers[0].code, 'PRERELEASE_OPT_IN_REQUIRED');
    assert.equal(result.native.plan.status, 'ready');
    assert.equal(fs.existsSync(f.options.target), false);
    assert.equal(fs.existsSync(path.join(result.staged_application, 'modules.lock')), false);
});
