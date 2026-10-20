import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { relativePath, sha256, validateSemver } from './protocol.js';

const fail = (code) => { throw new Error(`PEANUT_TEMPLATE_${code}`); };
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const json = (bytes) => {
    try { return JSON.parse(bytes.toString('utf8')); } catch { return fail('JSON_INVALID'); }
};
const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Accept only canonical regular USTAR members. No extraction subprocess, links,
// extension headers, implicit directories, or undeclared archive members exist.
export function readTemplateArchive(bytes) {
    if (bytes.length > MAX_ARCHIVE) fail('ARCHIVE_TOO_LARGE');
    let tar;
    try { tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }); } catch { fail('ARCHIVE_INVALID'); }
    const files = new Map();
    const names = new Set();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const string = (buffer) => {
        const end = buffer.indexOf(0);
        if (end >= 0 && buffer.subarray(end).some((byte) => byte !== 0)) fail('HEADER_INVALID');
        try { return decoder.decode(end < 0 ? buffer : buffer.subarray(0, end)); } catch { return fail('PATH_ENCODING'); }
    };
    const octal = (buffer) => {
        const text = buffer.toString('ascii').replace(/[\0 ]+$/g, '').replace(/^ +/, '');
        if (!/^[0-7]+$/.test(text)) fail('HEADER_INVALID');
        return Number.parseInt(text, 8);
    };
    let offset = 0;
    for (; offset + 512 <= tar.length; ) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const checksum = octal(header.subarray(148, 156));
        const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (checksum !== actual || header.subarray(257, 263).toString('ascii') !== 'ustar\0'
            || ![0, 48].includes(header[156])) fail('MEMBER_TYPE_INVALID');
        const prefix = string(header.subarray(345, 500));
        const name = relativePath((prefix ? prefix + '/' : '') + string(header.subarray(0, 100)));
        if (name.split('/').some((part) => part.endsWith('.') || part.endsWith(' ') || part.includes(':'))
            || names.has(name.toLowerCase()) || files.size >= 100000) fail('MEMBER_DUPLICATE_OR_UNSAFE');
        names.add(name.toLowerCase());
        const mode = octal(header.subarray(100, 108));
        const size = octal(header.subarray(124, 136));
        if (![0o644, 0o755].includes(mode) || size > 64 * 1024 * 1024 || size > tar.length - offset - 512) fail('MEMBER_BOUNDS');
        files.set(name, { bytes: tar.subarray(offset + 512, offset + 512 + size), mode });
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (tar.length - offset < 1024 || tar.subarray(offset).some((byte) => byte !== 0)) fail('TRAILER_INVALID');
    for (const name of files.keys()) {
        let parent = path.posix.dirname(name);
        while (parent !== '.') {
            if (names.has(parent.toLowerCase())) fail('MEMBER_FILE_DIRECTORY_CONFLICT');
            parent = path.posix.dirname(parent);
        }
    }
    return files;
}

export function validateTemplatePackage(metadata, archive, edition) {
    if (metadata?.protocol !== 'peanut.template-package.v1' || metadata.schema_version !== 1
        || metadata.kind !== 'scaffold-template' || metadata.edition !== edition
        || metadata.archive?.name !== `peanut-scaffold-${edition}.tgz`
        || metadata.archive.bytes !== archive.length || !digest(metadata.archive.sha256)
        || sha256(archive) !== metadata.archive.sha256) fail('PACKAGE_IDENTITY_INVALID');
    validateSemver(metadata.version);
    const members = readTemplateArchive(archive);
    const createBytes = members.get('template-create.json')?.bytes;
    const releaseBytes = members.get('scaffold-manifest.json')?.bytes;
    if (!createBytes || !releaseBytes || sha256(createBytes) !== metadata.create_manifest_sha256
        || sha256(releaseBytes) !== metadata.scaffold_manifest_sha256) fail('MANIFEST_DIGEST_INVALID');
    const create = json(createBytes);
    const release = json(releaseBytes);
    const app = create.application_manifest;
    if (create.protocol !== 'peanut.template-create.v1' || create.schema_version !== 1
        || release.protocol !== 'peanut.scaffold-release.v3' || release.release.version !== metadata.version
        || release.edition?.name !== edition || app?.application?.edition !== edition
        || app.application.profile !== metadata.profile || app.application.workflow !== metadata.workflow
        || !isDeepStrictEqual(metadata.source, app.generation_source)
        || !isDeepStrictEqual(create.tokens, release.release.tokens)
        || create.scaffold_manifest_sha256 !== metadata.scaffold_manifest_sha256
        || !Array.isArray(create.files) || !Array.isArray(app.files) || !Array.isArray(create.directories)
        || create.derived?.composer_lock !== 'server/composer.lock'
        || create.derived.api_catalog !== 'server/generated/api-catalog.json') fail('MANIFEST_IDENTITY_INVALID');
    const identity = release.release;
    if (app.protocol !== 'peanut.application-scaffold.v2' || app.schema_version !== 2
        || app.template?.version !== metadata.version || app.template.source_commit !== identity.source_commit
        || app.template.source_tree !== identity.source_tree || app.template.inventory_sha256 !== identity.inventory_sha256
        || app.generation_source.commit !== identity.source_commit || app.generation_source.tree !== identity.source_tree
        || app.generation_source.inventory_sha256 !== identity.inventory_sha256
        || !/^[a-f0-9]{40}$/.test(identity.source_commit) || !/^[a-f0-9]{40}$/.test(identity.source_tree)
        || !digest(identity.inventory_sha256) || !digest(app.generation_source.edition_profile_sha256)
        || !isDeepStrictEqual(app.edition, release.edition)) fail('SOURCE_IDENTITY_INVALID');
    validateSemver(release.application?.version);
    const declared = new Map();
    const upgrades = new Map();
    for (const [entries, map] of [[app.files, declared], [release.files, upgrades]]) {
        if (!Array.isArray(entries)) fail('FILE_SET_INVALID');
        for (const entry of entries) {
            relativePath(entry.path);
            if (map.has(entry.path)) fail('FILE_SET_DUPLICATE');
            map.set(entry.path, entry);
        }
    }
    const expected = new Set(['template-create.json', 'scaffold-manifest.json']);
    const paths = new Set();
    for (const file of create.files) {
        relativePath(file.path);
        relativePath(file.source);
        const source = `${file.classification === 'app-owned' ? 'defaults' : 'files'}/${file.path}`;
        if (file.source !== source || file.path.startsWith('.peanut/') || paths.has(file.path.toLowerCase())
            || !['managed', 'generated-managed', 'app-owned'].includes(file.classification)
            || typeof file.render !== 'boolean' || !digest(file.sha256)) fail('FILE_DECLARATION_INVALID');
        paths.add(file.path.toLowerCase());
        expected.add(file.source);
        const member = members.get(file.source);
        if (!member || member.mode !== file.mode || sha256(member.bytes) !== file.sha256) fail('FILE_DIGEST_INVALID');
        const recorded = declared.get(file.path);
        if (!recorded || recorded.sha256 !== file.sha256 || recorded.classification !== file.classification
            || recorded.mode !== file.mode) fail('APPLICATION_FILES_INVALID');
        const frozen = /^(?:server\/app\/modules|(?:web|platform|uniapp)\/src\/modules|pc\/modules|plugins)\//.test(file.path) || file.path === 'plugins.lock';
        if (frozen && (file.render || Object.values(create.tokens).some((token) => member.bytes.includes(Buffer.from(token)))
            || /\{\{(?:PRODUCT_NAME|SLUG|PACKAGE_IDENTITY|APPLICATION_VERSION)\}\}/.test(member.bytes.toString('utf8')))) fail('MODULE_IDENTITY_MUTABLE');
        if (file.classification !== 'app-owned') {
            const upgrade = upgrades.get(file.path);
            if (!upgrade || upgrade.source !== file.source || upgrade.template_sha256 !== file.sha256
                || upgrade.classification !== file.classification || upgrade.mode !== file.mode) fail('UPGRADE_FILES_INVALID');
        }
    }
    if (create.files.length !== [...declared.values()].filter((entry) => entry.classification !== 'excluded').length
        || upgrades.size !== create.files.filter((entry) => entry.classification !== 'app-owned').length) fail('FILE_SET_MISMATCH');
    if (members.size !== expected.size || [...members.keys()].some((name) => !expected.has(name))) fail('UNDECLARED_MEMBER');
    for (const directory of create.directories) {
        relativePath(directory);
        if (!/^server\/(?:runtime\/|private\/(?:storage$|installation$|resources\/pending$)|public\/storage$)/.test(directory)) fail('DIRECTORY_INVALID');
    }
    return { metadata, create, release, members };
}

function phpJson(value) {
    return JSON.stringify(value).replaceAll('/', '\\/').replace(/[\u007f-\uffff]/g,
        (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

function renderComposerLock(lock, composerBytes) {
    const composer = json(composerBytes);
    const relevant = {};
    const keys = ['name', 'version', 'require', 'require-dev', 'conflict', 'replace', 'provide',
        'minimum-stability', 'prefer-stable', 'repositories', 'extra'];
    const selected = Object.fromEntries(keys.filter((key) => Object.hasOwn(composer, key)).map((key) => [key, composer[key]]));
    if (composer.config?.platform) selected.config = { platform: composer.config.platform };
    for (const key of Object.keys(selected).sort()) relevant[key] = selected[key];
    const hash = createHash('md5').update(phpJson(relevant)).digest('hex');
    const original = json(lock);
    const result = lock.toString('utf8').replace(/^(\s*"content-hash"\s*:\s*")[a-f0-9]{32}("[,\s]*)$/m, `$1${hash}$2`);
    if (!isDeepStrictEqual(json(Buffer.from(result)), { ...original, 'content-hash': hash })) fail('COMPOSER_LOCK_INVALID');
    return Buffer.from(result);
}

export function materializeTemplate(bundle, options, stage, provenance) {
    const { metadata, create, release, members } = bundle;
    const values = { product_name: options.name, slug: options.slug, package_identity: options.package,
        application_version: options.applicationVersion ?? release.application.version };
    validateSemver(values.application_version);
    const pairs = Object.entries(create.tokens);
    if (pairs.length !== 4 || pairs.some(([key, token]) => !Object.hasOwn(values, key) || typeof token !== 'string' || token.length < 8)) fail('TOKENS_INVALID');
    const replace = (text) => text.replace(new RegExp(pairs.map(([, token]) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
        (token) => values[pairs.find(([, source]) => token === source)[0]]);
    const write = (relative, bytes, mode = 0o644) => {
        const file = path.join(stage, relativePath(relative));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { flag: 'wx', mode });
        fs.chmodSync(file, mode);
    };
    const rendered = new Map();
    for (const file of create.files) {
        let bytes = members.get(file.source).bytes;
        if (file.render) bytes = Buffer.from(replace(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        rendered.set(file.path, bytes);
    }
    const lockPath = create.derived.composer_lock;
    rendered.set(lockPath, renderComposerLock(rendered.get(lockPath), rendered.get('server/composer.json')));
    const catalogPath = create.derived.api_catalog;
    const catalog = json(rendered.get(catalogPath));
    if (!Array.isArray(catalog.inputs)) fail('API_INPUTS_INVALID');
    for (const input of catalog.inputs) {
        relativePath(input.path);
        if (!rendered.has(input.path)) fail('API_INPUT_MISSING');
        input.sha256 = sha256(rendered.get(input.path));
    }
    rendered.set(catalogPath, encode(catalog));
    const manifest = structuredClone(create.application_manifest);
    Object.assign(manifest.application, { name: values.product_name, slug: values.slug,
        package_identity: values.package_identity, version: values.application_version });
    manifest.generation_source = { ...manifest.generation_source, ...provenance };
    manifest.template_package = { protocol: metadata.protocol, version: metadata.version,
        archive_sha256: metadata.archive.sha256, source: provenance.channel === 'development' ? 'local' : 'official' };
    const baselineRoot = relativePath(manifest.ownership.baseline_root);
    if (baselineRoot !== `.peanut/scaffold-baseline/${manifest.template.version}/files`) fail('BASELINE_PATH_INVALID');
    for (const file of create.files) {
        const bytes = rendered.get(file.path);
        write(file.path, bytes, file.mode);
        const entry = manifest.files.find((item) => item.path === file.path);
        entry.sha256 = sha256(bytes);
        if (file.classification !== 'app-owned') {
            entry.baseline_path = `${baselineRoot}/${file.path}`;
            entry.baseline_sha256 = entry.sha256;
            write(entry.baseline_path, bytes, 0o644);
        }
    }
    const treeDigest = (classes) => sha256(manifest.files.filter((file) => classes.includes(file.classification))
        .map((file) => `${file.path}\0${file.sha256}`).sort().join('\n'));
    manifest.digests = { managed_tree_sha256: treeDigest(['managed', 'generated-managed']), app_owned_tree_sha256: treeDigest(['app-owned']) };
    write('.peanut/application-manifest.json', encode(manifest));
    for (const directory of create.directories) fs.mkdirSync(path.join(stage, directory), { recursive: true, mode: 0o775 });
    return manifest;
}
