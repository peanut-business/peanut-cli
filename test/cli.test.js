import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RecipeManager } from '../lib/recipe-manager.js';
import { resolveWorkingRoot, sha256File } from '../lib/protocol.js';
import { createProject } from '../lib/create-project.js';
import { configureProject } from '../lib/configure.js';
import { inspectCoreStatus, parseCoreArguments } from '../lib/core-dev.js';
import { officialFixture } from './helpers/template-fixture.js';
import { validateTemplatePackage } from '../lib/template-package.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/peanut.js');

test('official create binds both Editions to the selected release without re-resolving latest', async (t) => {
    for (const edition of ['standalone', 'multi-tenant']) {
        const f = officialFixture(t, { edition });
        const result = await createProject(f.options, f.fetcher);
        assert.equal(result.status, 'created');
        assert.equal(result.application.edition, edition);
        assert.equal(result.source.commit, f.lock.candidate.commit);
        assert.equal(result.source.tree, f.lock.candidate.tree);
        assert.equal(result.source.inventory_sha256, f.lock.inputs.application_template_inventory_sha256);
        assert.equal(f.calls.filter((url) => url.includes('/releases/latest')).length, 1);
        assert.equal(f.calls.filter((url) => url.includes('/releases/tags/')).length, 0);
        assert.equal(f.calls.length, 5);
    }
});

test('official create keeps explicit refs exact and prerelease discovery bound once', async (t) => {
    for (const ref of [undefined, 'v5.0.2-rc.1']) {
        const f = officialFixture(t, { version: '5.0.2-rc.1' });
        await createProject({ ...f.options, channel: 'prerelease', ...(ref ? { ref } : {}) }, f.fetcher);
        const discovery = f.calls.filter((url) => url.startsWith('https://api.github.com/'));
        assert.equal(discovery.length, 1);
        assert.match(discovery[0], ref ? /\/tags\/v5\.0\.2-rc\.1$/ : /\?per_page=100&page=1$/);
    }
    const f = officialFixture(t);
    const calls = [];
    await assert.rejects(createProject({ ...f.options, ref: 'v5.0.1' }, async (url) => {
        calls.push(url); return { ok: true, json: async () => f.release };
    }), /PEANUT_CREATE_RELEASE_IDENTITY_INVALID/);
    assert.match(calls[0], /\/tags\/v5\.0\.1$/);
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(f.options.target), false);
});

test('official create rejects missing or inconsistent release bindings before materialization', async (t) => {
    const mutations = {
        'missing lock asset': [f => { f.release.assets = f.release.assets.filter(a => a.name !== 'RELEASE_CANDIDATE_LOCK.json'); }, /PEANUT_RELEASE_ASSET_INVALID/],
        'duplicate manifest asset': [f => f.release.assets.push(f.release.assets.find(a => a.name === 'RELEASE_MANIFEST.json')), /PEANUT_RELEASE_ASSET_INVALID/],
        'foreign lock URL': [f => { f.release.assets.find(a => a.name === 'RELEASE_CANDIDATE_LOCK.json').browser_download_url = 'https://foreign.invalid/lock'; }, /PEANUT_RELEASE_ASSET_INVALID/],
        'changed lock bytes': [f => f.bytes.set('RELEASE_CANDIDATE_LOCK.json', Buffer.from('{}')), /PEANUT_RELEASE_IDENTITY_INVALID/],
        'wrong lock SHA': [f => { f.manifest.candidate_lock.sha256 = 'f'.repeat(64); f.bytes.set('RELEASE_MANIFEST.json', Buffer.from(JSON.stringify(f.manifest))); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'version': [f => { f.manifest.version = '5.0.3'; f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'tag': [f => { f.lock.tag = 'v5.0.3'; f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'repository': [f => { f.manifest.repository = 'https://github.com/foreign/project'; f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'source commit': [f => { f.lock.candidate.commit = 'e'.repeat(40); f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'source tree': [f => { f.lock.candidate.tree = 'e'.repeat(40); f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'inventory': [f => { f.lock.inputs.application_template_inventory_sha256 = 'e'.repeat(64); f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'template lock': [f => { f.lock.template_artifacts.version = '5.0.3'; f.seal(); }, /PEANUT_RELEASE_IDENTITY_INVALID/],
        'JSON bytes': [f => f.bytes.set('peanut-scaffold-standalone.json', Buffer.concat([f.bytes.get('peanut-scaffold-standalone.json'), Buffer.from(' ')])), /PEANUT_RELEASE_ASSET_BINDING_INVALID/],
        'tgz bytes': [f => f.bytes.set('peanut-scaffold-standalone.tgz', Buffer.from('changed archive')), /PEANUT_RELEASE_ASSET_BINDING_INVALID/],
        'JSON asset digest': [f => { f.manifest.artifacts['peanut-scaffold-standalone.json'] = { ...f.manifest.artifacts['peanut-scaffold-standalone.json'], sha256: 'e'.repeat(64) }; f.seal(); }, /PEANUT_RELEASE_ASSET_BINDING_INVALID/],
    };
    for (const [name, [mutate, error]] of Object.entries(mutations)) {
        await t.test(name, async (t) => {
            const f = officialFixture(t);
            const before = fs.readdirSync(f.root);
            mutate(f);
            await assert.rejects(createProject(f.options, f.fetcher), error);
            assert.deepEqual(fs.readdirSync(f.root), before);
            assert.equal(fs.existsSync(f.options.target), false);
        });
    }
});

test('official create refuses an internally valid package pair from a different locked source', async (t) => {
    const f = officialFixture(t);
    const foreign = officialFixture(t, { sourceCommit: 'e'.repeat(40) });
    const name = 'peanut-scaffold-standalone';
    const archive = foreign.bytes.get(name + '.tgz');
    // This pair passes the pre-existing internal/member/tooling contract.
    assert.equal(validateTemplatePackage(foreign.metadata, archive, 'standalone').metadata.source.commit, 'e'.repeat(40));
    for (const extension of ['json', 'tgz']) f.bytes.set(name + '.' + extension, foreign.bytes.get(name + '.' + extension));
    await assert.rejects(createProject(f.options, f.fetcher), /PEANUT_RELEASE_IDENTITY_INVALID/);
    assert.equal(fs.existsSync(f.options.target), false);
});

function releaseVersions() {
    const packages = {};
    for (const name of ['client', 'vue', 'ui-vue', 'nuxt', 'uniapp', 'testing']) {
        packages[`@peanut-admin/${name}`] = {
            version: '4.0.0',
            archive: `packages/core-web/peanut-admin-${name}-4.0.0.tgz`,
            sha256: 'c'.repeat(64),
        };
    }
    return {
        schema_version: 3,
        protocol: 'peanut.release-versions.v3',
        source_product_version: '4.0.0-rc.3',
        scaffold_template: '4.0.0-rc.3',
        generated_instance_default: '0.1.0',
        instance_version: '0.1.0',
        core_php: {
            package: 'peanut-admin/core',
            constraint: '4.0.0',
            resolved_version: '4.0.0',
            source_type: 'git',
            source_url: 'https://github.com/peanut-business/peanut-admin-core-php.git',
            source_reference: 'a'.repeat(40),
        },
        core_web: {
            source_type: 'git',
            source_url: 'https://github.com/peanut-business/peanut-admin-core-web.git',
            source_reference: 'b'.repeat(40),
            packages,
        },
    };
}

function createFixture(t) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-cli-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const app = path.join(temp, 'app');
    fs.mkdirSync(path.join(app, '.peanut'), { recursive: true });
    const manifest = {
        schema_version: 2,
        protocol: 'peanut.application-scaffold.v2',
        application: {
            name: 'Example',
            slug: 'example',
            package_identity: 'example/app',
            version: '0.1.0',
            edition: 'standalone',
            profile: 'minimal',
        },
        template: { version: '4.0.0-rc.3', source_commit: 'a'.repeat(40), source_tree: 'b'.repeat(40) },
        generation_source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
        files: [],
    };
    const saveManifest = () => {
        fs.writeFileSync(path.join(app, '.peanut/application-manifest.json'), JSON.stringify(manifest));
    };
    saveManifest();
    fs.writeFileSync(path.join(app, 'release-versions.json'), JSON.stringify(releaseVersions(), null, 2) + '\n');
    return { temp, app, manifest, saveManifest };
}

function cli(app, args, expected = 0) {
    const result = spawnSync(process.execPath, [BIN, ...args, '--path', app], { encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr + result.stdout);
    return expected === 0 || expected === 1 ? JSON.parse(result.stdout) : result.stderr;
}

function workflow(app, name = 'ci.yml') {
    return path.join(app, '.github/workflows', name);
}

function* walk(root, prefix = '') {
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
        const relative = path.join(prefix, entry.name);
        yield relative;
        if (entry.isDirectory() && !entry.isSymbolicLink()) yield* walk(root, relative);
    }
}

test('version and help work without an application checkout', () => {
    let result = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `Peanut CLI ${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}`);
    result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /recipe add app-ci/);
});

test('add installs exact recipe baseline without changing application identity', (t) => {
    const { app } = createFixture(t);
    const original = fs.readFileSync(path.join(app, '.peanut/application-manifest.json'));
    const result = cli(app, ['recipe', 'add', 'app-ci']);
    assert.equal(result.version, '1.0.0');
    const state = JSON.parse(fs.readFileSync(path.join(app, '.peanut/recipes/app-ci/manifest.json'), 'utf8'));
    assert.equal(state.protocol, 'peanut.recipe-installation.v1');
    for (const entry of state.manifest.files) {
        const target = path.join(app, entry.path);
        const baseline = path.join(app, '.peanut/recipes/app-ci/baseline/files', entry.path);
        assert.equal(entry.owner, 'recipe:app-ci');
        assert.deepEqual(fs.readFileSync(target), fs.readFileSync(baseline));
        assert.equal(sha256File(target), entry.sha256);
        assert.equal(fs.statSync(target).mode & 0o777, entry.mode);
    }
    assert.deepEqual(fs.readFileSync(path.join(app, '.peanut/application-manifest.json')), original);
    assert.equal(fs.existsSync(path.join(app, '.peanut/recipes/.app-ci.installing')), false);
});

test('repeat add preserves customization and baseline', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'app-ci']);
    const baseline = path.join(app, '.peanut/recipes/app-ci/manifest.json');
    const before = fs.readFileSync(baseline);
    fs.writeFileSync(workflow(app), 'downstream customization\n');
    const result = cli(app, ['recipe', 'add', 'app-ci']);
    assert.equal(fs.readFileSync(workflow(app), 'utf8'), 'downstream customization\n');
    assert.deepEqual(fs.readFileSync(baseline), before);
    assert.equal(result.files[0].status, 'modified');
});

test('later path conflict prevents partial install', (t) => {
    const { app } = createFixture(t);
    fs.mkdirSync(path.dirname(workflow(app, 'release.yml')), { recursive: true });
    fs.writeFileSync(workflow(app, 'release.yml'), 'keep\n');
    assert.match(cli(app, ['recipe', 'add', 'app-ci'], 2), /RECIPE_PATH_CONFLICT/);
    assert.equal(fs.existsSync(workflow(app)), false);
    assert.equal(fs.existsSync(path.join(app, '.peanut/recipes')), false);
    assert.equal(fs.readFileSync(workflow(app, 'release.yml'), 'utf8'), 'keep\n');
});

test('identical existing bytes do not grant recipe ownership', (t) => {
    const { app } = createFixture(t);
    fs.mkdirSync(path.dirname(workflow(app)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'recipes/app-ci/1.0.0/files/.github/workflows/ci.yml'), workflow(app));
    assert.match(cli(app, ['recipe', 'add', 'app-ci'], 2), /RECIPE_PATH_CONFLICT/);
});

test('old scaffold ownership requires explicit transition', (t) => {
    const { app, manifest, saveManifest } = createFixture(t);
    manifest.files = [{ path: '.github/workflows/ci.yml', classification: 'managed' }];
    saveManifest();
    assert.match(cli(app, ['recipe', 'add', 'app-ci'], 2), /RECIPE_OWNERSHIP_CONFLICT/);
    assert.equal(fs.existsSync(workflow(app)), false);
});

test('symlink target path is rejected', (t) => {
    const { temp, app } = createFixture(t);
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(app, '.github'), 'dir');
    assert.match(cli(app, ['recipe', 'add', 'app-ci'], 2), /SYMLINK_REJECTED/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('pending install is not replayed', (t) => {
    const { app } = createFixture(t);
    fs.mkdirSync(path.join(app, '.peanut/recipes/.app-ci.installing'), { recursive: true });
    assert.equal(cli(app, ['recipe', 'status', 'app-ci']).recipes[0].status, 'recovery_required');
    assert.match(cli(app, ['recipe', 'add', 'app-ci'], 2), /RECOVERY_REQUIRED/);
    assert.equal(fs.existsSync(workflow(app)), false);
});

test('baseline corruption is rejected', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'app-ci']);
    fs.writeFileSync(path.join(app, '.peanut/recipes/app-ci/baseline/files/.github/workflows/ci.yml'), 'corrupt');
    assert.match(cli(app, ['recipe', 'status'], 2), /BASELINE_DIGEST_MISMATCH/);
});

test('source manifest corruption is rejected', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'app-ci']);
    fs.writeFileSync(path.join(app, '.peanut/recipes/app-ci/source-manifest.json'), '{}');
    assert.match(cli(app, ['recipe', 'status'], 2), /MANIFEST_DIGEST_MISMATCH/);
});

test('status reports missing and mode changes', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'app-ci']);
    fs.chmodSync(workflow(app), 0o755);
    fs.unlinkSync(workflow(app, 'release.yml'));
    assert.deepEqual(cli(app, ['status']).recipes[0].files.map((file) => file.status), ['modified', 'missing']);
});

test('invalid id, unknown recipe, and missing application fail closed', (t) => {
    const { app } = createFixture(t);
    assert.match(cli(app, ['recipe', 'add', '../escape'], 2), /ID_INVALID/);
    assert.match(cli(app, ['recipe', 'add', 'gitlab-ci'], 2), /RECIPE_UNKNOWN/);
    fs.unlinkSync(path.join(app, '.peanut/application-manifest.json'));
    assert.match(cli(app, ['recipe', 'add', 'app-ci'], 2), /APPLICATION_MANIFEST_REQUIRED/);
    assert.match(cli(app, ['status'], 2), /APPLICATION_MANIFEST_REQUIRED/);
});

test('doctor is read-only and catalog selects the current recipe versions', (t) => {
    const { app, manifest, saveManifest } = createFixture(t);
    manifest.template.source_commit = 'a'.repeat(40);
    manifest.template.source_tree = 'b'.repeat(40);
    manifest.generation_source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
    saveManifest();
    fs.writeFileSync(path.join(app, 'modules.lock'), JSON.stringify({ schema_version: 1, modules: [] }));
    const before = [...walk(app)].sort();
    const result = cli(app, ['doctor'], 1);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.checks['server/composer.lock'], false);
    assert.equal(result.checks['modules.lock'], true);
    assert.equal(Object.hasOwn(result.checks, 'plugins.lock'), false);
    assert.equal(cli(app, ['status']).kind, 'application');
    assert.deepEqual(cli(app, ['recipe', 'list']).available, { 'app-ci': '1.0.0', 'scaffold-ci': '1.0.1' });
    assert.deepEqual([...walk(app)].sort(), before);
});

test('doctor uses the selected APP toolchain and current scaffold upgrade entry', (t) => {
    const { app } = createFixture(t);
    const local = path.join(app, '.local/toolchain');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'host.json'), JSON.stringify({
        commands: { node: [process.execPath], npm: [process.execPath], pnpm: [process.execPath] },
    }));
    fs.mkdirSync(path.join(app, 'scripts'));
    fs.writeFileSync(path.join(app, 'scripts/scaffold-upgrade'), '#!/bin/sh\\n');
    const result = spawnSync(process.execPath, [BIN, 'doctor', '--path', app], {
        encoding: 'utf8', env: { ...process.env, PATH: '' },
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.tool_node, true);
    assert.equal(report.checks.tool_npm, true);
    assert.equal(report.checks.tool_pnpm, true);
    assert.equal(report.checks['scripts/scaffold-upgrade'], true);
    assert.equal(Object.hasOwn(report.checks, 'scripts/upgrade'), false);
    assert.equal(report.checks['server/composer.lock'], false);
});

test('corrupt bundle is rejected before application writes', (t) => {
    const { temp, app } = createFixture(t);
    const tool = path.join(temp, 'tool');
    fs.mkdirSync(tool);
    fs.cpSync(path.join(ROOT, 'recipes'), path.join(tool, 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(tool, 'recipes/app-ci/1.0.0/files/.github/workflows/release.yml'), 'corrupt');
    assert.throws(() => new RecipeManager(tool).add(app, 'app-ci'), /SOURCE_DIGEST_MISMATCH/);
    assert.equal(fs.existsSync(workflow(app)), false);
});

test('server-only recipe supplies explicit application root and immutable file digests', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'recipes/app-ci/1.0.0/manifest.json'), 'utf8'));
    for (const entry of manifest.files) assert.equal(sha256File(path.join(ROOT, 'recipes/app-ci/1.0.0/files', entry.path)), entry.sha256);
    const release = fs.readFileSync(path.join(ROOT, 'recipes/app-ci/1.0.0/files/.github/workflows/release.yml'), 'utf8');
    assert.match(release, /--application-root="\$GITHUB_WORKSPACE" --server-only/);
    assert.match(release, /application-release\.tar\.gz\.manifest\.json/);
    assert.doesNotMatch(release, /contents: write|git push|gh release create/);
});

test('new catalog preserves the retired installed Recipe without reinstalling or overwriting it', (t) => {
    const { app } = createFixture(t);
    new RecipeManager(ROOT).add(app, 'app-ci');
    const directory = path.join(app, '.peanut/recipes/github-ci');
    fs.renameSync(path.join(app, '.peanut/recipes/app-ci'), directory);
    const source = path.join(directory, 'source-manifest.json');
    const statePath = path.join(directory, 'manifest.json');
    const state = JSON.parse(fs.readFileSync(statePath));
    state.recipe = 'github-ci';
    state.manifest.recipe = 'github-ci';
    state.manifest.version = '1.0.1';
    delete state.manifest.repository_kind;
    for (const entry of state.manifest.files) entry.owner = 'recipe:github-ci';
    fs.writeFileSync(source, JSON.stringify(state.manifest));
    state.manifest_sha256 = sha256File(source);
    fs.writeFileSync(statePath, JSON.stringify(state));
    const before = fs.readFileSync(source);
    const fileBefore = fs.readFileSync(workflow(app, 'release.yml'));
    const result = new RecipeManager(ROOT).add(app, 'github-ci');
    assert.equal(result.version, '1.0.1');
    assert.deepEqual(fs.readFileSync(source), before);
    assert.deepEqual(fs.readFileSync(workflow(app, 'release.yml')), fileBefore);
    assert.throws(() => new RecipeManager(ROOT).add(app, 'app-ci'), /PATH_CONFLICT/);
});

test('scaffold Recipe uses its own repository contract and both template Editions', (t) => {
    const { temp, app } = createFixture(t);
    assert.throws(() => new RecipeManager(ROOT).add(app, 'scaffold-ci'), /SCAFFOLD_REQUIRED/);
    const scaffold = path.join(temp, 'scaffold');
    fs.mkdirSync(path.join(scaffold, 'scaffold'), { recursive: true });
    fs.mkdirSync(path.join(scaffold, 'scripts'));
    fs.writeFileSync(path.join(scaffold, 'scaffold/application-template-inventory.json'), JSON.stringify({ protocol: 'peanut.create-app-inventory.v2', template_version: '5.0.2', files: [] }));
    fs.writeFileSync(path.join(scaffold, 'release-versions.json'), JSON.stringify({ scaffold_template: '5.0.2' }));
    fs.writeFileSync(path.join(scaffold, 'scripts/build-scaffold-release'), '<?php');
    assert.throws(() => new RecipeManager(ROOT).add(scaffold, 'app-ci'), /APPLICATION_MANIFEST_REQUIRED/);
    const result = new RecipeManager(ROOT).add(scaffold, 'scaffold-ci');
    assert.equal(result.status, 'installed');
    const release = fs.readFileSync(workflow(scaffold, 'scaffold-release.yml'), 'utf8');
    assert.match(release, /for edition in standalone multi-tenant/);
    assert.match(release, /php scripts\/build-scaffold-release/);
    assert.doesNotMatch(release, /package-release\.sh|--server-only|gh release create/);
    assert.equal(fs.existsSync(workflow(scaffold, 'release.yml')), false);
});

test('create refuses the retired Git-source option before obtaining source or writing target', (t) => {
    const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'peanut-cli-create-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const target = path.join(temp, 'target');
    const result = spawnSync(process.execPath, [BIN, 'create', target,
        '--name', 'Created App', '--slug', 'created-app', '--package', 'example/created-app',
        '--edition', 'standalone', '--source', 'https://example.invalid/retired.git'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PEANUT_CREATE_ARGUMENTS_INVALID/);
    assert.equal(fs.existsSync(target), false);
});

test('non-interactive create requires an explicit Edition', (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-cli-create-edition-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [
        BIN, 'create', path.join(temp, 'created-app'),
        '--name', 'Created App', '--slug', 'created-app', '--package', 'example/created-app',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /PEANUT_CREATE_EDITION_REQUIRED/);
});

function createFakeExecutable(file, body) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
}

test('resolveWorkingRoot and CLI commands resolve project root from subdirectories without --path', (t) => {
    const { temp, app } = createFixture(t);
    const realApp = fs.realpathSync(app);
    const subDir = path.join(app, 'server/app/command');
    fs.mkdirSync(subDir, { recursive: true });
    assert.equal(resolveWorkingRoot(null, subDir), realApp);

    const statusResult = spawnSync(process.execPath, [BIN, 'status'], { cwd: subDir, encoding: 'utf8' });
    assert.equal(statusResult.status, 0, statusResult.stderr + statusResult.stdout);
    const statusJson = JSON.parse(statusResult.stdout);
    assert.equal(statusJson.kind, 'application');
    assert.equal(statusJson.application.slug, 'example');

    const nestedOther = path.join(temp, 'elsewhere');
    fs.mkdirSync(nestedOther, { recursive: true });
    assert.equal(resolveWorkingRoot(null, nestedOther), fs.realpathSync(nestedOther));
    assert.equal(resolveWorkingRoot(nestedOther, subDir), fs.realpathSync(nestedOther));
});

test('configureProject treats created application as single code directory and rejects scaffold options', async (t) => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-cli-config-app-')));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    // Adjacent Core directories exist as traps; application config must ignore them.
    fs.mkdirSync(path.join(temp, 'peanut-admin-core-php'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'peanut-admin-core-php/composer.json'), JSON.stringify({
        name: 'peanut-admin/core',
        require: { php: '^8.3' },
    }));
    fs.mkdirSync(path.join(temp, 'peanut-admin-core-web'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'peanut-admin-core-web/package.json'), JSON.stringify({
        name: 'peanut-admin-core-web',
    }));

    const appRoot = path.join(temp, 'my-app');
    const serverSub = path.join(appRoot, 'server/app');
    fs.mkdirSync(path.join(appRoot, '.peanut'), { recursive: true });
    fs.mkdirSync(path.join(appRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(appRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(serverSub, { recursive: true });
    fs.writeFileSync(path.join(appRoot, '.peanut/application-manifest.json'), JSON.stringify({ schema_version: 2 }));
    fs.writeFileSync(path.join(appRoot, 'tools/toolchain.json'), JSON.stringify({ tools: { python3: { version: '3.12.2' } } }));
    fs.writeFileSync(path.join(appRoot, 'scripts/project-env'), '# stub\n');

    const fakePython = path.join(temp, 'bin/python3');
    createFakeExecutable(fakePython, 'if [ "$1" = "--version" ]; then echo "Python 3.12.2"; exit 0; fi\nexit 0');

    // Legacy scaffold fields in existing host.json must be stripped on re-configure of an application.
    fs.mkdirSync(path.join(appRoot, '.local/toolchain'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, '.local/toolchain/host.json'), JSON.stringify({
        schema_version: 1,
        commands: {},
        paths: { release: 'release', backups: '../backups' },
        release_database_backup: null,
    }));

    for (const badOptions of [
        { python3: fakePython, releasePath: 'release', yes: true },
        { python3: fakePython, backupsPath: '../backups', yes: true },
        { python3: fakePython, noReleaseDatabaseBackup: true, yes: true },
    ]) {
        await assert.rejects(
            () => configureProject(appRoot, badOptions),
            /PEANUT_CONFIG_APPLICATION_SCAFFOLD_OPTION_UNSUPPORTED/,
        );
    }

    const cliResult = spawnSync(
        process.execPath,
        [BIN, 'config', '--python', fakePython, '--yes'],
        { cwd: serverSub, encoding: 'utf8' },
    );
    assert.equal(cliResult.status, 0, cliResult.stderr + cliResult.stdout);
    const cliJson = JSON.parse(cliResult.stdout);
    assert.equal(cliJson.project_kind, 'application');
    assert.equal(cliJson.paths, undefined);
    assert.equal(fs.existsSync(path.join(serverSub, '.local/toolchain/host.json')), false);

    const writtenHost = JSON.parse(fs.readFileSync(path.join(appRoot, '.local/toolchain/host.json'), 'utf8'));
    assert.equal(Object.hasOwn(writtenHost, 'core'), false);
    assert.equal(Object.hasOwn(writtenHost, 'paths'), false);
    assert.equal(Object.hasOwn(writtenHost, 'release_database_backup'), false);
});

test('configureProject uses ../backups default on scaffold and validates --core-mode', async (t) => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-cli-config-scaffold-')));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const scaffoldRoot = path.join(temp, 'scaffold');
    fs.mkdirSync(path.join(scaffoldRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(scaffoldRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(scaffoldRoot, 'tools/toolchain.json'), JSON.stringify({ tools: { python3: { version: '3.12.2' } } }));
    fs.writeFileSync(path.join(scaffoldRoot, 'scripts/project-env'), '# stub\n');

    const fakePython = path.join(temp, 'bin/python3');
    createFakeExecutable(fakePython, 'if [ "$1" = "--version" ]; then echo "Python 3.12.2"; exit 0; fi\nexit 0');

    await assert.rejects(
        () => configureProject(scaffoldRoot, { python3: fakePython, coreMode: 'invalid', yes: true }),
        /PEANUT_CONFIG_CORE_MODE_INVALID/,
    );

    const configured = await configureProject(scaffoldRoot, { python3: fakePython, yes: true });
    assert.equal(configured.project_kind, 'scaffold');
    assert.equal(configured.paths.backups, '../backups');
    const writtenHost = JSON.parse(fs.readFileSync(path.join(scaffoldRoot, '.local/toolchain/host.json'), 'utf8'));
    assert.equal(writtenHost.paths.backups, '../backups');
});

test('parseCoreArguments and inspectCoreStatus report release, out_of_sync, local-path, and validate project files', (t) => {
    assert.deepEqual(parseCoreArguments([]), { action: 'status' });
    assert.deepEqual(
        parseCoreArguments(['path', '--client', 'web,platform', '--core-php', '../php']),
        { action: 'path', client: 'web,platform', corePhp: '../php' },
    );
    assert.throws(() => parseCoreArguments(['release', '--core-php', '../php']), /PEANUT_CORE_ARGUMENTS_INVALID/);
    assert.throws(() => parseCoreArguments(['status', '--client', 'bogus']), /PEANUT_CORE_CLIENT_INVALID/);

    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-cli-core-status-')));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const appRoot = path.join(temp, 'app');
    fs.mkdirSync(path.join(appRoot, '.peanut'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, '.peanut/application-manifest.json'), JSON.stringify({ schema_version: 2 }));
    assert.throws(() => inspectCoreStatus(appRoot), /PEANUT_CORE_PROJECT_INVALID/);

    const repoRoot = path.join(temp, 'repo');
    const phpCore = path.join(temp, 'peanut-admin-core-php');
    const webCore = path.join(temp, 'peanut-admin-core-web');
    const workspacePkg = path.join(repoRoot, 'src/modules/peanut-chart');
    fs.mkdirSync(path.join(phpCore, 'src'), { recursive: true });
    fs.writeFileSync(path.join(phpCore, 'composer.json'), JSON.stringify({ name: 'peanut-admin/core' }));
    fs.mkdirSync(path.join(webCore, 'packages/client/dist'), { recursive: true });
    fs.writeFileSync(path.join(webCore, 'packages/client/package.json'), JSON.stringify({ name: '@peanut-admin/client', version: '5.1.0' }));
    fs.writeFileSync(path.join(webCore, 'packages/client/dist/index.js'), 'export {};\n');
    fs.writeFileSync(path.join(webCore, 'packages/client/dist/index.d.ts'), 'export {};\n');
    fs.mkdirSync(workspacePkg, { recursive: true });
    fs.writeFileSync(path.join(workspacePkg, 'package.json'), JSON.stringify({ name: '@peanut-admin/peanut-chart', version: '1.0.0' }));

    fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tools/toolchain.json'), JSON.stringify({
        execution: { protocol: 'peanut.project-env.v2' },
    }));
    fs.writeFileSync(path.join(repoRoot, 'scripts/project-env'), [
        'import json, sys',
        "assert sys.argv[-3:] == ['--tools', 'node', 'doctor']",
        `print(json.dumps({'status': 'ok', 'writes': False, 'tools': {'node': {'argv': [${JSON.stringify(process.execPath)}]}}}))`,
    ].join('\n'));
    fs.writeFileSync(path.join(repoRoot, 'scripts/local-core-web'),
        '[[ "$*" == "status --client web" && -f web/pnpm-lock.yaml ]]\n');
    fs.writeFileSync(path.join(repoRoot, 'scripts/core-dev'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(repoRoot, 'server/vendor/composer'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'server/vendor/peanut-admin/core'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'server/vendor/peanut-admin/core/composer.json'), JSON.stringify({ name: 'peanut-admin/core' }));
    fs.mkdirSync(path.join(repoRoot, 'server/app/service'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'server/composer.json'), JSON.stringify({
        require: { 'peanut-admin/core': '^5.1.0' },
    }));
    fs.writeFileSync(path.join(repoRoot, 'server/composer.lock'), JSON.stringify({
        packages: [{ name: 'peanut-admin/core', version: 'v5.1.0', source: { reference: 'ref-510' } }],
    }));
    fs.writeFileSync(path.join(repoRoot, 'server/vendor/autoload.php'), '<?php\n');
    fs.writeFileSync(path.join(repoRoot, 'server/vendor/services.php'), '<?php return ["Peanut\\Core\\Provider"];\n');

    const writeInstalledPhp = (version, ref) => {
        fs.writeFileSync(path.join(repoRoot, 'server/vendor/composer/installed.json'), JSON.stringify({
            packages: [{ name: 'peanut-admin/core', version, source: { reference: ref } }],
        }));
    };

    // Setup web in release mode + unrelated workspace symlink (must be ignored by core status).
    fs.mkdirSync(path.join(repoRoot, 'web/node_modules/@peanut-admin/client/dist'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'web/pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    fs.writeFileSync(path.join(repoRoot, 'web/package.json'), JSON.stringify({
        dependencies: {
            '@peanut-admin/client': '5.1.0',
            '@peanut-admin/peanut-chart': 'workspace:^1.0.0',
        },
    }));
    fs.writeFileSync(path.join(repoRoot, 'web/node_modules/@peanut-admin/client/package.json'), JSON.stringify({
        name: '@peanut-admin/client',
        version: '5.1.0',
    }));
    fs.writeFileSync(path.join(repoRoot, 'web/node_modules/@peanut-admin/client/dist/index.js'), 'export {};\n');
    fs.writeFileSync(path.join(repoRoot, 'web/node_modules/@peanut-admin/client/dist/index.d.ts'), 'export {};\n');
    fs.symlinkSync(workspacePkg, path.join(repoRoot, 'web/node_modules/@peanut-admin/peanut-chart'));

    // Case 1: release mismatch (locked v5.1.0 vs vendor v5.0.3).
    writeInstalledPhp('v5.0.3', 'ref-503');
    const mismatch = inspectCoreStatus(repoRoot, { client: 'web' });
    assert.equal(mismatch.status, 'out_of_sync');
    assert.equal(mismatch.mode, 'release');
    assert.equal(mismatch.php.synced, false);
    assert.equal(mismatch.web.web.synced, true);

    // Case 2: release synced (v5.1.0 matches lock, invoked from subdirectory via CLI).
    writeInstalledPhp('v5.1.0', 'ref-510');
    const syncedRelease = inspectCoreStatus(repoRoot, { client: 'web' });
    assert.equal(syncedRelease.status, 'ok');
    assert.equal(syncedRelease.mode, 'release');
    fs.unlinkSync(path.join(repoRoot, 'web/pnpm-lock.yaml'));
    assert.equal(inspectCoreStatus(repoRoot, { client: 'web' }).status, 'out_of_sync');
    fs.writeFileSync(path.join(repoRoot, 'web/pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const cliCore = spawnSync(
        process.execPath,
        [BIN, 'core', 'status', '--client', 'web'],
        { cwd: path.join(repoRoot, 'server/app'), encoding: 'utf8' },
    );
    assert.equal(cliCore.status, 0, cliCore.stderr + cliCore.stdout);
    const cliCoreJson = JSON.parse(cliCore.stdout);
    assert.equal(cliCoreJson.status, 'ok');
    assert.equal(cliCoreJson.root, repoRoot);

    // Case 3: local-path synced (vendor symlink + web core symlink + .local/core-dev.json).
    fs.rmSync(path.join(repoRoot, 'server/vendor/peanut-admin/core'), { recursive: true, force: true });
    fs.symlinkSync(phpCore, path.join(repoRoot, 'server/vendor/peanut-admin/core'));
    fs.rmSync(path.join(repoRoot, 'web/node_modules/@peanut-admin/client'), { recursive: true, force: true });
    fs.symlinkSync(path.join(webCore, 'packages/client'), path.join(repoRoot, 'web/node_modules/@peanut-admin/client'));
    fs.mkdirSync(path.join(repoRoot, '.local'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.local/core-dev.json'), JSON.stringify({
        schema_version: 1,
        application_root: repoRoot,
        backend_env: path.join(repoRoot, 'server/.env'),
        php_core_dir: phpCore,
        web_core_dir: webCore,
    }));
    const localPath = inspectCoreStatus(repoRoot, { client: 'web' });
    assert.equal(localPath.status, 'ok');
    assert.equal(localPath.mode, 'local-path');
    assert.equal(localPath.php.synced, true);
    assert.equal(localPath.web.web.synced, true);
});
