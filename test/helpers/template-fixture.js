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
    const metadata = { schema_version: 1, protocol: 'peanut.template-package.v1', kind: 'scaffold-template', version: release.release.version,
        edition: app.application.edition, profile: app.application.profile, workflow: app.application.workflow, source,
        archive: { name: `peanut-scaffold-${app.application.edition}.tgz`, bytes: packed.length, sha256: sha256(packed) },
        create_manifest_sha256: sha256(createBytes), scaffold_manifest_sha256: sha256(releaseBytes) };
    const tooling = extraMembers.find(([name]) => name === 'upgrade-tooling.json');
    if (tooling) metadata.upgrade_tooling_sha256 = sha256(tooling[1]);
    const packagePath = path.join(root, 'template.tgz'), manifestPath = path.join(root, 'template.json');
    fs.writeFileSync(packagePath, packed); fs.writeFileSync(manifestPath, encode(metadata));
    return { root, options: { target: path.join(root, 'target'), name: '业务系统', slug: 'business', package: 'example/business',
        edition: app.application.edition, archive: packagePath, manifest: manifestPath } };
}

/** Current publisher's public manifest/lock shape, backed by a real synthetic package. */
export function officialFixture(t, { edition = 'standalone', version = '5.0.2', sourceCommit = 'a'.repeat(40) } = {}) {
    const toolingFiles = [
        ['tooling/composer.json', Buffer.from('{}')],
        ['tooling/composer.lock', Buffer.from('{"packages":[]}')],
        ['tooling/vendor/composer/installed.json', Buffer.from('{"dev":false,"packages":[]}')],
        ['tooling/vendor/autoload.php', Buffer.from('<?php return null;')],
    ];
    const tooling = { protocol: 'peanut.scaffold-upgrade-tooling.v1', autoload: 'tooling/vendor/autoload.php',
        composer_lock_sha256: sha256(toolingFiles[1][1]), packages: [],
        files: toolingFiles.map(([name, bytes]) => ({ path: name, sha256: sha256(bytes), mode: 0o644 })) };
    const build = (selectedEdition) => fixture(t, ({ app, release, create }) => {
        app.application.edition = selectedEdition;
        app.edition.name = selectedEdition;
        app.template.version = version;
        app.ownership.baseline_root = `.peanut/scaffold-baseline/${version}/files`;
        app.template.source_commit = sourceCommit;
        app.generation_source.commit = sourceCommit;
        release.release.version = version;
        release.release.source_commit = sourceCommit;
        release.release.workflow = app.application.workflow;
        create.scaffold_manifest_sha256 = sha256(encode(release));
    }, [...toolingFiles, ['upgrade-tooling.json', encode(tooling)]]);
    const f = build(edition);
    const metadataBytes = fs.readFileSync(f.options.manifest);
    const metadata = JSON.parse(metadataBytes);
    const archiveBytes = fs.readFileSync(f.options.archive);
    const name = `peanut-scaffold-${edition}`;
    const assets = {
        [name + '.tgz']: { size_bytes: archiveBytes.length, sha256: sha256(archiveBytes) },
        [name + '.json']: { size_bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
    };
    const templates = { protocol: 'peanut.template-release-inputs.v1', version,
        source: { commit: metadata.source.commit, tree: metadata.source.tree, inventory_sha256: metadata.source.inventory_sha256 },
        editions: { [edition]: { archive: name + '.tgz', manifest: name + '.json', profile: metadata.profile, workflow: metadata.workflow,
            scaffold_manifest_sha256: metadata.scaffold_manifest_sha256, create_manifest_sha256: metadata.create_manifest_sha256,
            upgrade_tooling_sha256: metadata.upgrade_tooling_sha256 } }, assets };
    const otherEdition = edition === 'standalone' ? 'multi-tenant' : 'standalone';
    const other = build(otherEdition);
    const otherMetadataBytes = fs.readFileSync(other.options.manifest);
    const otherArchiveBytes = fs.readFileSync(other.options.archive);
    const otherMetadata = JSON.parse(otherMetadataBytes);
    const otherName = `peanut-scaffold-${otherEdition}`;
    assets[otherName + '.tgz'] = { size_bytes: otherArchiveBytes.length, sha256: sha256(otherArchiveBytes) };
    assets[otherName + '.json'] = { size_bytes: otherMetadataBytes.length, sha256: sha256(otherMetadataBytes) };
    templates.editions[otherEdition] = { ...templates.editions[edition],
        archive: otherName + '.tgz', manifest: otherName + '.json',
        scaffold_manifest_sha256: otherMetadata.scaffold_manifest_sha256,
        create_manifest_sha256: otherMetadata.create_manifest_sha256,
        upgrade_tooling_sha256: otherMetadata.upgrade_tooling_sha256 };
    const tag = 'v' + version;
    const lock = { schema_version: 1, protocol: 'peanut.release-candidate-lock.v1', version, tag,
        candidate: { commit: metadata.source.commit, tree: metadata.source.tree }, template_artifacts: structuredClone(templates),
        inputs: { application_template_inventory_sha256: metadata.source.inventory_sha256,
            template_artifacts_sha256: sha256(JSON.stringify(templates)) } };
    const manifest = { schema_version: 1, version, tag, repository: 'https://github.com/peanut-business/peanut-admin-code',
        commit: metadata.source.commit, template_artifacts: templates, artifacts: { ...assets },
        candidate_lock: { path: 'RELEASE_CANDIDATE_LOCK.json', sha256: '' } };
    const base = `https://github.com/peanut-business/peanut-admin-code/releases/download/${encodeURIComponent(tag)}/`;
    const bytes = new Map([[name + '.json', metadataBytes], [name + '.tgz', archiveBytes],
        [otherName + '.json', otherMetadataBytes], [otherName + '.tgz', otherArchiveBytes]]);
    // Explicit reseal lets negatives change a semantic field while retaining all outer digests.
    function seal() {
        const lockBytes = encode(lock);
        bytes.set('RELEASE_CANDIDATE_LOCK.json', lockBytes);
        manifest.candidate_lock.sha256 = sha256(lockBytes);
        manifest.artifacts['RELEASE_CANDIDATE_LOCK.json'] = { size_bytes: lockBytes.length, sha256: sha256(lockBytes) };
        bytes.set('RELEASE_MANIFEST.json', encode(manifest));
    }
    seal();
    const release = { tag_name: tag, draft: false, prerelease: version.includes('-'),
        assets: [...bytes.keys()].map((name) => ({ name, browser_download_url: base + name })) };
    const calls = [];
    async function fetcher(url) {
        calls.push(url);
        const api = 'https://api.github.com/repos/peanut-business/peanut-admin-code/releases';
        if (url === api + '/latest' || url === api + '/tags/' + encodeURIComponent(tag)) return { ok: true, json: async () => structuredClone(release) };
        if (url === api + '?per_page=100' || url === api + '?per_page=100&page=1') return { ok: true, json: async () => [structuredClone(release)] };
        if (url === `https://api.github.com/repos/peanut-business/peanut-admin-code/compare/${metadata.source.commit}...${metadata.source.commit}`) {
            return { ok: true, json: async () => ({ status: 'identical', base_commit: { sha: metadata.source.commit }, merge_base_commit: { sha: metadata.source.commit } }) };
        }
        if (url.startsWith(base) && bytes.has(url.slice(base.length))) return { ok: true, arrayBuffer: async () => bytes.get(url.slice(base.length)) };
        throw new Error('unexpected network: ' + url);
    }
    const { archive: _, manifest: __, ...options } = f.options;
    return { ...f, options, metadata, release, manifest, lock, templates, bytes, calls, fetcher, seal };
}
