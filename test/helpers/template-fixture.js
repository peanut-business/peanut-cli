import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { sha256 } from '../../lib/protocol.js';

const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
export function archive(entries) {
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

export function fixture(t, mutate = () => {}, extraMembers = []) {
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
        ...files.map((file) => [file.source, payload.get(file.path), file.mode]), ...extraMembers]);
    const metadata = { schema_version: 1, protocol: 'peanut.template-package.v1', kind: 'scaffold-template', version: '5.0.2',
        edition: 'standalone', profile: 'full', workflow: 'runtime', source,
        archive: { name: 'peanut-scaffold-standalone.tgz', bytes: packed.length, sha256: sha256(packed) },
        create_manifest_sha256: sha256(createBytes), scaffold_manifest_sha256: sha256(releaseBytes) };
    const tooling = extraMembers.find(([name]) => name === 'upgrade-tooling.json');
    if (tooling) metadata.upgrade_tooling_sha256 = sha256(tooling[1]);
    const packagePath = path.join(root, 'template.tgz'), manifestPath = path.join(root, 'template.json');
    fs.writeFileSync(packagePath, packed); fs.writeFileSync(manifestPath, encode(metadata));
    return { root, options: { target: path.join(root, 'target'), name: '业务系统', slug: 'business', package: 'example/business',
        edition: 'standalone', archive: packagePath, manifest: manifestPath } };
}
