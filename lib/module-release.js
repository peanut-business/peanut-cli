import { compareSemver, sha256, validateSemver } from './protocol.js';
import { isDeepStrictEqual } from 'node:util';
import { downloadDigestedAsset, listOfficialReleases, githubJson } from './release-source.js';
import { readTarArchive } from './template-package.js';

export const MODULE_REPOSITORY = 'peanut-opensource/peanut-module-code';
export const MODULE_INDEX = 'module-release-index.json';
export const officialModuleKey = (key) => /^peanut\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key);
const fail = (code) => { throw new Error(`PEANUT_MODULE_${code}`); };
const artifactTag = (value) => typeof value === 'string' && /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/.test(value);
const moduleIdentity = (row) => Object.fromEntries(['key', 'version', 'asset', 'sha256', 'bytes', 'license',
    'editions', 'kernel_constraint', 'dependencies'].map((name) => [name, row[name]]));

export function readModuleIndex(bytes, release) {
    let index;
    try { index = JSON.parse(bytes); } catch { fail('RELEASE_INDEX_INVALID'); }
    if (![1, 2].includes(index?.schema_version) || index.protocol !== `peanut.module-release-index.v${index.schema_version}`
        || index.repository !== MODULE_REPOSITORY || index.tag !== release.tag_name
        || !/^[a-f0-9]{40}$/.test(index.commit ?? '')
        || !Array.isArray(index.modules) || index.modules.length === 0 || index.modules.length > 100) fail('RELEASE_INDEX_INVALID');
    const modules = Object.create(null);
    for (const row of index.modules) {
        if (!row || !officialModuleKey(row.key) || Object.hasOwn(modules, row.key)
            || typeof row.version !== 'string' || typeof row.asset !== 'string'
            || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
            || row.asset !== row.key + '-' + row.version + '.tar'
            || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 67108864
            || row.license !== 'Apache-2.0'
            || !Array.isArray(row.editions) || row.editions.length === 0
            || row.editions.some((edition) => !['standalone', 'multi-tenant'].includes(edition))
            || new Set(row.editions).size !== row.editions.length
            || typeof row.kernel_constraint !== 'string' || !row.kernel_constraint
            || !Array.isArray(row.dependencies)
            || row.dependencies.some((dependency) => !dependency
                || typeof dependency.module_key !== 'string' || !dependency.module_key.trim()
                || typeof dependency.version !== 'string' || !dependency.version.trim())) fail('RELEASE_INDEX_INVALID');
        validateSemver(row.version);
        if (index.schema_version === 2) {
            if (!artifactTag(row.artifact_tag) || !/^[a-f0-9]{64}$/.test(row.source_sha256 ?? '')
                || (row.payload_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(row.payload_sha256))) fail('RELEASE_REFERENCE_INVALID');
        } else if (row.artifact_tag !== undefined) fail('RELEASE_REFERENCE_REQUIRES_V2');
        modules[row.key] = row;
    }
    return { ...index, modules };
}

function validateModuleRelease(release) {
    if (release?.draft !== false || typeof release.published_at !== 'string' || !release.published_at
        || typeof release.prerelease !== 'boolean') fail('RELEASE_NOT_PUBLISHED');
    if (typeof release.tag_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(release.tag_name)
        || release.html_url !== `https://github.com/${MODULE_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`
        || !Number.isSafeInteger(release.id) || release.id <= 0
        || release.url !== `https://api.github.com/repos/${MODULE_REPOSITORY}/releases/${release.id}`) fail('RELEASE_IDENTITY_INVALID');
    if (!Array.isArray(release.assets)) fail('RELEASE_INDEX_INVALID');
}

/** Preserve the exact index bytes' identity for reproducible composition selection. */
export async function publishedModuleIndex(release, fetcher = fetch) {
    validateModuleRelease(release);
    const bytes = await downloadDigestedAsset(release, MODULE_INDEX, MODULE_REPOSITORY, fetcher);
    const index = readModuleIndex(bytes, release);
    if (index.schema_version === 2 && release.immutable !== true) fail('IMMUTABLE_RELEASE_REQUIRED');
    return { index, sha256: sha256(bytes), bytes, release };
}

/** A single discovery snapshot; module versions are independent of the Release tag. */
export async function moduleCandidates(options, fetcher = fetch) {
    const candidates = new Map();
    const identities = new Map();
    for (const release of await listOfficialReleases(fetcher, MODULE_REPOSITORY)) {
        if (release?.draft !== false || typeof release.published_at !== 'string' || !release.published_at
            || typeof release.prerelease !== 'boolean') continue;
        validateModuleRelease(release);
        // Older releases without the public module index are not module candidates.
        if (!release.assets.some((asset) => asset.name === MODULE_INDEX)) continue;
        const { index } = await publishedModuleIndex(release, fetcher);
        const row = Object.hasOwn(index.modules, options.key) ? index.modules[options.key] : undefined;
        if (!row) continue;
        // Prerelease snapshots also contain stable modules; identity is independent of selection.
        const previous = identities.get(row.version);
        if (previous && previous !== row.sha256) fail('VERSION_IDENTITY_CONFLICT');
        identities.set(row.version, row.sha256);
        if ((options.version && row.version !== options.version)
            || (options.channel === 'stable' && (release.prerelease || row.version.split('+')[0].includes('-')))) continue;
        if (!candidates.has(row.version)) candidates.set(row.version, { ...row, release, commit: index.commit });
    }
    return [...candidates.values()].sort((a, b) => compareSemver(b.version, a.version));
}

/** Bind the named index entry to archive metadata. Native commands own schema and admission. */
export function verifyModuleArchive(bytes, key, candidate) {
    const files = readTarArchive(bytes);
    const moduleRoot = `server/app/modules/peanut/${key.slice(7).replaceAll('-', '_')}`;
    const manifestPath = `${moduleRoot}/module.json`;
    let manifest;
    try { manifest = JSON.parse(files.get(manifestPath)?.bytes); } catch { fail('ARCHIVE_IDENTITY_INVALID'); }
    if (manifest?.key !== key || manifest.version !== candidate.version) fail('ARCHIVE_IDENTITY_INVALID');
    const inventory = files.get('META-INF/files.sha256')?.bytes.toString('utf8');
    if (!inventory?.endsWith('\n')) fail('ARCHIVE_INVENTORY_INVALID');
    const payload = [...files.keys()].filter((name) => name !== 'META-INF/files.sha256' && !name.startsWith('META-INF/signatures/')).sort();
    const expected = payload.map((name) => `${name}\0${sha256(files.get(name).bytes)}\n`).join('');
    if (inventory !== expected) fail('ARCHIVE_INVENTORY_INVALID');
    let composer;
    try { composer = JSON.parse(files.get(`${moduleRoot}/composer.json`)?.bytes); } catch { fail('ARCHIVE_METADATA_INVALID'); }
    const editions = composer?.extra?.peanut?.editions;
    if (manifest.license !== candidate.license || manifest.kernel_constraint !== candidate.kernel_constraint
        || !isDeepStrictEqual(manifest.dependencies ?? [], candidate.dependencies)
        || !Array.isArray(editions) || !isDeepStrictEqual([...editions].sort(), [...candidate.editions].sort())) fail('ARCHIVE_METADATA_INVALID');
}

/** V2 references point directly to an original immutable official release, never arbitrary URLs.
 * A per-operation cache avoids downloading that origin index once for every Module.
 */
export async function resolveModuleArtifact(candidate, key, fetcher = fetch, cache = new Map()) {
    const tag = candidate.artifact_tag ?? candidate.release.tag_name;
    if (tag === candidate.release.tag_name) return candidate.release;
    if (!artifactTag(tag) || candidate.release.immutable !== true) fail('REFERENCE_RELEASE_INVALID');
    let origin = cache.get(tag);
    if (!origin) {
        const release = await githubJson(`https://api.github.com/repos/${MODULE_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`, fetcher);
        if (release?.tag_name !== tag || release.immutable !== true) fail('REFERENCE_RELEASE_INVALID');
        origin = await publishedModuleIndex(release, fetcher);
        cache.set(tag, origin);
    }
    const row = origin.index.modules[key];
    if (!row || !isDeepStrictEqual(moduleIdentity(row), moduleIdentity(candidate))
        || (row.artifact_tag ?? origin.index.tag) !== tag) fail('REFERENCE_IDENTITY_MISMATCH');
    return origin.release;
}

export async function downloadModule(candidate, key, fetcher = fetch, cache = new Map()) {
    const release = await resolveModuleArtifact(candidate, key, fetcher, cache);
    const bytes = await downloadDigestedAsset(release, candidate.asset, MODULE_REPOSITORY, fetcher);
    if (sha256(bytes) !== candidate.sha256) fail('INDEX_DIGEST_MISMATCH');
    if (bytes.length !== candidate.bytes) fail('INDEX_SIZE_MISMATCH');
    verifyModuleArchive(bytes, key, candidate);
    return bytes;
}
