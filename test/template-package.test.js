import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createProject } from '../lib/create-project.js';
import { readTemplateArchive } from '../lib/template-package.js';
import { sha256 } from '../lib/protocol.js';

const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
function archive(entries) {
    const chunks = [];
    for (const [name, bytes, mode = 0o644, type = '0'] of entries) {
        const header = Buffer.alloc(512);
        header.write(name, 0, 100);
        for (const [offset, length, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]])
            header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset);
        header.fill(32, 148, 156);
        header.write(type, 156);
        header.write('ustar\0', 257);
        header.write('00', 263);
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
        chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function fixture(t, mutate = () => {}) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'peanut-template-unit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tokens = { product_name: 'Scaffold Product Token', slug: 'scaffold-product-token',
        package_identity: 'scaffold-vendor-token/scaffold-package-token', application_version: '999999.999999.999999' };
    const payload = new Map([
        ['README.md', Buffer.from('# Scaffold Product Token\n')],
        ['server/composer.json', encode({ name: tokens.package_identity, require: { php: '^8.3' } })],
        ['server/composer.lock', encode({ 'content-hash': '0'.repeat(32), packages: [] })],
        ['server/generated/api-catalog.json', encode({ inputs: [{ path: 'server/composer.json', sha256: '0'.repeat(64) }] })],
        ['scripts/run', Buffer.from('#!/bin/sh\nexit 0\n')],
        ['server/config/peanut.php', Buffer.from('<?php return [];\n')],
    ]);
    const source = { repository: 'peanut-business/peanut-admin-code', requested_ref: 'HEAD', channel: 'development', release_version: null,
        commit: 'a'.repeat(40), tree: 'b'.repeat(40), inventory_sha256: 'c'.repeat(64), edition_profile_sha256: 'd'.repeat(64) };
    const files = [...payload].map(([name, bytes]) => ({ path: name, source: `${name.includes('/config/') ? 'defaults' : 'files'}/${name}`,
        mode: name === 'scripts/run' ? 0o755 : 0o644, classification: name.includes('/config/') ? 'app-owned' : 'managed',
        sha256: sha256(bytes), render: Object.values(tokens).some((token) => bytes.includes(Buffer.from(token))) }));
    const app = { schema_version: 2, protocol: 'peanut.application-scaffold.v2',
        application: { name: tokens.product_name, slug: tokens.slug, package_identity: tokens.package_identity,
            version: tokens.application_version, edition: 'standalone', profile: 'full', workflow: 'runtime' },
        edition: { name: 'standalone' }, template: { version: '5.0.2', source_commit: source.commit, source_tree: source.tree, inventory_sha256: source.inventory_sha256 },
        generation_source: source, ownership: { baseline_root: '.peanut/scaffold-baseline/5.0.2/files' },
        files: files.map(({ source: _, render: __, ...entry }) => entry) };
    const release = { schema_version: 3, protocol: 'peanut.scaffold-release.v3', application: { version: '0.1.0' },
        edition: app.edition, release: { version: '5.0.2', source_commit: source.commit, source_tree: source.tree, inventory_sha256: source.inventory_sha256, tokens },
        files: files.filter((file) => file.classification !== 'app-owned').map((file) => ({ ...file, template_sha256: file.sha256 })) };
    const create = { schema_version: 1, protocol: 'peanut.template-create.v1', tokens, application_manifest: app,
        files, directories: ['server/runtime/cache'], scaffold_manifest_sha256: sha256(encode(release)),
        derived: { composer_lock: 'server/composer.lock', api_catalog: 'server/generated/api-catalog.json' } };
    mutate({ create, release, app, files });
    const createBytes = encode(create), releaseBytes = encode(release);
    const packed = archive([['template-create.json', createBytes], ['scaffold-manifest.json', releaseBytes],
        ...files.map((file) => [file.source, payload.get(file.path), file.mode])]);
    const metadata = { schema_version: 1, protocol: 'peanut.template-package.v1', kind: 'scaffold-template', version: '5.0.2',
        edition: 'standalone', profile: 'full', workflow: 'runtime', source,
        archive: { name: 'peanut-scaffold-standalone.tgz', bytes: packed.length, sha256: sha256(packed) },
        create_manifest_sha256: sha256(createBytes), scaffold_manifest_sha256: sha256(releaseBytes) };
    const packagePath = path.join(root, 'template.tgz'), manifestPath = path.join(root, 'template.json');
    fs.writeFileSync(packagePath, packed); fs.writeFileSync(manifestPath, encode(metadata));
    return { root, options: { target: path.join(root, 'target'), name: '业务系统', slug: 'business', package: 'example/business',
        edition: 'standalone', archive: packagePath, manifest: manifestPath } };
}

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
