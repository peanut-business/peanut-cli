import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RecipeManager } from '../lib/recipe-manager.js';
import { sha256File } from '../lib/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/peanut.js');

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
        template: { version: '4.0.0-rc.3' },
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
    assert.equal(result.stdout.trim(), 'Peanut CLI 0.3.0');
    result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /recipe add github-ci/);
});

test('add installs exact recipe baseline without changing application identity', (t) => {
    const { app } = createFixture(t);
    const original = fs.readFileSync(path.join(app, '.peanut/application-manifest.json'));
    const result = cli(app, ['recipe', 'add', 'github-ci']);
    assert.equal(result.version, '1.0.0');
    const state = JSON.parse(fs.readFileSync(path.join(app, '.peanut/recipes/github-ci/manifest.json'), 'utf8'));
    assert.equal(state.protocol, 'peanut.recipe-installation.v1');
    for (const entry of state.manifest.files) {
        const target = path.join(app, entry.path);
        const baseline = path.join(app, '.peanut/recipes/github-ci/baseline/files', entry.path);
        assert.equal(entry.owner, 'recipe:github-ci');
        assert.deepEqual(fs.readFileSync(target), fs.readFileSync(baseline));
        assert.equal(sha256File(target), entry.sha256);
        assert.equal(fs.statSync(target).mode & 0o777, entry.mode);
    }
    assert.deepEqual(fs.readFileSync(path.join(app, '.peanut/application-manifest.json')), original);
    assert.equal(fs.existsSync(path.join(app, '.peanut/recipes/.github-ci.installing')), false);
});

test('repeat add preserves customization and baseline', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'github-ci']);
    const baseline = path.join(app, '.peanut/recipes/github-ci/manifest.json');
    const before = fs.readFileSync(baseline);
    fs.writeFileSync(workflow(app), 'downstream customization\n');
    const result = cli(app, ['recipe', 'add', 'github-ci']);
    assert.equal(fs.readFileSync(workflow(app), 'utf8'), 'downstream customization\n');
    assert.deepEqual(fs.readFileSync(baseline), before);
    assert.equal(result.files[0].status, 'modified');
});

test('later path conflict prevents partial install', (t) => {
    const { app } = createFixture(t);
    fs.mkdirSync(path.dirname(workflow(app, 'release.yml')), { recursive: true });
    fs.writeFileSync(workflow(app, 'release.yml'), 'keep\n');
    assert.match(cli(app, ['recipe', 'add', 'github-ci'], 2), /RECIPE_PATH_CONFLICT/);
    assert.equal(fs.existsSync(workflow(app)), false);
    assert.equal(fs.existsSync(path.join(app, '.peanut/recipes')), false);
    assert.equal(fs.readFileSync(workflow(app, 'release.yml'), 'utf8'), 'keep\n');
});

test('identical existing bytes do not grant recipe ownership', (t) => {
    const { app } = createFixture(t);
    fs.mkdirSync(path.dirname(workflow(app)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'recipes/github-ci/1.0.0/files/.github/workflows/ci.yml'), workflow(app));
    assert.match(cli(app, ['recipe', 'add', 'github-ci'], 2), /RECIPE_PATH_CONFLICT/);
});

test('old scaffold ownership requires explicit transition', (t) => {
    const { app, manifest, saveManifest } = createFixture(t);
    manifest.files = [{ path: '.github/workflows/ci.yml', classification: 'managed' }];
    saveManifest();
    assert.match(cli(app, ['recipe', 'add', 'github-ci'], 2), /RECIPE_OWNERSHIP_CONFLICT/);
    assert.equal(fs.existsSync(workflow(app)), false);
});

test('symlink target path is rejected', (t) => {
    const { temp, app } = createFixture(t);
    const outside = path.join(temp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(app, '.github'), 'dir');
    assert.match(cli(app, ['recipe', 'add', 'github-ci'], 2), /SYMLINK_REJECTED/);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('pending install is not replayed', (t) => {
    const { app } = createFixture(t);
    fs.mkdirSync(path.join(app, '.peanut/recipes/.github-ci.installing'), { recursive: true });
    assert.equal(cli(app, ['recipe', 'status', 'github-ci']).recipes[0].status, 'recovery_required');
    assert.match(cli(app, ['recipe', 'add', 'github-ci'], 2), /RECOVERY_REQUIRED/);
    assert.equal(fs.existsSync(workflow(app)), false);
});

test('baseline corruption is rejected', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'github-ci']);
    fs.writeFileSync(path.join(app, '.peanut/recipes/github-ci/baseline/files/.github/workflows/ci.yml'), 'corrupt');
    assert.match(cli(app, ['recipe', 'status'], 2), /BASELINE_DIGEST_MISMATCH/);
});

test('source manifest corruption is rejected', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'github-ci']);
    fs.writeFileSync(path.join(app, '.peanut/recipes/github-ci/source-manifest.json'), '{}');
    assert.match(cli(app, ['recipe', 'status'], 2), /MANIFEST_DIGEST_MISMATCH/);
});

test('status reports missing and mode changes', (t) => {
    const { app } = createFixture(t);
    cli(app, ['recipe', 'add', 'github-ci']);
    fs.chmodSync(workflow(app), 0o755);
    fs.unlinkSync(workflow(app, 'release.yml'));
    assert.deepEqual(cli(app, ['status']).recipes[0].files.map((file) => file.status), ['modified', 'missing']);
});

test('invalid id, unknown recipe, and missing application fail closed', (t) => {
    const { app } = createFixture(t);
    assert.match(cli(app, ['recipe', 'add', '../escape'], 2), /ID_INVALID/);
    assert.match(cli(app, ['recipe', 'add', 'gitlab-ci'], 2), /RECIPE_UNKNOWN/);
    fs.unlinkSync(path.join(app, '.peanut/application-manifest.json'));
    assert.match(cli(app, ['recipe', 'add', 'github-ci'], 2), /APPLICATION_MANIFEST_REQUIRED/);
    assert.match(cli(app, ['status'], 2), /APPLICATION_MANIFEST_REQUIRED/);
});

test('doctor is read-only and catalog keeps 1.0.0 active', (t) => {
    const { app } = createFixture(t);
    const before = [...walk(app)].sort();
    const result = cli(app, ['doctor'], 1);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.checks['server/composer.lock'], false);
    assert.equal(cli(app, ['status']).kind, 'application');
    assert.deepEqual(cli(app, ['recipe', 'list']).available, { 'github-ci': '1.0.0' });
    assert.deepEqual([...walk(app)].sort(), before);
});

test('corrupt bundle is rejected before application writes', (t) => {
    const { temp, app } = createFixture(t);
    const tool = path.join(temp, 'tool');
    fs.mkdirSync(tool);
    fs.cpSync(path.join(ROOT, 'recipes'), path.join(tool, 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(tool, 'recipes/github-ci/1.0.0/files/.github/workflows/release.yml'), 'corrupt');
    assert.throws(() => new RecipeManager(tool).add(app, 'github-ci'), /SOURCE_DIGEST_MISMATCH/);
    assert.equal(fs.existsSync(workflow(app)), false);
});

test('create stages a project from an explicit git source and records source identity', (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-cli-create-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const source = path.join(temp, 'source');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(source, 'server/vendor'), { recursive: true });
    fs.writeFileSync(path.join(source, 'server/vendor/autoload.php'), '<?php\n');
    fs.writeFileSync(path.join(source, 'scripts/create-app'), `<?php
$options = [];
foreach (array_slice($argv, 1) as $arg) {
    if (preg_match('/^--([^=]+)=(.*)$/', $arg, $m)) $options[$m[1]] = $m[2];
}
mkdir($options['target'] . '/.peanut', 0775, true);
file_put_contents($options['target'] . '/.peanut/application-manifest.json', json_encode(['ok' => true]));
echo json_encode([
    'status' => 'created',
    'target' => $options['target'],
    'template_version' => '4.0.0-rc.18',
    'application_version' => '0.1.0',
    'profile' => $options['profile'] ?? 'standard',
    'edition' => $options['edition'],
    'source_commit' => str_repeat('a', 40),
    'generation_source_commit' => str_repeat('b', 40),
    'managed_tree_sha256' => str_repeat('c', 64),
    'app_owned_tree_sha256' => str_repeat('d', 64),
]);
`);
    spawnSync('git', ['init', '-b', 'dev'], { cwd: source, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
    spawnSync('git', ['config', 'user.name', 'Peanut Test'], { cwd: source });
    spawnSync('git', ['add', '.'], { cwd: source });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: source, encoding: 'utf8' });

    const target = path.join(temp, 'created-app');
    const result = spawnSync(process.execPath, [
        BIN, 'create', target,
        '--name', 'Created App', '--slug', 'created-app', '--package', 'example/created-app',
        '--edition', 'standalone', '--source', source, '--ref', 'dev',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'created');
    assert.equal(output.source.ref, 'dev');
    assert.match(output.source.commit, /^[0-9a-f]{40}$/);
    assert.equal(fs.existsSync(path.join(target, '.peanut/application-manifest.json')), true);
    assert.equal([...fs.readdirSync(temp)].some((name) => name.startsWith('.created-app.peanut-create-')), false);
});
