import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, archive, officialFixture } from './helpers/template-fixture.js';
import { createProject } from '../lib/create-project.js';
import { discoverUpgrade, upgradeProject } from '../lib/upgrade-project.js';
import { readTemplateArchive, validateTemplatePackage } from '../lib/template-package.js';
import { sha256 } from '../lib/protocol.js';

const offline = () => { throw new Error('unexpected network access'); };

test('official upgrade shares release binding and refuses drift before cache or plan writes', async (t) => {
    for (const rejected of [false, true]) {
        const f = officialFixture(t);
        await createProject({ ...f.options, archive: path.join(f.root, 'template.tgz'), manifest: path.join(f.root, 'template.json') }, offline);
        const manifestPath = path.join(f.options.target, '.peanut/application-manifest.json');
        const application = JSON.parse(fs.readFileSync(manifestPath));
        application.template.version = '5.0.1';
        fs.writeFileSync(manifestPath, JSON.stringify(application));
        const before = fs.readFileSync(manifestPath);
        const options = { path: f.options.target, ref: 'v5.0.2', ...(rejected ? { plan: true } : { check: true }) };
        if (rejected) { f.lock.candidate.tree = 'e'.repeat(40); f.seal(); }
        if (rejected) await assert.rejects(upgradeProject(options, f.fetcher), /PEANUT_RELEASE_IDENTITY_INVALID/);
        else {
            const result = await upgradeProject(options, f.fetcher);
            assert.equal(result.status, 'available');
            assert.equal(result.metadata.source.tree, f.lock.candidate.tree);
        }
        assert.deepEqual(fs.readFileSync(manifestPath), before);
        assert.equal(fs.existsSync(path.join(f.options.target, '.peanut/upgrades')), false);
        assert.equal(f.calls.filter(url => url.includes('/tags/v5.0.2')).length, 1);
        assert.equal(f.calls.some(url => url.includes('/latest')), false);
    }
});
async function appFixture(t) {
    const f = fixture(t);
    await createProject(f.options, offline);
    const manifestPath = path.join(f.options.target, '.peanut/application-manifest.json');
    const application = JSON.parse(fs.readFileSync(manifestPath));
    application.template.version = '5.0.1';
    fs.writeFileSync(manifestPath, JSON.stringify(application));
    return { ...f, application, manifestPath, upgrade: { path: f.options.target, archive: f.options.archive, manifest: f.options.manifest } };
}

test('local check validates the same template without writing APP/cache or invoking tools', async (t) => {
    const f = await appFixture(t);
    const before = fs.readFileSync(f.manifestPath);
    const result = await upgradeProject({ ...f.upgrade, check: true }, offline);
    assert.equal(result.status, 'available');
    assert.equal(result.metadata.version, '5.0.2');
    assert.equal(result.source_relation.kind, 'explicit_local_selection');
    assert.deepEqual(fs.readFileSync(f.manifestPath), before);
    assert.equal(fs.existsSync(path.join(f.options.target, '.peanut/upgrades')), false);
    const current = await discoverUpgrade({ ...f.application, template: { ...f.application.template, version: '5.0.2' } }, f.upgrade, offline);
    assert.equal(current.status, 'up_to_date');
    const downgrade = await discoverUpgrade({ ...f.application, template: { ...f.application.template, version: '6.0.0' } }, f.upgrade, offline);
    assert.equal(downgrade.status, 'source_range_unsupported');
});

test('upgrade never installs dependencies and refuses a template without sealed tooling', async (t) => {
    const f = await appFixture(t);
    await assert.rejects(upgradeProject({ ...f.upgrade, plan: true }, offline), /TEMPLATE_TOOLING_REQUIRED/);
    assert.equal(fs.existsSync(path.join(f.options.target, 'server/vendor')), false);
    assert.equal(JSON.parse(fs.readFileSync(f.manifestPath)).template.version, '5.0.1');
    const metadata = JSON.parse(fs.readFileSync(f.options.manifest));
    const cache = path.join(f.options.target, '.peanut/upgrades/template-packages', metadata.archive.sha256);
    fs.writeFileSync(path.join(cache, 'files/README.md'), 'tampered');
    await assert.rejects(upgradeProject({ ...f.upgrade, plan: true }, offline), /ENGINE_CONTENT_MISMATCH/);
    fs.writeFileSync(path.join(cache, 'files/README.md'), '# Scaffold Product Token\n');
    fs.writeFileSync(path.join(cache, 'undeclared.php'), '<?php exit(0);');
    await assert.rejects(upgradeProject({ ...f.upgrade, plan: true }, offline), /ENGINE_UNDECLARED_INPUT/);
});

test('tooling is separately sealed, excluded from creation, and rejects corrupt locks or undeclared members', async (t) => {
    const files = [
        ['tooling/composer.json', Buffer.from('{}')],
        ['tooling/composer.lock', Buffer.from('{"packages":[]}')],
        ['tooling/vendor/composer/installed.json', Buffer.from('{"dev":false,"packages":[]}')],
        ['tooling/vendor/autoload.php', Buffer.from('<?php return null;')],
    ];
    const tooling = { protocol: 'peanut.scaffold-upgrade-tooling.v1', autoload: 'tooling/vendor/autoload.php',
        composer_lock_sha256: sha256(files[1][1]), packages: [],
        files: files.map(([name, bytes]) => ({ path: name, sha256: sha256(bytes), mode: 0o644 })) };
    const f = fixture(t, () => {}, [...files, ['upgrade-tooling.json', Buffer.from(JSON.stringify(tooling))]]);
    await createProject(f.options, offline);
    assert.equal(fs.existsSync(path.join(f.options.target, 'tooling')), false);
    assert.equal(fs.existsSync(path.join(f.options.target, 'server/vendor')), false);
    const metadata = JSON.parse(fs.readFileSync(f.options.manifest));
    const bytes = fs.readFileSync(f.options.archive);
    assert.equal(validateTemplatePackage(metadata, bytes, 'standalone').tooling.autoload, tooling.autoload);
    const members = [...readTemplateArchive(bytes)].map(([name, member]) => [name, member.bytes, member.mode]);
    members.push(['tooling/vendor/extra.php', Buffer.from('<?php exit(0);')]);
    const extra = archive(members);
    assert.throws(() => validateTemplatePackage({ ...metadata, archive: { ...metadata.archive, bytes: extra.length, sha256: sha256(extra) } }, extra, 'standalone'), /UNDECLARED_MEMBER/);
    const tampered = members.filter(([name]) => name !== 'tooling/vendor/extra.php').map(([name, content, mode]) => [name, name === 'tooling/vendor/autoload.php' ? Buffer.from('changed') : content, mode]);
    const changed = archive(tampered);
    assert.throws(() => validateTemplatePackage({ ...metadata, archive: { ...metadata.archive, bytes: changed.length, sha256: sha256(changed) } }, changed, 'standalone'), /TOOLING_FILE_CHANGED/);
});

async function developmentFixture(t) {
    const checkout = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'peanut-development-source-'));
    t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
    const git = (...args) => {
        const result = spawnSync('git', ['-c', 'user.name=CLI fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-C', checkout, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '--quiet');
    git('remote', 'add', 'origin', 'https://github.com/peanut-business/peanut-admin-code.git');
    fs.mkdirSync(path.join(checkout, 'scaffold'));
    const profiles = Buffer.from('{"protocol":"peanut.edition-profiles.v1"}\n');
    fs.writeFileSync(path.join(checkout, 'scaffold/edition-profiles.json'), profiles);
    const commit = (revision) => {
        const inventory = Buffer.from(JSON.stringify({ revision, files: [{ profiles: ['minimal', 'standard', 'full'] }] }) + '\n');
        fs.writeFileSync(path.join(checkout, 'scaffold/application-template-inventory.json'), inventory);
        git('add', '--', 'scaffold');
        git('commit', '--quiet', '-m', 'fixed development source ' + revision);
        return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
            inventory_sha256: sha256(inventory), edition_profile_sha256: sha256(profiles) };
    };
    const base = commit(1), target = commit(2);
    const f = fixture(t, ({ app, release, create }) => {
        Object.assign(app.generation_source, target, { requested_ref: target.commit });
        Object.assign(app.template, { source_commit: target.commit, source_tree: target.tree, inventory_sha256: target.inventory_sha256 });
        app.edition.source_sha256 = target.edition_profile_sha256;
        Object.assign(release.release, { source_commit: target.commit, source_tree: target.tree, inventory_sha256: target.inventory_sha256 });
        create.scaffold_manifest_sha256 = sha256(Buffer.from(JSON.stringify(release, null, 4) + '\n'));
    });
    await createProject(f.options, offline);
    const manifestPath = path.join(f.options.target, '.peanut/application-manifest.json');
    const current = JSON.parse(fs.readFileSync(manifestPath));
    const useBase = (application, source) => {
        Object.assign(application.generation_source, source, { requested_ref: 'local:' + '1'.repeat(64) });
        Object.assign(application.template, { source_commit: source.commit, source_tree: source.tree, inventory_sha256: source.inventory_sha256 });
        application.edition.source_sha256 = source.edition_profile_sha256;
        return application;
    };
    useBase(current, base);
    fs.writeFileSync(manifestPath, JSON.stringify(current));
    return { ...f, checkout, git, commit, base, target, current, useBase, manifestPath,
        upgrade: { path: f.options.target, archive: f.options.archive, manifest: f.options.manifest, sourceCheckout: checkout } };
}

// CLI protocol consumer only; native Git/projection/apply semantics have their own fixed evidence.
async function developmentBindingFixture(t, variant = '') {
    const f = await developmentFixture(t);
    f.current.application.profile = 'standard';
    fs.writeFileSync(f.manifestPath, JSON.stringify(f.current));
    const engine = Buffer.from(`<?php
$variant = ${JSON.stringify(variant)};
$options = [];
foreach (array_slice($argv, 2) as $arg) { [$key, $value] = explode('=', substr($arg, 2), 2); $options[$key] = $value; }
$root = $options['project-root']; $command = $argv[1];
file_put_contents($root . '/consumer-calls.jsonl', json_encode([$command, $options]) . "\\n", FILE_APPEND);
if ($command === 'template-plan') {
    $app = json_decode(file_get_contents($root . '/.peanut/application-manifest.json'), true);
    $metadata = json_decode(file_get_contents($options['template-package-manifest']), true);
    $base = array_intersect_key($app['generation_source'], array_flip(['commit','tree','inventory_sha256']));
    $target = array_intersect_key($metadata['source'], array_flip(['commit','tree','inventory_sha256']));
    $release = fn($source) => ['version' => '5.0.2', 'source_commit' => $source['commit'], 'source_tree' => $source['tree'], 'inventory_sha256' => $source['inventory_sha256']];
    $plan = ['protocol' => 'peanut.scaffold-upgrade-plan.v2', 'status' => 'blocked', 'actions' => [['conflict' => true]],
        'identity' => ['from' => $release($base), 'to' => $release($target),
            'source_selection' => ['source_checkout' => $options['source-checkout'] ?? null],
            'source_relation' => ['kind' => 'development_successor', 'repository' => 'peanut-business/peanut-admin-code', 'base' => $base, 'target' => $target],
            'development_source' => ['profile' => $app['application']['profile'], 'workflow' => $app['application']['workflow'], 'excluded_paths_sha256' => hash('sha256', '[]')]],
        'manifest_paths' => ['to' => $options['template-manifest']]];
    if ($variant === 'missing') unset($plan['identity']['source_relation']);
    if ($variant === 'relation') $plan['identity']['source_relation']['base']['commit'] = str_repeat('f', 40);
    if ($variant === 'checkout') $plan['identity']['source_selection']['source_checkout'] = '/wrong';
    if ($variant === 'profile') $plan['identity']['development_source']['profile'] = 'full';
    if ($variant === 'workflow') $plan['identity']['development_source']['workflow'] = 'none';
    if ($variant === 'digest') $plan['identity']['development_source']['excluded_paths_sha256'] = 'invalid';
} elseif ($command === 'resolve') {
    $plan = json_decode(file_get_contents($options['plan']), true);
    $plan['status'] = 'ready'; $plan['actions'] = [['conflict' => false]];
} else { echo json_encode(['status' => $command === 'verify' ? 'verified' : $command]); exit(0); }
$plan['plan_sha256'] = 'sha256:' . hash('sha256', json_encode([$plan['identity'], $plan['actions']]));
$plan['plan_path'] = '.peanut/upgrades/plans/' . $plan['status'] . '.json';
if (!is_dir($root . '/.peanut/upgrades/plans')) mkdir($root . '/.peanut/upgrades/plans', 0700, true);
file_put_contents($root . '/' . $plan['plan_path'], json_encode($plan)); echo json_encode($plan);
exit($plan['status'] === 'blocked' ? 2 : 0);
`);
    const members = readTemplateArchive(fs.readFileSync(f.options.archive));
    const create = JSON.parse(members.get('template-create.json').bytes);
    const release = JSON.parse(members.get('scaffold-manifest.json').bytes);
    const row = { path: 'scripts/scaffold-upgrade', source: 'files/scripts/scaffold-upgrade', mode: 0o644,
        classification: 'managed', sha256: sha256(engine), render: false };
    create.files.push(row);
    const { source, render, ...recorded } = row;
    create.application_manifest.files.push(recorded);
    release.files.push({ ...row, template_sha256: row.sha256 });
    const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
    const releaseBytes = encode(release);
    create.scaffold_manifest_sha256 = sha256(releaseBytes);
    const createBytes = encode(create);
    members.set('scaffold-manifest.json', { bytes: releaseBytes, mode: 0o644 });
    members.set('template-create.json', { bytes: createBytes, mode: 0o644 });
    members.set(row.source, { bytes: engine, mode: row.mode });
    const toolingFiles = [['tooling/composer.json', Buffer.from('{}')], ['tooling/composer.lock', Buffer.from('{"packages":[]}')],
        ['tooling/vendor/composer/installed.json', Buffer.from('{"dev":false,"packages":[]}')], ['tooling/vendor/autoload.php', Buffer.from('<?php return null;')]];
    const tooling = { protocol: 'peanut.scaffold-upgrade-tooling.v1', autoload: 'tooling/vendor/autoload.php',
        composer_lock_sha256: sha256(toolingFiles[1][1]), packages: [],
        files: toolingFiles.map(([name, bytes]) => ({ path: name, sha256: sha256(bytes), mode: 0o644 })) };
    for (const [name, bytes] of [...toolingFiles, ['upgrade-tooling.json', encode(tooling)]]) members.set(name, { bytes, mode: 0o644 });
    const packed = archive([...members].map(([name, member]) => [name, member.bytes, member.mode]));
    const metadata = JSON.parse(fs.readFileSync(f.options.manifest));
    Object.assign(metadata, { create_manifest_sha256: sha256(createBytes), scaffold_manifest_sha256: sha256(releaseBytes), upgrade_tooling_sha256: sha256(encode(tooling)) });
    Object.assign(metadata.archive, { bytes: packed.length, sha256: sha256(packed) });
    fs.writeFileSync(f.options.archive, packed); fs.writeFileSync(f.options.manifest, encode(metadata));
    return f;
}

test('native development binding forwards checkout and retains proof through saved consumers', async (t) => {
    const f = await developmentBindingFixture(t);
    const before = fs.readFileSync(f.manifestPath);
    const planned = await upgradeProject({ ...f.upgrade, plan: true }, offline);
    assert.equal(planned.status, 'blocked');
    const bindingDirectory = path.join(f.options.target, '.peanut/upgrades/engine-bindings');
    const bindingFile = path.join(bindingDirectory, fs.readdirSync(bindingDirectory)[0]);
    const binding = JSON.parse(fs.readFileSync(bindingFile));
    assert.equal(binding.source_checkout, fs.realpathSync(f.checkout));
    assert.deepEqual(binding.development_source, planned.plan.identity.development_source);
    assert.equal(binding.development_source.profile, 'standard');
    const applied = await upgradeProject({ path: f.options.target, applyPlan: planned.plan_path,
        confirmPlanSha256: planned.plan.plan_sha256, preservePaths: 'README.md', replacePaths: '-' }, offline);
    assert.equal(applied.status, 'verified');
    const resolvedBinding = fs.readdirSync(bindingDirectory).map(name => JSON.parse(fs.readFileSync(path.join(bindingDirectory, name)))).find(value => value.plan_path.endsWith('/ready.json'));
    assert.deepEqual(resolvedBinding.development_source, binding.development_source);
    assert.equal(resolvedBinding.source_checkout, binding.source_checkout);
    await upgradeProject({ path: f.options.target, recoverPlan: applied.plan_path }, offline);
    const calls = fs.readFileSync(path.join(f.options.target, 'consumer-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(([command]) => command), ['template-plan', 'resolve', 'apply', 'verify', 'recover']);
    assert.equal(calls[0][1]['source-checkout'], f.checkout);
    assert.deepEqual(fs.readFileSync(f.manifestPath), before);
    binding.development_source.excluded_paths_sha256 = 'e'.repeat(64);
    fs.writeFileSync(bindingFile, JSON.stringify(binding));
    await assert.rejects(upgradeProject({ path: f.options.target, applyPlan: planned.plan_path }, offline), /PLAN_DEVELOPMENT_SOURCE_MISMATCH/);
    assert.equal(fs.readFileSync(path.join(f.options.target, 'consumer-calls.jsonl'), 'utf8').trim().split('\n').length, 5);
});

test('native development binding rejects missing or mismatched native proof before saving', async (t) => {
    for (const variant of ['missing', 'relation', 'checkout', 'profile', 'workflow', 'digest']) {
        const f = await developmentBindingFixture(t, variant);
        await assert.rejects(upgradeProject({ ...f.upgrade, plan: true }, offline), /PLAN_DEVELOPMENT_SOURCE_MISMATCH/);
        assert.equal(fs.existsSync(path.join(f.options.target, '.peanut/upgrades/engine-bindings')), false);
    }
});

test('development successor requires explicit fixed ancestry and checks remain read-only', async (t) => {
    const f = await developmentFixture(t);
    const before = fs.readFileSync(f.manifestPath);
    const result = await upgradeProject({ ...f.upgrade, check: true }, offline);
    assert.equal(result.status, 'available');
    assert.equal(result.source_relation.kind, 'development_successor');
    assert.equal(result.source_relation.base.commit, f.base.commit);
    assert.equal(result.source_relation.target.commit, f.target.commit);
    const retainedIdentity = structuredClone(f.current);
    retainedIdentity.application.profile = 'standard';
    delete retainedIdentity.application.workflow;
    const retained = await discoverUpgrade(retainedIdentity, f.upgrade, offline);
    assert.equal(retained.status, 'available');
    assert.equal(retained.source_relation.application_profile, 'standard');
    assert.equal(retained.source_relation.template_profile, 'full');
    assert.equal(retainedIdentity.application.profile, 'standard');
    assert.equal(Object.hasOwn(retainedIdentity.application, 'workflow'), false);
    const { sourceCheckout, ...withoutProof } = f.upgrade;
    const missing = await upgradeProject({ ...withoutProof, check: true }, offline);
    assert.equal(missing.status, 'source_identity_unknown');
    assert.equal(missing.source_relation.reason, 'development_source_checkout_required');
    assert.deepEqual(fs.readFileSync(f.manifestPath), before);
    assert.equal(fs.existsSync(path.join(f.options.target, '.peanut/upgrades')), false);
});

test('development successor rejects unknown identity, foreign origin and non-ancestor history', async (t) => {
    const f = await developmentFixture(t);
    const check = (application = f.current) => discoverUpgrade(application, f.upgrade, offline);
    for (const change of [
        (app) => { app.template.source_commit = 'e'.repeat(40); },
        (app) => { app.application.profile = 'unsupported-profile'; },
        (app) => { app.generation_source.tree = app.template.source_tree = 'f'.repeat(40); },
        (app) => { app.generation_source.inventory_sha256 = app.template.inventory_sha256 = 'f'.repeat(64); },
    ]) {
        const application = structuredClone(f.current); change(application);
        assert.equal((await check(application)).status, 'source_identity_unknown');
    }
    f.git('remote', 'set-url', 'origin', 'https://example.invalid/foreign.git');
    assert.equal((await check()).status, 'source_identity_unknown');
    f.git('remote', 'set-url', 'origin', 'https://github.com/peanut-business/peanut-admin-code.git');
    const newer = f.commit(3);
    assert.equal((await check(f.useBase(structuredClone(f.current), newer))).status, 'source_ahead');
    f.git('checkout', '--quiet', '--detach', f.base.commit);
    const sibling = f.commit(4);
    assert.equal((await check(f.useBase(structuredClone(f.current), sibling))).status, 'source_diverged');
    fs.writeFileSync(path.join(f.checkout, '.git/info/grafts'), f.target.commit + '\n');
    assert.equal((await check()).source_relation.reason, 'development_repository_invalid');
    fs.unlinkSync(path.join(f.checkout, '.git/info/grafts'));
    const customGraft = path.join(f.checkout, 'injected-graft');
    fs.writeFileSync(customGraft, f.target.commit + ' ' + sibling.commit + '\n');
    const previousGraft = process.env.GIT_GRAFT_FILE;
    process.env.GIT_GRAFT_FILE = customGraft;
    try {
        assert.equal((await check(f.useBase(structuredClone(f.current), sibling))).status, 'source_diverged');
    } finally {
        if (previousGraft === undefined) delete process.env.GIT_GRAFT_FILE;
        else process.env.GIT_GRAFT_FILE = previousGraft;
    }
    assert.equal(fs.existsSync(path.join(f.options.target, '.peanut/upgrades')), false);
});

test('development successor does not admit equal-version official source changes or mixed arguments', async (t) => {
    const f = await developmentFixture(t);
    const official = structuredClone(f.current);
    Object.assign(official.generation_source, { channel: 'stable', requested_ref: 'v5.0.2', release_version: '5.0.2' });
    assert.equal((await discoverUpgrade(official, f.upgrade, offline)).status, 'source_identity_mismatch');
    await assert.rejects(discoverUpgrade(f.current, { ref: 'v5.0.2', sourceCheckout: f.checkout }, offline), /DEVELOPMENT_SOURCE_ARGUMENTS_INVALID/);
    const bin = fileURLToPath(new URL('../bin/peanut.js', import.meta.url));
    for (const args of [['--source-checkout', f.checkout], ['--apply-plan', 'x', '--source-checkout', f.checkout]]) {
        const result = spawnSync(process.execPath, [bin, 'upgrade', ...args], { encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /ARGUMENTS_INVALID/);
    }
});

test('saved plans reject outside state and parser rejects mixed selections and retired prepare', async (t) => {
    const f = await appFixture(t);
    await assert.rejects(upgradeProject({ path: f.options.target, recoverPlan: '../outside.json' }), /PLAN_OUTSIDE_STATE/);
    const bin = fileURLToPath(new URL('../bin/peanut.js', import.meta.url));
    for (const args of [['--prepare-engine'], ['--archive'], ['--plan', '--check'], ['--apply-plan', 'x', '--archive', '/x']]) {
        const result = spawnSync(process.execPath, [bin, 'upgrade', ...args], { encoding: 'utf8' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /ARGUMENTS_INVALID/);
    }
});
