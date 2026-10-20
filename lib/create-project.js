import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareSemver, readJsonObject, validateSemver } from './protocol.js';
import { OFFICIAL_REPOSITORY, RELEASE_API, githubJson } from './release-source.js';
import { materializeTemplate, validateTemplatePackage } from './template-package.js';

const fail = (code) => { throw new Error(`PEANUT_CREATE_${code}`); };
const MAX_DOWNLOAD = 128 * 1024 * 1024;

function safePath(input, leafMayBeMissing = false) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || path.normalize(input) !== input) fail('ABSOLUTE_PATH_REQUIRED');
    let cursor = path.parse(input).root;
    const parts = input.slice(cursor.length).split('/').filter(Boolean);
    for (const [index, part] of parts.entries()) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (!stat && leafMayBeMissing && index === parts.length - 1) return input;
        if (!stat || stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) fail('PATH_INVALID');
    }
    return input;
}

function targetPath(input) {
    const target = safePath(input, true);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || fs.readdirSync(target).length !== 0)) fail('TARGET_NOT_EMPTY');
    return target;
}

async function download(url, fetcher) {
    const response = await fetcher(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Peanut-CLI' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) fail(`DOWNLOAD_FAILED: HTTP ${response.status}`);
    if (Number(response.headers?.get('content-length')) > MAX_DOWNLOAD) fail('DOWNLOAD_TOO_LARGE');
    const chunks = [];
    let size = 0;
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > MAX_DOWNLOAD) fail('DOWNLOAD_TOO_LARGE');
                chunks.push(Buffer.from(value));
            }
        } finally { await reader.cancel(); }
        return Buffer.concat(chunks);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD) fail('DOWNLOAD_TOO_LARGE');
    return bytes;
}

async function officialPackage(options, fetcher) {
    const channel = options.channel ?? 'stable';
    if (!['stable', 'prerelease'].includes(channel)) fail('CHANNEL_INVALID');
    let release;
    if (options.ref) {
        const version = validateSemver(options.ref.replace(/^v/, ''));
        release = await githubJson(`${RELEASE_API}/tags/${encodeURIComponent('v' + version)}`, fetcher);
        if (release?.tag_name !== 'v' + version) fail('RELEASE_IDENTITY_INVALID');
    } else if (channel === 'stable') release = await githubJson(`${RELEASE_API}/latest`, fetcher);
    else {
        const releases = await githubJson(`${RELEASE_API}?per_page=100`, fetcher);
        if (!Array.isArray(releases)) fail('RELEASE_RESPONSE_INVALID');
        release = releases.filter((item) => {
            try { validateSemver(item.tag_name.slice(1)); return !item.draft && item.prerelease && item.tag_name.startsWith('v'); } catch { return false; }
        }).sort((a, b) => compareSemver(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
    }
    if (!release || release.draft || !Array.isArray(release.assets) || !release.tag_name?.startsWith('v')) fail('RELEASE_NOT_PUBLISHED');
    const version = validateSemver(release.tag_name.slice(1));
    if ((channel === 'stable' && (release.prerelease || version.includes('-')))
        || (channel === 'prerelease' && (!release.prerelease || !version.includes('-')))) fail('CHANNEL_MISMATCH');
    const asset = (extension) => {
        const name = `peanut-scaffold-${options.edition}.${extension}`;
        const found = release.assets.filter((entry) => entry.name === name);
        const expected = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
        if (found.length !== 1 || found[0].browser_download_url !== expected) fail('TEMPLATE_ASSET_MISSING_OR_INVALID');
        return expected;
    };
    const manifestBytes = await download(asset('json'), fetcher);
    let metadata;
    try { metadata = JSON.parse(manifestBytes); } catch { fail('PACKAGE_MANIFEST_INVALID'); }
    if (metadata.version !== version || metadata.source?.repository !== OFFICIAL_REPOSITORY) fail('PACKAGE_RELEASE_MISMATCH');
    const archive = await download(asset('tgz'), fetcher);
    return { metadata, archive, provenance: { repository: OFFICIAL_REPOSITORY,
        channel, requested_ref: release.tag_name, release_version: version } };
}

export async function selectTemplatePackage(options, fetcher = fetch) {
    if (!['standalone', 'multi-tenant'].includes(options.edition)) fail('EDITION_REQUIRED');
    let selected;
    if (options.archive || options.manifest) {
        if (!options.archive || !options.manifest || options.ref || options.channel) fail('LOCAL_PACKAGE_ARGUMENTS_INVALID');
        const archivePath = safePath(options.archive);
        const manifestPath = safePath(options.manifest);
        if (!fs.statSync(archivePath).isFile() || fs.statSync(archivePath).size > MAX_DOWNLOAD
            || !fs.statSync(manifestPath).isFile() || fs.statSync(manifestPath).size > 4 * 1024 * 1024) fail('LOCAL_PACKAGE_INVALID');
        const metadata = readJsonObject(manifestPath);
        selected = { metadata, archive: fs.readFileSync(archivePath), provenance: {
            repository: metadata.source?.repository, channel: 'development', requested_ref: `local:${metadata.archive?.sha256}`, release_version: null } };
    } else selected = await officialPackage(options, fetcher);
    return { ...selected, bundle: validateTemplatePackage(selected.metadata, selected.archive, options.edition) };
}

export async function createProject(options, fetcher = fetch) {
    const target = targetPath(options.target);
    const name = typeof options.name === 'string' ? options.name.trim() : '';
    if (!name || Buffer.byteLength(name) > 80 || /[\x00-\x1f\x7f{}"'`\\<>&]/.test(name)) fail('NAME_INVALID');
    if (typeof options.slug !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(options.slug) || options.slug.length > 63) fail('SLUG_INVALID');
    if (typeof options.package !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(options.package) || options.package.length > 120) fail('PACKAGE_INVALID');
    if (!['standalone', 'multi-tenant'].includes(options.edition)) fail('EDITION_REQUIRED');
    if (options.source !== undefined) fail('GIT_SOURCE_UNSUPPORTED_USE_TEMPLATE_PACKAGE');
    const selected = await selectTemplatePackage(options, fetcher);
    const bundle = selected.bundle;
    for (const key of ['profile', 'workflow']) if (options[key] !== undefined && options[key] !== selected.metadata[key]) fail('PACKAGE_PROJECTION_MISMATCH');
    const stage = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.peanut-create-`));
    const operation = randomUUID();
    try {
        const manifest = materializeTemplate(bundle, { ...options, name }, stage, selected.provenance);
        targetPath(target);
        fs.renameSync(stage, target);
        return { status: 'created', operation_id: operation, target, application: manifest.application,
            template_version: manifest.template.version, source: manifest.generation_source, package: manifest.template_package };
    } finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}

export const createDefaults = Object.freeze({ channel: 'stable' });
