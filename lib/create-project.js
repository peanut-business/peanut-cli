import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compareSemver, readJsonObject, sha256File, validateSemver } from './protocol.js';
import { OFFICIAL_REPOSITORY, OFFICIAL_SOURCE, RELEASE_API, githubJson, officialSource, publishedSource } from './release-source.js';

const DEFAULT_SOURCE = OFFICIAL_SOURCE;
const DEFAULT_REF = 'dev';
const DEFAULT_CREATE_CHANNEL = 'development';

function fail(message) { throw new Error(message); }

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', shell: false, ...options });
    if (result.error) fail(`PEANUT_CREATE_COMMAND_FAILED: ${command}: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        fail(`PEANUT_CREATE_COMMAND_FAILED: ${command}${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout.trim();
}

function requireString(value, code) {
    if (typeof value !== 'string' || value.trim() === '') fail(code);
    return value;
}

function targetPath(input) {
    const resolved = path.resolve(requireString(input, 'PEANUT_CREATE_TARGET_REQUIRED'));
    if (fs.existsSync(resolved)) fail('PEANUT_CREATE_TARGET_EXISTS');
    if (!fs.statSync(path.dirname(resolved), { throwIfNoEntry: false })?.isDirectory()) {
        fail('PEANUT_CREATE_TARGET_PARENT_INVALID');
    }
    return resolved;
}

/** Prepare the native public source tool; callers own its checkout lifecycle. */
export function checkoutSource(source, ref, checkout) {
    run('git', ['clone', '--quiet', '--no-checkout', source, checkout]);
    run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', ref]);
    run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    return {
        commit: run('git', ['-C', checkout, 'rev-parse', 'HEAD']),
        tree: run('git', ['-C', checkout, 'rev-parse', 'HEAD^{tree}']),
    };
}

export async function createProject(options, fetcher = fetch) {
    const target = targetPath(options.target);
    const name = requireString(options.name, 'PEANUT_CREATE_NAME_REQUIRED');
    const slug = requireString(options.slug, 'PEANUT_CREATE_SLUG_REQUIRED');
    const packageIdentity = requireString(options.package, 'PEANUT_CREATE_PACKAGE_REQUIRED');
    const edition = requireString(options.edition, 'PEANUT_CREATE_EDITION_REQUIRED');
    if (!['standalone', 'multi-tenant'].includes(edition)) fail('PEANUT_CREATE_EDITION_INVALID');

    const source = requireString(options.source ?? DEFAULT_SOURCE, 'PEANUT_CREATE_SOURCE_REQUIRED');
    const channel = options.channel ?? DEFAULT_CREATE_CHANNEL;
    if (!['development', 'stable', 'prerelease'].includes(channel)) fail('PEANUT_CREATE_CHANNEL_INVALID');
    if (channel !== 'development' && !officialSource(source)) fail('PEANUT_CREATE_OFFICIAL_CHANNEL_SOURCE_REQUIRED');
    let selectedRef = options.ref;
    if (channel === 'stable' && !selectedRef) {
        const latest = await githubJson(`${RELEASE_API}/latest`, fetcher);
        selectedRef = latest?.tag_name;
    }
    if (channel === 'prerelease' && !selectedRef) {
        const releases = await githubJson(`${RELEASE_API}?per_page=100`, fetcher);
        if (!Array.isArray(releases)) fail('PEANUT_CREATE_RELEASE_RESPONSE_INVALID');
        selectedRef = releases.filter((item) => !item.draft && /^v[0-9]/.test(item.tag_name))
            .filter((item) => { try { validateSemver(item.tag_name.slice(1)); return true; } catch { return false; } })
            .sort((a, b) => compareSemver(b.tag_name.slice(1), a.tag_name.slice(1)))[0]?.tag_name;
    }
    if (channel !== 'development' && !selectedRef) fail('PEANUT_CREATE_RELEASE_NOT_FOUND');
    const release = channel === 'development' ? null : await publishedSource(selectedRef, fetcher);
    if (release && channel === 'stable' && (release.release.prerelease || release.version.includes('-'))) fail('PEANUT_CREATE_CHANNEL_MISMATCH');
    const actualChannel = release ? (release.release.prerelease || release.version.includes('-') ? 'prerelease' : 'stable') : 'development';
    const ref = requireString(release?.tag ?? options.ref ?? DEFAULT_REF, 'PEANUT_CREATE_REF_REQUIRED');
    const requestedRef = requireString(options.ref ?? ref, 'PEANUT_CREATE_REF_REQUIRED');
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-create-source-'));
    const checkout = path.join(sourceRoot, 'source');
    const staging = path.join(path.dirname(target), `.${path.basename(target)}.peanut-create-${process.pid}-${randomUUID()}`);

    try {
        const { commit: sourceCommit, tree: sourceTree } = checkoutSource(source, ref, checkout);
        const inventory = sha256File(path.join(checkout, 'scaffold', 'application-template-inventory.json'));
        if (release && (release.source.commit !== sourceCommit || release.source.tree !== sourceTree
            || release.source.inventory_sha256 !== inventory)) fail('PEANUT_CREATE_RELEASE_SOURCE_MISMATCH');
        const repository = officialSource(source) ? OFFICIAL_REPOSITORY : source;
        const createApp = path.join(checkout, 'scripts', 'create-app');
        if (!fs.statSync(createApp, { throwIfNoEntry: false })?.isFile()) fail('PEANUT_CREATE_ENTRY_MISSING');

        const autoload = path.join(checkout, 'server', 'vendor', 'autoload.php');
        if (!fs.statSync(autoload, { throwIfNoEntry: false })?.isFile()) {
            run('composer', ['install', '--working-dir', path.join(checkout, 'server'), '--no-scripts', '--no-interaction', '--no-progress', '--prefer-dist']);
        }

        const createArgs = [
            createApp,
            `--name=${name}`,
            `--slug=${slug}`,
            `--package=${packageIdentity}`,
            `--target=${staging}`,
            `--edition=${edition}`,
            `--source-repository=${repository}`,
            `--source-ref=${requestedRef}`,
            `--source-channel=${actualChannel}`,
            `--source-commit=${sourceCommit}`,
            `--source-tree=${sourceTree}`,
        ];
        if (release) createArgs.push(`--release-version=${release.version}`);
        if (options.profile) createArgs.push(`--profile=${options.profile}`);
        if (options.applicationVersion) createArgs.push(`--application-version=${options.applicationVersion}`);
        const raw = run('php', createArgs);
        let created;
        try { created = JSON.parse(raw); } catch { fail('PEANUT_CREATE_OUTPUT_INVALID'); }
        if (created?.status !== 'created') fail('PEANUT_CREATE_OUTPUT_INVALID');
        if (!fs.statSync(path.join(staging, '.peanut', 'application-manifest.json'), { throwIfNoEntry: false })?.isFile()) {
            fail('PEANUT_CREATE_MANIFEST_MISSING');
        }
        const manifest = readJsonObject(path.join(staging, '.peanut', 'application-manifest.json'));
        const expected = { repository, requested_ref: requestedRef, channel: actualChannel, release_version: release?.version ?? null,
            commit: sourceCommit, tree: sourceTree, inventory_sha256: inventory };
        if (Object.entries(expected).some(([key, value]) => manifest.generation_source?.[key] !== value)
            || typeof manifest.generation_source?.edition_profile_sha256 !== 'string'
            || !/^[0-9a-f]{64}$/.test(manifest.generation_source.edition_profile_sha256)) fail('PEANUT_CREATE_SOURCE_IDENTITY_MISMATCH');
        fs.renameSync(staging, target);
        return { ...created, target, source: manifest.generation_source };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
}

export const createDefaults = Object.freeze({ source: DEFAULT_SOURCE, ref: DEFAULT_REF, channel: DEFAULT_CREATE_CHANNEL });
