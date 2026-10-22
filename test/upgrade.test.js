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
        const inventory = Buffer.from(JSON.stringify({ revision }) + '\n');
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

test('development successor requires explicit fixed ancestry and checks remain read-only', async (t) => {
    const f = await developmentFixture(t);
    const before = fs.readFileSync(f.manifestPath);
    const result = await upgradeProject({ ...f.upgrade, check: true }, offline);
    assert.equal(result.status, 'available');
    assert.equal(result.source_relation.kind, 'development_successor');
    assert.equal(result.source_relation.base.commit, f.base.commit);
    assert.equal(result.source_relation.target.commit, f.target.commit);
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
        (app) => { app.application.profile = 'standard'; },
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
