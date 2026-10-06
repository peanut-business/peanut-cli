import { sha256, validateSemver } from './protocol.js';

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

function assetUrl(release, name) {
    const asset = release.assets?.find((item) => item.name === name);
    const expected = `https://github.com/${OFFICIAL_REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
    if (asset?.browser_download_url !== expected) fail(`PEANUT_RELEASE_ASSET_INVALID: ${name}`);
    return expected;
}

/** Resolve a published official release and its SHA-bound immutable source lock. */
export async function publishedSource(versionInput, fetcher = fetch) {
    const version = validateSemver(versionInput.replace(/^v/, ''));
    const tag = `v${version}`;
    const release = await githubJson(`${RELEASE_API}/tags/${encodeURIComponent(tag)}`, fetcher);
    if (release?.draft || release?.tag_name !== tag || !Array.isArray(release.assets)
        || release.prerelease !== version.includes('-')) fail('PEANUT_RELEASE_NOT_PUBLISHED');
    const manifestUrl = assetUrl(release, 'RELEASE_MANIFEST.json');
    const lockUrl = assetUrl(release, 'RELEASE_CANDIDATE_LOCK.json');
    const manifest = await githubJson(manifestUrl, fetcher);
    const lockBytes = await githubJson(lockUrl, fetcher, true);
    let lock;
    try { lock = JSON.parse(lockBytes); } catch { fail('PEANUT_RELEASE_IDENTITY_INVALID'); }
    if (manifest?.schema_version !== 1 || manifest.version !== version || manifest.tag !== tag
        || manifest.repository !== `https://github.com/${OFFICIAL_REPOSITORY}`
        || manifest.candidate_lock?.path !== 'RELEASE_CANDIDATE_LOCK.json'
        || manifest.candidate_lock.sha256 !== sha256(lockBytes)
        || lock?.protocol !== 'peanut.release-candidate-lock.v1' || lock.version !== version || lock.tag !== tag
        || !sha(lock.candidate?.commit) || !sha(lock.candidate?.tree) || !digest(lock.inputs?.application_template_inventory_sha256)
        || manifest.commit !== lock.candidate.commit) fail('PEANUT_RELEASE_IDENTITY_INVALID');
    const scaffoldUrl = `https://raw.githubusercontent.com/${OFFICIAL_REPOSITORY}/${encodeURIComponent(tag)}/scaffold/releases/${encodeURIComponent(tag)}/scaffold-manifest.json`;
    const scaffoldBytes = await githubJson(scaffoldUrl, fetcher, true);
    let scaffold;
    try { scaffold = JSON.parse(scaffoldBytes); } catch { fail('PEANUT_RELEASE_SCAFFOLD_INVALID'); }
    if (sha256(scaffoldBytes) !== lock.inputs.scaffold_manifest_sha256
        || scaffold?.protocol !== 'peanut.scaffold-release.v3' || scaffold.release?.version !== version
        || !sha(scaffold.release.source_commit) || !sha(scaffold.release.source_tree)
        || scaffold.release.inventory_sha256 !== lock.inputs.application_template_inventory_sha256) fail('PEANUT_RELEASE_SCAFFOLD_INVALID');
    const [candidateCommit, sealedCommit] = await Promise.all([
        githubJson(`https://api.github.com/repos/${OFFICIAL_REPOSITORY}/git/commits/${lock.candidate.commit}`, fetcher),
        githubJson(`https://api.github.com/repos/${OFFICIAL_REPOSITORY}/git/commits/${scaffold.release.source_commit}`, fetcher),
    ]);
    if (candidateCommit?.sha !== lock.candidate.commit || candidateCommit.tree?.sha !== lock.candidate.tree
        || sealedCommit?.sha !== scaffold.release.source_commit || sealedCommit.tree?.sha !== scaffold.release.source_tree) {
        fail('PEANUT_RELEASE_SOURCE_TREE_INVALID');
    }
    const ancestry = await githubJson(`https://api.github.com/repos/${OFFICIAL_REPOSITORY}/compare/${scaffold.release.source_commit}...${lock.candidate.commit}`, fetcher);
    if (ancestry?.base_commit?.sha !== scaffold.release.source_commit
        || !['identical', 'ahead'].includes(ancestry.status)
        || ancestry.merge_base_commit?.sha !== scaffold.release.source_commit
        || (ancestry.status === 'ahead' && ancestry.ahead_by === ancestry.commits?.length
            && ancestry.commits.at(-1)?.sha !== lock.candidate.commit)
        || (ancestry.status === 'identical' && scaffold.release.source_commit !== lock.candidate.commit)) fail('PEANUT_RELEASE_SOURCE_GRAPH_INVALID');
    return { release, version, tag, manifest, lock, scaffold,
        sealed_source: { commit: scaffold.release.source_commit, tree: scaffold.release.source_tree, inventory_sha256: scaffold.release.inventory_sha256 },
        source: { ...lock.candidate, inventory_sha256: lock.inputs.application_template_inventory_sha256 },
        manifest_url: manifestUrl, candidate_lock_url: lockUrl, candidate_lock_sha256: sha256(lockBytes), scaffold_url: scaffoldUrl };
}
