import fs from 'node:fs';
import path from 'node:path';
import { existingFileWithin, sha256, validateSemver } from './protocol.js';
import { MODULE_REPOSITORY, officialModuleKey, publishedModuleIndex, readModuleIndex } from './module-release.js';
import { githubJson } from './release-source.js';

export const MODULE_PRESETS_PATH = 'server/config/module_composition.json';
const fail = (code) => { throw new Error(`PEANUT_CREATE_MODULE_${code}`); };

/** Product membership belongs to the selected scaffold, never to a CLI module list. */
function templatePresets(bundle) {
    const file = bundle.create.files.find((entry) => entry.path === MODULE_PRESETS_PATH);
    if (!file || file.render) fail('PRESETS_REQUIRED');
    const bytes = bundle.members.get(file.source).bytes;
    let manifest;
    try { manifest = JSON.parse(bytes); } catch { fail('PRESETS_INVALID'); }
    if (manifest?.schema_version !== 1 || manifest.protocol !== 'peanut.application-module-composition.v1'
        || typeof manifest.version !== 'string') fail('PRESETS_INVALID');
    validateSemver(manifest.version);
    const seen = new Set();
    for (const group of ['mandatory', 'default', 'optional']) {
        const keys = manifest[group];
        if (group === 'optional' && keys === undefined) continue;
        if (!Array.isArray(keys) || keys.length > 100) fail('PRESETS_INVALID');
        for (const key of keys) {
            if (typeof key !== 'string' || !officialModuleKey(key) || seen.has(key)) fail('PRESETS_INVALID');
            seen.add(key);
        }
    }
    if (manifest.mandatory.length === 0) fail('PRESETS_INVALID');
    return { manifest, sha256: sha256(bytes) };
}

async function sourceIndex(options, fetcher) {
    const tag = options.moduleRelease;
    if (typeof tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tag)) fail('RELEASE_REQUIRED');
    const channel = options.moduleChannel ?? 'stable';
    if (!['stable', 'prerelease'].includes(channel)) fail('CHANNEL_INVALID');
    if (options.moduleIndex !== undefined || options.moduleIndexSha256 !== undefined) {
        if (typeof options.moduleIndex !== 'string' || !path.isAbsolute(options.moduleIndex)
            || !/^[a-f0-9]{64}$/.test(options.moduleIndexSha256 ?? '')) fail('OFFLINE_SOURCE_INVALID');
        // A local index pin proves bytes, not GitHub's Release channel or publication status.
        if (channel !== 'prerelease') fail('OFFLINE_RELEASE_CHANNEL_UNVERIFIED');
        const file = existingFileWithin(path.dirname(options.moduleIndex), options.moduleIndex, 'PEANUT_CREATE_MODULE_OFFLINE_SOURCE_INVALID');
        if (fs.statSync(file).size > 4 * 1024 * 1024) fail('INDEX_TOO_LARGE');
        const bytes = fs.readFileSync(file);
        if (sha256(bytes) !== options.moduleIndexSha256) fail('INDEX_DIGEST_MISMATCH');
        return { index: readModuleIndex(bytes, { tag_name: tag }), sha256: sha256(bytes),
            provenance: 'digest-pinned-local', channel };
    }
    const release = await githubJson(`https://api.github.com/repos/${MODULE_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`, fetcher);
    if (release?.tag_name !== tag) fail('RELEASE_IDENTITY_INVALID');
    const source = await publishedModuleIndex(release, fetcher);
    if (channel === 'stable' && release.prerelease) fail('PRERELEASE_OPT_IN_REQUIRED');
    return { ...source, provenance: 'github-release-api-digest', channel };
}

/** Selection only: dependency ranges and whole-graph admission remain Code-owned. */
export async function planCreateModules(bundle, options, fetcher = fetch) {
    if (options.edition !== 'multi-tenant') fail('MT_REQUIRED');
    const preset = options.modulePreset ?? 'standard';
    if (!['minimal', 'standard'].includes(preset)) fail('PRESET_INVALID');
    const { manifest, sha256: presetSha } = templatePresets(bundle);
    const optional = options.modules === undefined ? [] : options.modules.split(',');
    if (new Set(optional).size !== optional.length || optional.some((key) => !manifest.optional?.includes(key))) fail('OPTIONAL_SELECTION_INVALID');
    const roots = [...manifest.mandatory,
        ...(preset === 'standard' ? manifest.default : []), ...optional].sort();
    const source = await sourceIndex(options, fetcher);
    const catalog = Object.values(source.index.modules).sort((a, b) => a.key.localeCompare(b.key));
    const selected = [];
    const blockers = [];
    if (manifest.optional === undefined) blockers.push({ code: 'CODE_OPTIONAL_MODULE_CLASSIFICATION_REQUIRED' });
    for (const key of roots) {
        const row = source.index.modules[key];
        if (!row) blockers.push({ code: 'MODULE_NOT_IN_SNAPSHOT', key });
        else if (!row.editions.includes('multi-tenant')) blockers.push({ code: 'MODULE_EDITION_UNSUPPORTED', key });
        else if (source.channel === 'stable' && row.version.split('+')[0].includes('-')) blockers.push({ code: 'MODULE_PRERELEASE_OPT_IN_REQUIRED', key });
        else selected.push(row);
    }
    blockers.push({ code: 'CODE_NATIVE_COMPOSITION_PLAN_REQUIRED',
        reason: 'No public batch candidate/closure and pre-bootstrap source staging interface is available in the reviewed Code baseline.' });
    return {
        schema_version: 1, protocol: 'peanut.create-module-selection.v1', status: 'blocked', edition: 'multi-tenant',
        preset: { name: preset, version: manifest.version, path: MODULE_PRESETS_PATH, sha256: presetSha,
            modules: { mandatory: manifest.mandatory, default: manifest.default, optional: manifest.optional ?? null } },
        source: { repository: source.index.repository, tag: source.index.tag, commit: source.index.commit,
            index_sha256: source.sha256, provenance: source.provenance, channel: source.channel },
        roots, selected, catalog, blockers,
        dependency_resolution: 'not-run', source_adoption: 'not-run', installation: 'not-run',
        target_mutated: false, database_mutated: false,
    };
}
