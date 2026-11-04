import { sha256, validateSemver } from './protocol.js';
import { isDeepStrictEqual } from 'node:util';

export const OFFICIAL_REPOSITORY = 'peanut-business/peanut-admin-code';
export const OFFICIAL_SOURCE = `https://github.com/${OFFICIAL_REPOSITORY}.git`;
export const RELEASE_API = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases`;
const sha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fail = (code) => { throw new Error(code); };

export function officialSource(source) {
    return [OFFICIAL_SOURCE, `https://github.com/${OFFICIAL_REPOSITORY}`, `git@github.com:${OFFICIAL_REPOSITORY}.git`].includes(source);
}

export async function githubJson(url, fetcher = fetch, binary = false) {
    const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Peanut-CLI' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) fail(`PEANUT_RELEASE_DOWNLOAD_FAILED: HTTP ${response.status}: ${url}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

/** Only v-prefixed product versions participate in official discovery. */
export function officialReleaseVersion(release) {
    if (typeof release?.tag_name !== 'string' || !release.tag_name.startsWith('v')) return null;
    try { return validateSemver(release.tag_name.slice(1)); } catch { return null; }
}

/** Exhaust bounded discovery before choosing a version; a full final page is incomplete. */
export async function listOfficialReleases(fetcher = fetch) {
    const releases = [];
    for (let page = 1; page <= 20; page += 1) {
        const batch = await githubJson(`${RELEASE_API}?per_page=100&page=${page}`, fetcher);
        if (!Array.isArray(batch) || batch.length > 100) fail('PEANUT_RELEASE_RESPONSE_INVALID');
        releases.push(...batch);
        if (batch.length < 100) return releases;
    }
    fail('PEANUT_RELEASE_DISCOVERY_LIMIT');
}

export function assetUrl(release, name) {
    const assets = release.assets?.filter((item) => item.name === name);
    const expected = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
    if (assets?.length !== 1 || assets[0].browser_download_url !== expected) fail(`PEANUT_RELEASE_ASSET_INVALID: ${name}`);
    return expected;
}

/** Bind the selected attachment bytes to the current publisher's manifest/lock protocol.
 * Discovery happens once in the caller; no tag re-resolution or raw scaffold fallback.
 */
export function validatePublishedTemplate(release, manifestBytes, lockBytes, metadataBytes, archive, edition) {
    const version = validateSemver(release.tag_name.slice(1));
    const tag = `v${version}`;
    if (release.draft || release.tag_name !== tag || !Array.isArray(release.assets)
        || release.prerelease !== version.includes('-')) fail('PEANUT_RELEASE_NOT_PUBLISHED');
    let manifest, lock, metadata;
    try {
        manifest = JSON.parse(manifestBytes);
        lock = JSON.parse(lockBytes);
        metadata = JSON.parse(metadataBytes);
    } catch { fail('PEANUT_RELEASE_IDENTITY_INVALID'); }
    const templates = manifest?.template_artifacts;
    if (manifest?.schema_version !== 1 || manifest.version !== version || manifest.tag !== tag
        || manifest.repository !== `https://github.com/${OFFICIAL_REPOSITORY}`
        || manifest.candidate_lock?.path !== 'RELEASE_CANDIDATE_LOCK.json'
        || manifest.candidate_lock.sha256 !== sha256(lockBytes)
        || lock?.schema_version !== 1 || lock.protocol !== 'peanut.release-candidate-lock.v1' || lock.version !== version || lock.tag !== tag
        || !sha(lock.candidate?.commit) || !sha(lock.candidate?.tree) || !digest(lock.inputs?.application_template_inventory_sha256)
        || manifest.commit !== lock.candidate.commit
        || templates?.protocol !== 'peanut.template-release-inputs.v1' || templates.version !== version
        || !isDeepStrictEqual(templates, lock.template_artifacts)
        || lock.inputs.template_artifacts_sha256 !== sha256(JSON.stringify(templates))
        || templates.source?.commit !== lock.candidate.commit || templates.source?.tree !== lock.candidate.tree
        || templates.source?.inventory_sha256 !== lock.inputs.application_template_inventory_sha256
        || metadata?.version !== version || metadata.source?.repository !== OFFICIAL_REPOSITORY
        || metadata.source.commit !== lock.candidate.commit || metadata.source.tree !== lock.candidate.tree
        || metadata.source.inventory_sha256 !== lock.inputs.application_template_inventory_sha256) fail('PEANUT_RELEASE_IDENTITY_INVALID');
    const entry = templates.editions?.[edition];
    const name = `peanut-scaffold-${edition}`;
    if (metadata.edition !== edition || entry?.archive !== name + '.tgz' || entry.manifest !== name + '.json'
        || entry.profile !== metadata.profile || entry.workflow !== metadata.workflow
        || ['scaffold_manifest_sha256', 'create_manifest_sha256', 'upgrade_tooling_sha256'].some((key) =>
            !digest(metadata[key]) || entry[key] !== metadata[key])) fail('PEANUT_RELEASE_TEMPLATE_BINDING_INVALID');
    for (const [asset, bytes] of [[name + '.json', metadataBytes], [name + '.tgz', archive], ['RELEASE_CANDIDATE_LOCK.json', lockBytes]]) {
        const row = manifest.artifacts?.[asset];
        if (row?.size_bytes !== bytes.length || row.sha256 !== sha256(bytes)
            || (asset !== 'RELEASE_CANDIDATE_LOCK.json' && !isDeepStrictEqual(row, templates.assets?.[asset]))) {
            fail('PEANUT_RELEASE_ASSET_BINDING_INVALID');
        }
    }
    return { metadata, candidate_lock_sha256: sha256(lockBytes) };
}
