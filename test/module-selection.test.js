import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/template-fixture.js';
import { createProject } from '../lib/create-project.js';
import { sha256 } from '../lib/protocol.js';
import { MODULE_PRESETS_PATH } from '../lib/module-selection.js';
import { MODULE_INDEX, MODULE_REPOSITORY } from '../lib/module-release.js';

const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
const bin = fileURLToPath(new URL('../bin/peanut.js', import.meta.url));

function selectionFixture(t, mutate = () => {}) {
    // Synthetic product membership; production membership is owned solely by Code.
    const composition = { schema_version: 1, protocol: 'peanut.application-module-composition.v1', version: '1.0.0',
        mandatory: ['peanut.identity'], default: ['peanut.file'], optional: ['peanut.task'] };
    mutate(composition);
    const f = fixture(t, ({ create, release, app, files, payload }) => {
        app.application.edition = 'multi-tenant';
        app.edition.name = 'multi-tenant';
        const bytes = encode(composition);
        payload.set(MODULE_PRESETS_PATH, bytes);
        const entry = { path: MODULE_PRESETS_PATH, source: `defaults/${MODULE_PRESETS_PATH}`, mode: 0o644,
            classification: 'app-owned', sha256: sha256(bytes), render: false };
        files.push(entry);
        const { source, render, ...recorded } = entry;
        app.files.push(recorded);
        create.scaffold_manifest_sha256 = sha256(encode(release));
    });
    const tag = 'modules-1.0.0-rc.1';
    const index = { schema_version: 1, protocol: 'peanut.module-release-index.v1', repository: MODULE_REPOSITORY,
        tag, commit: 'a'.repeat(40), modules: ['identity', 'file', 'task'].map((name) => ({
            key: `peanut.${name}`, version: '1.0.0-rc.1', asset: `peanut.${name}-1.0.0-rc.1.tar`,
            sha256: (name === 'identity' ? 'b' : name === 'file' ? 'c' : 'd').repeat(64), bytes: 1234,
            license: 'Apache-2.0', editions: ['multi-tenant'], kernel_constraint: '^5.0',
            dependencies: name === 'identity' ? [{ module_key: 'peanut.file', version: '^1.0.0-rc.1' }] : [],
        })) };
    const release = { id: 7, url: `https://api.github.com/repos/${MODULE_REPOSITORY}/releases/7`,
        html_url: `https://github.com/${MODULE_REPOSITORY}/releases/tag/${tag}`, tag_name: tag,
        draft: false, published_at: '2026-11-11T00:00:00Z', prerelease: true, assets: [] };
    const indexPath = path.join(f.root, MODULE_INDEX);
    function seal() {
        const bytes = encode(index);
        fs.writeFileSync(indexPath, bytes);
        release.assets = [{ name: MODULE_INDEX,
            browser_download_url: `https://github.com/${MODULE_REPOSITORY}/releases/download/${tag}/${MODULE_INDEX}`,
            digest: 'sha256:' + sha256(bytes) }];
        return sha256(bytes);
    }
    const indexSha = seal();
    const calls = [];
    const fetcher = async (url) => {
        calls.push(url);
        if (url === `https://api.github.com/repos/${MODULE_REPOSITORY}/releases/tags/${tag}`) return { ok: true, json: async () => release };
        assert.equal(url, release.assets[0].browser_download_url);
        return { ok: true, arrayBuffer: async () => fs.readFileSync(indexPath) };
    };
    const options = { ...f.options, plan: true, moduleRelease: tag, moduleChannel: 'prerelease' };
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
    assert.equal(f.calls.length, 2);
    assert.equal(online.dependency_resolution, 'not-run');
    assert.deepEqual(online.blockers.map((row) => row.code), ['CODE_NATIVE_COMPOSITION_PLAN_REQUIRED']);
    assert.equal(online.target_mutated, false);
    assert.equal(online.database_mutated, false);
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
        'MODULE_EDITION_UNSUPPORTED', 'MODULE_NOT_IN_SNAPSHOT', 'CODE_NATIVE_COMPOSITION_PLAN_REQUIRED',
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
    f.release.tag_name = 'other-tag';
    await assert.rejects(createProject(f.options, f.fetcher), /RELEASE_IDENTITY_INVALID/);
});

test('manifest and explicit composition requests cannot bypass the planning boundary', async (t) => {
    const f = selectionFixture(t);
    await assert.rejects(createProject({ ...f.options, plan: false }, f.noNetwork), /COMPOSITION_PLAN_ONLY/);
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
