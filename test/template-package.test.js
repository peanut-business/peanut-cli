import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archive, fixture } from './helpers/template-fixture.js';
import { createProject } from '../lib/create-project.js';
import { readTemplateArchive } from '../lib/template-package.js';
import { sha256 } from '../lib/protocol.js';

test('archive creation accepts absent and strictly empty targets with native-compatible baselines', async (t) => {
    for (const empty of [false, true]) {
        const { options } = fixture(t);
        if (empty) fs.mkdirSync(options.target);
        const result = await createProject(options, () => { throw new Error('must not access network'); });
        assert.equal(result.application.version, '0.1.0');
        assert.equal(result.source.channel, 'development');
        const baseline = path.join(options.target, '.peanut/scaffold-baseline/5.0.2/files/scripts/run');
        assert.equal(fs.statSync(baseline).mode & 0o777, 0o644);
        assert.equal(fs.statSync(path.join(options.target, 'scripts/run')).mode & 0o777, 0o755);
        const app = JSON.parse(fs.readFileSync(path.join(options.target, '.peanut/application-manifest.json')));
        assert.equal(app.files.find((file) => file.path === 'scripts/run').baseline_mode, 0o755);
        assert.equal(fs.readFileSync(path.join(options.target, 'README.md'), 'utf8'), '# 业务系统\n');
        const catalog = JSON.parse(fs.readFileSync(path.join(options.target, 'server/generated/api-catalog.json')));
        assert.equal(catalog.inputs[0].sha256, sha256(fs.readFileSync(path.join(options.target, 'server/composer.json'))));
    }
});

test('nonempty, hidden Git, symlink and wrong-digest inputs preserve targets', async (t) => {
    for (const kind of ['hidden', 'git', 'symlink', 'digest']) {
        const { root, options } = fixture(t);
        fs.mkdirSync(options.target);
        if (kind === 'hidden' || kind === 'git') fs.writeFileSync(path.join(options.target, kind === 'git' ? '.git' : '.keep'), 'preserve');
        if (kind === 'symlink') { fs.rmdirSync(options.target); fs.symlinkSync(root, options.target); }
        if (kind === 'digest') fs.appendFileSync(options.archive, 'corrupt');
        await assert.rejects(createProject(options));
        assert.equal(fs.readdirSync(root).some((name) => name.includes('.peanut-create-')), false);
        assert.equal(fs.existsSync(options.target), true);
    }
});

test('safe archive reader rejects links, traversal, duplicates and file-parent conflicts', () => {
    for (const entries of [
        [['../escape', Buffer.from('x')]], [['link', Buffer.alloc(0), 0o644, '2']],
        [['same', Buffer.alloc(0)], ['same', Buffer.alloc(0)]],
        [['Case', Buffer.alloc(0)], ['case', Buffer.alloc(0)]],
        [['parent', Buffer.alloc(0)], ['parent/child', Buffer.alloc(0)]],
    ]) assert.throws(() => readTemplateArchive(archive(entries)));
});

test('self-consistent package with false source identity is rejected before staging', async (t) => {
    const { root, options } = fixture(t, ({ app }) => { app.template.source_tree = 'e'.repeat(40); });
    await assert.rejects(createProject(options), /SOURCE_IDENTITY_INVALID/);
    assert.equal(fs.existsSync(options.target), false);
    assert.equal(fs.readdirSync(root).some((name) => name.includes('.peanut-create-')), false);
});

test('official stable creation uses exact Edition attachments and records the published source', async (t) => {
    const { options } = fixture(t);
    const metadata = fs.readFileSync(options.manifest);
    const payload = fs.readFileSync(options.archive);
    delete options.manifest;
    delete options.archive;
    const prefix = 'https://github.com/peanut-business/peanut-admin-code/releases/download/v5.0.2/';
    const urls = [];
    const fetcher = async (url) => {
        urls.push(url);
        if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v5.0.2', draft: false, prerelease: false,
            assets: ['json', 'tgz'].map((ext) => ({ name: `peanut-scaffold-standalone.${ext}`,
                browser_download_url: prefix + `peanut-scaffold-standalone.${ext}` })) });
        if (url === prefix + 'peanut-scaffold-standalone.json') return new Response(metadata);
        if (url === prefix + 'peanut-scaffold-standalone.tgz') return new Response(payload);
        throw new Error('Unexpected source: ' + url);
    };
    const result = await createProject(options, fetcher);
    assert.equal(result.source.channel, 'stable');
    assert.equal(result.source.release_version, '5.0.2');
    assert.equal(result.source.requested_ref, 'v5.0.2');
    assert.equal(result.package.source, 'official');
    assert.equal(urls.length, 3);
});
