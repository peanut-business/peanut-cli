import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { checkoutSource } from './create-project.js';
import { compareSemver, existingFileWithin, projectPath, projectRoot, readJsonObject, sha256, sha256File, validateApplicationManifest, validateSemver } from './protocol.js';
import { OFFICIAL_REPOSITORY, githubJson, publishedSource } from './release-source.js';

const REPOSITORY = OFFICIAL_REPOSITORY;
const API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const fail = (code) => { throw new Error(code); };
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceIdentity = (value) => value && /^[a-f0-9]{40}$/.test(value.commit) && /^[a-f0-9]{40}$/.test(value.tree);
const major = (version) => validateSemver(version).split('.')[0];
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function classifySource(generation, fixed, fetcher) {
    const unknown = (reason) => ({ kind: 'unknown', content: 'unknown', reason });
    if (!generation || generation.repository !== REPOSITORY
        || !['development', 'stable', 'prerelease'].includes(generation.channel)
        || !sourceIdentity(generation) || !digest(generation.inventory_sha256)
        || !digest(generation.edition_profile_sha256)
        || typeof generation.requested_ref !== 'string' || generation.requested_ref === ''
        || (generation.channel === 'development' ? generation.release_version !== null
            : typeof generation.release_version !== 'string')) return unknown('generation_source_incomplete');
    if (generation.channel !== 'development') {
        try {
            const version = validateSemver(generation.release_version);
            if ((generation.channel === 'stable' && version.includes('-'))
                || (generation.channel === 'prerelease' && !version.includes('-'))) return unknown('generation_source_channel_invalid');
        } catch { return unknown('generation_source_version_invalid'); }
    }
    let comparison;
    try {
        const base = fixed.source.commit;
        const head = generation.commit;
        comparison = await githubJson(`https://api.github.com/repos/${REPOSITORY}/compare/${base}...${head}`, fetcher);
        if (comparison.base_commit?.sha !== base || !['identical', 'ahead', 'behind', 'diverged'].includes(comparison.status)
            || (comparison.status === 'identical' && base !== head)
            || (comparison.status === 'behind' && comparison.merge_base_commit?.sha !== head)
            || (comparison.status === 'ahead' && comparison.merge_base_commit?.sha !== base)
            || (comparison.status === 'diverged' && (!sourceIdentity({ commit: comparison.merge_base_commit?.sha, tree: fixed.source.tree })))
            || (comparison.status === 'ahead' && comparison.ahead_by === comparison.commits?.length
                && comparison.commits.at(-1)?.sha !== head)) return unknown('compare_identity_invalid');
    } catch { return unknown('compare_unavailable'); }
    const content = generation.tree === fixed.source.tree
        && generation.inventory_sha256 === fixed.source.inventory_sha256 ? 'equivalent' : 'different';
    return { kind: comparison.status, content, base_commit: fixed.source.commit, head_commit: generation.commit };
}

function majorRisk(selection) {
    if (selection.origin_channel === 'development' && selection.origin_release_version === null) {
        return { kind: 'unknown_source_major', source_version: null, compatibility_baseline: selection.current_version,
            target_version: selection.target_version, message: 'The development source has no fixed release version. Review the source relation, native plan, custom code and dependencies before applying this release.' };
    }
    if (major(selection.current_version) === major(selection.target_version)) return null;
    return { kind: 'major_version_change', source_version: selection.current_version, target_version: selection.target_version,
        message: 'A major upgrade may break APIs, business behavior, dependencies, or migrations. Review the native plan, keep a recoverable backup, and confirm there are no known unresolved risks before attempting apply.' };
}

function riskFields(selection) {
    const risk = majorRisk(selection);
    return risk ? { risk, human_confirmation_required: true } : {};
}

function confirmationRequired(root, selection, planPath, plan = null) {
    return { status: 'confirmation_required', selection, plan_path: planPath, plan,
        ...riskFields(selection), next_command: `peanut upgrade --apply-plan ${shellQuote(planPath)} --confirm-major-upgrade --path ${shellQuote(root)}` };
}

async function request(url, binary = false, fetcher = fetch) {
    const response = await fetcher(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Peanut-CLI' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) fail(`PEANUT_UPGRADE_DOWNLOAD_FAILED: HTTP ${response.status}: ${url}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

function publicAsset(asset, name, releaseTag) {
    if (!asset || asset.name !== name || typeof asset.browser_download_url !== 'string') fail(`PEANUT_UPGRADE_ASSET_MISSING: ${name}`);
    const expected = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(name)}`;
    if (asset.browser_download_url !== expected) fail('PEANUT_UPGRADE_ASSET_SOURCE_INVALID');
    return asset.browser_download_url;
}

/** Discover only published releases, never mutable dev or unreviewed tag sources. */
export async function discoverUpgrade(application, options = {}, fetcher = fetch) {
    const current = validateSemver(application.template.version);
    const generation = application.generation_source;
    const development = generation?.channel === 'development';
    const channel = options.channel ?? (generation?.channel === 'prerelease' || current.includes('-')
        || options.ref?.replace(/^v/, '').includes('-') ? 'prerelease' : 'stable');
    if (!['stable', 'prerelease'].includes(channel)) fail('PEANUT_UPGRADE_CHANNEL_INVALID');
    let release;
    if (options.ref) {
        const version = validateSemver(options.ref.replace(/^v/, ''));
        release = await request(`${API}/tags/${encodeURIComponent(`v${version}`)}`, false, fetcher);
    } else if (development && channel === 'stable') {
        release = await request(`${API}/latest`, false, fetcher);
    } else {
        const candidates = [];
        for (let page = 1; ; page += 1) {
            const releases = await request(`${API}?per_page=100&page=${page}`, false, fetcher);
            if (!Array.isArray(releases)) fail('PEANUT_UPGRADE_RELEASE_RESPONSE_INVALID');
            for (const item of releases) {
                if (item.draft || typeof item.tag_name !== 'string') continue;
                let version;
                try { version = validateSemver(item.tag_name.replace(/^v/, '')); } catch { continue; }
                if ((channel === 'stable' && (item.prerelease || version.includes('-')))
                    || (!development && version.split('.')[0] !== current.split('.')[0])) continue;
                candidates.push(item);
            }
            if (releases.length < 100) break;
            if (page >= 20) fail('PEANUT_UPGRADE_RELEASE_DISCOVERY_LIMIT');
        }
        candidates.sort((a, b) => compareSemver(b.tag_name.replace(/^v/, ''), a.tag_name.replace(/^v/, '')));
        release = candidates[0];
    }
    if (!release || release.draft) fail('PEANUT_UPGRADE_RELEASE_NOT_FOUND');
    const version = validateSemver(release.tag_name?.replace(/^v/, ''));
    if (options.ref && version !== options.ref.replace(/^v/, '')) fail('PEANUT_UPGRADE_RELEASE_IDENTITY_MISMATCH');
    if (!options.ref && !development && major(version) !== major(current)) fail('PEANUT_UPGRADE_MAJOR_CHANGE_UNSUPPORTED');
    if (channel === 'stable' && (release.prerelease || version.includes('-'))) fail('PEANUT_UPGRADE_CHANNEL_MISMATCH');
    const assets = release.assets;
    if (!Array.isArray(assets)) fail('PEANUT_UPGRADE_RELEASE_RESPONSE_INVALID');
    const fixed = await publishedSource(version, fetcher);
    if (release.id !== fixed.release.id) fail('PEANUT_UPGRADE_RELEASE_IDENTITY_MISMATCH');
    const relation = await classifySource(generation, fixed, fetcher);
    const identity = { repository: fixed.manifest.repository, ref: fixed.tag,
        requested_ref: options.ref ?? fixed.tag, channel, current_version: current,
        target_version: version, origin_channel: generation?.channel ?? null,
        origin_release_version: generation?.release_version ?? null, installed_source: generation ?? null,
        source_relation: relation, release_source: fixed.sealed_source, source: fixed.source,
        manifest_url: fixed.manifest_url, candidate_lock_url: fixed.candidate_lock_url,
        candidate_lock_sha256: fixed.candidate_lock_sha256, scaffold_url: fixed.scaffold_url,
        scaffold_manifest_sha256: fixed.lock.inputs.scaffold_manifest_sha256 };
    if (relation.kind === 'unknown') return { ...identity, status: 'source_identity_unknown' };
    if (development && relation.content === 'equivalent') {
        return { ...identity, status: 'release_adoption_available', adoption: true };
    }
    if (development && ['ahead', 'diverged'].includes(relation.kind)) return { ...identity,
        status: relation.kind === 'ahead' ? 'source_ahead' : 'source_diverged' };
    if (compareSemver(version, current) < 0) return { ...identity, status: 'source_range_unsupported' };
    // A first published baseline legitimately has no upgrade asset. Equality needs
    // only release identity, not an install archive masquerading as an upgrade.
    if (compareSemver(version, current) === 0) {
        return { ...identity, status: relation.content === 'equivalent' ? 'up_to_date'
            : generation.channel === 'development' ? 'source_range_unsupported' : 'source_identity_mismatch' };
    }
    const edition = application.application.edition;
    const filename = `peanut-admin-${version}-${edition}-upgrade.tar.gz`;
    const manifestUrl = publicAsset(assets.find((asset) => asset.name === filename + '.manifest.json'), filename + '.manifest.json', release.tag_name);
    const archiveUrl = publicAsset(assets.find((asset) => asset.name === filename), filename, release.tag_name);
    const artifact = await request(manifestUrl, false, fetcher);
    if (artifact?.schema_version !== 1 || artifact.protocol !== 'peanut.edition-upgrade-artifact.v1'
        || artifact.product?.version !== version || artifact.edition?.name !== edition
        || artifact.formal_release_eligible === false || artifact.scope === 'internal-upgrade-candidate'
        || artifact.archive?.filename !== filename || artifact.archive.root !== filename.slice(0, -7)
        || artifact.archive.format !== 'tar.gz' || !digest(artifact.archive.sha256)
        || !Number.isSafeInteger(artifact.archive.bytes) || artifact.archive.bytes <= 0
        || !digest(artifact.package?.manifest_sha256) || !digest(artifact.package?.inventory_sha256)
        || !sourceIdentity(artifact.source)) fail('PEANUT_UPGRADE_ARTIFACT_INVALID');
    const compatibility = artifact.compatibility;
    const policy = compatibility?.major_policy;
    const minimum = compatibility?.source?.minimum_inclusive;
    const maximum = compatibility?.source?.maximum_exclusive;
    let supported = false;
    try {
        supported = ['same-major', 'source-range'].includes(policy)
            && validateSemver(minimum) === minimum && validateSemver(maximum) === maximum
            && maximum === version && compareSemver(minimum, version) < 0
            && compareSemver(minimum, current) <= 0 && compareSemver(current, maximum) < 0
            && (policy !== 'same-major' || (major(minimum) === major(current) && major(current) === major(version)));
    } catch { /* Invalid compatibility is an unsupported source range. */ }
    if (!supported) fail('PEANUT_UPGRADE_SOURCE_VERSION_UNSUPPORTED');
    if (artifact.source.commit !== fixed.source.commit || artifact.source.tree !== fixed.source.tree
        || artifact.source.inventory_sha256 !== fixed.source.inventory_sha256) fail('PEANUT_UPGRADE_ARTIFACT_SOURCE_MISMATCH');
    return { ...identity, status: 'available', artifact, archive_url: archiveUrl, artifact_manifest_url: manifestUrl };
}

function sourceGit(checkout, ...args) {
    const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail('PEANUT_UPGRADE_ENGINE_SOURCE_INVALID');
    return result.stdout;
}

function checkedEngineSource(root, selection) {
    if (selection.repository !== `https://github.com/${REPOSITORY}`
        || selection.ref !== `v${validateSemver(selection.target_version)}`
        || !sourceIdentity(selection.source) || !digest(selection.source.inventory_sha256)) fail('PEANUT_UPGRADE_ENGINE_IDENTITY_INVALID');
    const checkout = projectPath(root, `.peanut/upgrades/engines/${selection.source.commit}`);
    const entry = projectPath(checkout, 'scripts/scaffold-upgrade');
    existingFileWithin(checkout, entry, 'PEANUT_UPGRADE_NATIVE_ENTRY_REQUIRED');
    if (sourceGit(checkout, 'rev-parse', 'HEAD').trim() !== selection.source.commit
        || sourceGit(checkout, 'rev-parse', 'HEAD^{tree}').trim() !== selection.source.tree) fail('PEANUT_UPGRADE_ENGINE_IDENTITY_MISMATCH');
    // Compare execution bytes directly to the committed tree, independently of
    // index flags, stat caches and ignored/untracked files. Source tools must be
    // regular tracked files; never execute a symlink or a submodule checkout.
    const tracked = new Set();
    for (const row of sourceGit(checkout, 'ls-tree', '-rz', '--full-tree', 'HEAD').split('\0').filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(row);
        if (!match) fail('PEANUT_UPGRADE_ENGINE_SOURCE_INVALID');
        const [, mode, blob, relative] = match;
        const file = projectPath(checkout, relative);
        existingFileWithin(checkout, file, 'PEANUT_UPGRADE_ENGINE_SOURCE_INVALID');
        const bytes = fs.readFileSync(file);
        const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (actual !== blob || Boolean(fs.statSync(file).mode & 0o111) !== (mode === '100755')) fail('PEANUT_UPGRADE_ENGINE_CONTENT_MISMATCH');
        tracked.add(relative);
    }
    // Composer owns only server/vendor. Every other ignored/untracked execution
    // input remains forbidden; dependency bytes are checked separately below.
    function checkFiles(directory, prefix = '') {
        for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
            if (prefix === '' && child.name === '.git') continue;
            const relative = prefix + child.name;
            if (relative === 'server/vendor' && child.isDirectory()) continue;
            if (child.isDirectory()) checkFiles(path.join(directory, child.name), relative + '/');
            else if (!tracked.has(relative) || !child.isFile()) fail('PEANUT_UPGRADE_ENGINE_UNTRACKED_CONTENT');
        }
    }
    checkFiles(checkout);
    if (sha256File(projectPath(checkout, 'scaffold/application-template-inventory.json')) !== selection.source.inventory_sha256) fail('PEANUT_UPGRADE_ENGINE_INVENTORY_MISMATCH');
    return entry;
}

function dependencyBinding(root, selection) {
    return projectPath(root, `.peanut/upgrades/engine-dependencies/${selection.source.commit}.json`);
}

function releaseLockPath(root, selection) {
    return projectPath(root, `.peanut/upgrades/release-proofs/${selection.candidate_lock_sha256}.json`);
}

async function acquireReleaseLock(root, selection, fetcher) {
    const file = releaseLockPath(root, selection);
    if (fs.existsSync(file)) {
        existingFileWithin(root, file, 'PEANUT_UPGRADE_RELEASE_LOCK_INVALID');
        if (sha256File(file) !== selection.candidate_lock_sha256) fail('PEANUT_UPGRADE_RELEASE_LOCK_MISMATCH');
        return file;
    }
    const bytes = await request(selection.candidate_lock_url, true, fetcher);
    if (sha256(bytes) !== selection.candidate_lock_sha256) fail('PEANUT_UPGRADE_RELEASE_LOCK_MISMATCH');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return file;
}

function engineDependencies(checkout) {
    const manifest = projectPath(checkout, 'server/composer.json');
    const lockFile = projectPath(checkout, 'server/composer.lock');
    existingFileWithin(checkout, manifest, 'PEANUT_UPGRADE_ENGINE_LOCK_REQUIRED');
    existingFileWithin(checkout, lockFile, 'PEANUT_UPGRADE_ENGINE_LOCK_REQUIRED');
    const lock = readJsonObject(lockFile);
    if (!Array.isArray(lock.packages) || lock.packages.length === 0) fail('PEANUT_UPGRADE_ENGINE_LOCK_INVALID');
    const vendor = projectPath(checkout, 'server/vendor');
    existingFileWithin(checkout, projectPath(checkout, 'server/vendor/autoload.php'), 'PEANUT_UPGRADE_ENGINE_DEPENDENCIES_REQUIRED');
    const installedFile = projectPath(checkout, 'server/vendor/composer/installed.json');
    existingFileWithin(checkout, installedFile, 'PEANUT_UPGRADE_ENGINE_DEPENDENCIES_INVALID');
    const installed = readJsonObject(installedFile);
    if (installed.dev !== false || !Array.isArray(installed.packages)) fail('PEANUT_UPGRADE_ENGINE_DEPENDENCIES_INVALID');
    const identity = (item) => ({ name: item.name, version: item.version, source: item.source ?? null, dist: item.dist ?? null });
    const packages = lock.packages.map(identity).sort((a, b) => a.name.localeCompare(b.name));
    if (!isDeepStrictEqual(packages, installed.packages.map(identity).sort((a, b) => a.name.localeCompare(b.name)))) {
        fail('PEANUT_UPGRADE_ENGINE_DEPENDENCY_LOCK_MISMATCH');
    }
    for (const item of installed.packages) {
        if (typeof item['install-path'] !== 'string') fail('PEANUT_UPGRADE_ENGINE_DEPENDENCIES_INVALID');
        const relative = path.relative(vendor, path.resolve(path.dirname(installedFile), item['install-path'])).split(path.sep).join('/');
        const directory = projectPath(vendor, relative);
        if (!fs.lstatSync(directory).isDirectory()) fail('PEANUT_UPGRADE_ENGINE_DEPENDENCIES_INVALID');
    }
    const files = [];
    function inventory(directory, prefix = '') {
        for (const child of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix + child.name;
            const file = projectPath(vendor, relative);
            if (child.isDirectory()) {
                files.push({ path: relative, type: 'directory' });
                inventory(file, relative + '/');
            } else {
                existingFileWithin(vendor, file, 'PEANUT_UPGRADE_ENGINE_DEPENDENCIES_INVALID');
                files.push({ path: relative, type: 'file', executable: Boolean(fs.statSync(file).mode & 0o111), sha256: sha256File(file) });
            }
        }
    }
    inventory(vendor);
    return { composer_json_sha256: sha256File(manifest), composer_lock_sha256: sha256File(lockFile), packages, files };
}

function checkedEngine(root, selection) {
    const entry = checkedEngineSource(root, selection);
    const file = dependencyBinding(root, selection);
    existingFileWithin(root, file, 'PEANUT_UPGRADE_ENGINE_DEPENDENCY_BINDING_REQUIRED');
    const binding = readJsonObject(file);
    if (binding.protocol !== 'peanut.cli-upgrade-engine-dependencies.v1' || binding.schema_version !== 1
        || !isDeepStrictEqual(binding.source, selection.source)
        || !isDeepStrictEqual(binding.dependencies, engineDependencies(path.dirname(path.dirname(entry))))) {
        fail('PEANUT_UPGRADE_ENGINE_DEPENDENCY_BINDING_MISMATCH');
    }
    return entry;
}

function prepareEngineDependencies(root, selection) {
    const entry = checkedEngineSource(root, selection);
    const checkout = path.dirname(path.dirname(entry));
    const binding = dependencyBinding(root, selection);
    if (fs.existsSync(binding)) return checkedEngine(root, selection);
    // Never bless pre-existing or partly installed dependencies as trusted bytes.
    if (fs.existsSync(projectPath(checkout, 'server/vendor'))) fail('PEANUT_UPGRADE_ENGINE_DEPENDENCY_BINDING_REQUIRED');
    const lock = projectPath(checkout, 'server/composer.lock');
    existingFileWithin(checkout, lock, 'PEANUT_UPGRADE_ENGINE_LOCK_REQUIRED');
    const stage = fs.mkdtempSync(path.join(path.dirname(checkout), '.composer-'));
    try {
        // Ambient Composer overrides/global plugins cannot redirect or augment
        // this install. Composer's locked public sources remain authoritative.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'COMPOSER' && !key.startsWith('COMPOSER_')));
        env.COMPOSER_HOME = path.join(stage, 'home');
        env.COMPOSER_CACHE_DIR = path.join(stage, 'cache');
        const run = (args) => {
            const result = spawnSync('composer', ['--no-plugins', '--no-scripts', '--working-dir', path.join(checkout, 'server'), ...args],
                { env, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
            if (result.error || result.status !== 0) fail(`PEANUT_UPGRADE_ENGINE_DEPENDENCY_PREPARATION_FAILED: ${result.error?.message ?? (result.stderr || result.stdout).trim()}`);
        };
        run(['validate', '--check-lock', '--no-check-publish', '--no-interaction']);
        run(['install', '--no-dev', '--no-interaction', '--no-progress', '--prefer-dist']);
        checkedEngineSource(root, selection);
        const dependencies = engineDependencies(checkout);
        fs.mkdirSync(path.dirname(binding), { recursive: true, mode: 0o700 });
        fs.writeFileSync(binding, JSON.stringify({ schema_version: 1, protocol: 'peanut.cli-upgrade-engine-dependencies.v1', source: selection.source, dependencies }, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 });
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    return checkedEngine(root, selection);
}

function acquireEngine(root, selection) {
    const checkout = projectPath(root, `.peanut/upgrades/engines/${selection.source.commit}`);
    if (!fs.existsSync(checkout)) {
        const parent = projectPath(root, '.peanut/upgrades/engines');
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const stage = fs.mkdtempSync(path.join(parent, '.source-'));
        try {
            checkoutSource(selection.repository + '.git', selection.source.commit, path.join(stage, 'source'));
            fs.renameSync(path.join(stage, 'source'), checkout);
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
    return prepareEngineDependencies(root, selection);
}

function native(root, selection, command, args) {
    const entry = checkedEngine(root, selection);
    const result = spawnSync('php', [entry, command, `--project-root=${root}`, ...args], { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${result.error.message}`);
    if (result.stderr.trim() !== '') fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${command}: ${result.stderr.trim()}`);
    let output;
    try { output = JSON.parse(result.stdout); } catch {
        fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${command}: ${(result.stderr || result.stdout).trim()}`);
    }
    const blocked = ['preflight', 'release-adoption-plan'].includes(command) && output?.status === 'blocked';
    if (result.status !== (blocked ? 2 : 0)) {
        fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${command}: ${output?.error ?? `exit ${result.status}`}`);
    }
    if (!output || typeof output !== 'object') fail('PEANUT_UPGRADE_NATIVE_OUTPUT_INVALID');
    const expected = { apply: 'applied', verify: 'verified', recover: 'recovered', resolve: 'ready',
        'release-adoption-apply': 'applied', 'release-adoption-verify': 'verified', 'release-adoption-recover': 'recovered' }[command];
    if (expected && output.status !== expected) fail(`PEANUT_UPGRADE_NATIVE_OUTPUT_INVALID: ${command}`);
    return output;
}

// Archive transport only: reject links, devices, traversal and duplicate paths before
// extraction. Package authentication and all ownership decisions remain native.
const EXTRACT = `import pathlib, sys, tarfile, shutil
archive, destination, root = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    seen = set()
    for member in members:
        parts = member.name.rstrip('/').split('/')
        if not parts or parts[0] != root or any(p in ('', '.', '..') for p in parts) or '\\\\' in member.name or member.name in seen or not (member.isfile() or member.isdir()):
            raise ValueError('PEANUT_UPGRADE_ARCHIVE_MEMBER_INVALID')
        seen.add(member.name)
    for member in members:
        target = pathlib.Path(destination).joinpath(*member.name.rstrip('/').split('/'))
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o777)
`;

function authenticateTransport(packageRoot, selection) {
    const manifestPath = projectPath(packageRoot, 'upgrade-manifest.json');
    const inventoryPath = projectPath(packageRoot, 'META-INF/files.sha256');
    existingFileWithin(packageRoot, manifestPath, 'PEANUT_UPGRADE_PACKAGE_INVALID');
    existingFileWithin(packageRoot, inventoryPath, 'PEANUT_UPGRADE_PACKAGE_INVALID');
    const manifest = readJsonObject(manifestPath);
    if (sha256File(manifestPath) !== selection.artifact.package.manifest_sha256
        || sha256File(inventoryPath) !== selection.artifact.package.inventory_sha256
        || manifest.protocol !== 'peanut.edition-upgrade-package.v1'
        || manifest.target?.version !== selection.target_version
        || !isDeepStrictEqual(manifest.build_source, selection.source)
        || manifest.edition?.name !== selection.artifact.edition.name) fail('PEANUT_UPGRADE_PACKAGE_IDENTITY_MISMATCH');
}

async function acquirePackage(root, selection, fetcher) {
    const packages = projectPath(root, '.peanut/upgrades/packages');
    const destination = path.join(packages, selection.artifact.archive.sha256);
    const packageRoot = projectPath(root, `.peanut/upgrades/packages/${selection.artifact.archive.sha256}/${selection.artifact.archive.root}`);
    if (fs.existsSync(destination)) { authenticateTransport(packageRoot, selection); return packageRoot; }
    fs.mkdirSync(packages, { recursive: true, mode: 0o700 });
    const stage = fs.mkdtempSync(path.join(packages, '.download-'));
    try {
        const archive = path.join(stage, 'package.tar.gz');
        fs.writeFileSync(archive, await request(selection.archive_url, true, fetcher), { flag: 'wx', mode: 0o600 });
        if (fs.statSync(archive).size !== selection.artifact.archive.bytes || sha256File(archive) !== selection.artifact.archive.sha256) fail('PEANUT_UPGRADE_ARCHIVE_DIGEST_MISMATCH');
        const extracted = path.join(stage, 'extracted');
        fs.mkdirSync(extracted);
        const result = spawnSync('python3', ['-c', EXTRACT, archive, extracted, selection.artifact.archive.root], { encoding: 'utf8', shell: false });
        if (result.error || result.status !== 0) fail(`PEANUT_UPGRADE_ARCHIVE_INVALID: ${result.error?.message ?? result.stderr.trim()}`);
        authenticateTransport(path.join(extracted, selection.artifact.archive.root), selection);
        fs.writeFileSync(path.join(extracted, 'source-selection.json'), JSON.stringify(selection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(extracted, destination);
        return packageRoot;
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function checkedPlan(root, file) {
    const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
    if (!relative.startsWith('.peanut/upgrades/plans/')) fail('PEANUT_UPGRADE_PLAN_OUTSIDE_STATE');
    const absolute = projectPath(root, relative);
    existingFileWithin(root, absolute, 'PEANUT_UPGRADE_PLAN_REQUIRED');
    const plan = readJsonObject(absolute);
    if (plan.protocol !== 'peanut.scaffold-upgrade-plan.v2' || !['ready', 'blocked'].includes(plan.status)) fail('PEANUT_UPGRADE_PLAN_INVALID');
    return { absolute, plan };
}

function bindingPath(root, absolute) {
    return projectPath(root, `.peanut/upgrades/engine-bindings/${sha256(path.relative(root, absolute))}.json`);
}

function assertPlanSource(plan, selection) {
    const target = plan.identity?.to;
    const targetSource = selection.adoption ? selection.source : selection.release_source;
    if (target?.source_commit !== targetSource.commit || target?.source_tree !== targetSource.tree
        || target?.inventory_sha256 !== targetSource.inventory_sha256
        || (selection.adoption ? target?.release_version : target?.version) !== selection.target_version) fail('PEANUT_UPGRADE_PLAN_SOURCE_MISMATCH');
    if (plan.identity?.from?.version !== selection.current_version) fail('PEANUT_UPGRADE_PLAN_SOURCE_MISMATCH');
    if (!isDeepStrictEqual(plan.identity?.from?.generation_source, selection.installed_source)) fail('PEANUT_UPGRADE_PLAN_SOURCE_MISMATCH');
    if (!selection.adoption) {
        const expected = { repository: REPOSITORY, requested_ref: selection.requested_ref,
            channel: selection.target_version.includes('-') ? 'prerelease' : 'stable',
            commit: selection.source.commit, tree: selection.source.tree,
            release_lock_sha256: `sha256:${selection.candidate_lock_sha256}` };
        const generated = plan.identity?.target_generation_source;
        if (!isDeepStrictEqual(plan.identity?.source_selection, expected)
            || generated?.repository !== REPOSITORY || generated?.requested_ref !== selection.requested_ref
            || generated?.channel !== expected.channel || generated?.release_version !== selection.target_version
            || generated?.commit !== selection.source.commit || generated?.tree !== selection.source.tree
            || generated?.inventory_sha256 !== selection.source.inventory_sha256
            || !digest(generated?.edition_profile_sha256)) fail('PEANUT_UPGRADE_PLAN_SOURCE_MISMATCH');
    }
    if (selection.adoption && (plan.identity?.kind !== 'release-adoption'
        || !isDeepStrictEqual(plan.identity?.from?.generation_source, selection.installed_source)
        || plan.identity?.to?.release_version !== selection.target_version
        || plan.identity?.release_seal?.manifest_sha256 !== `sha256:${selection.scaffold_manifest_sha256}`
        || plan.identity?.release_seal?.source_commit !== selection.release_source.commit
        || plan.identity?.release_seal?.source_tree !== selection.release_source.tree
        || plan.identity?.release_seal?.inventory_sha256 !== selection.release_source.inventory_sha256
        || !isDeepStrictEqual(plan.identity?.source_proof, { repository: REPOSITORY, requested_ref: selection.requested_ref,
            channel: selection.target_version.includes('-') ? 'prerelease' : 'stable', release_version: selection.target_version,
            commit: selection.source.commit, tree: selection.source.tree,
            release_lock_sha256: `sha256:${selection.candidate_lock_sha256}` }))) fail('PEANUT_UPGRADE_PLAN_SOURCE_MISMATCH');
}

function bindPlan(root, output, selection) {
    const { absolute, plan } = checkedPlan(root, output.plan_path);
    assertPlanSource(plan, selection);
    if (plan.plan_sha256 !== output.plan_sha256) fail('PEANUT_UPGRADE_NATIVE_PLAN_INVALID');
    const receipt = { schema_version: 1, protocol: 'peanut.cli-upgrade-engine-binding.v1',
        plan_path: path.relative(root, absolute).split(path.sep).join('/'),
        plan_file_sha256: sha256File(absolute), native_plan_sha256: plan.plan_sha256, selection };
    const file = bindingPath(root, absolute);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    if (fs.existsSync(file)) {
        existingFileWithin(root, file, 'PEANUT_UPGRADE_ENGINE_BINDING_INVALID');
        if (fs.readFileSync(file, 'utf8') !== bytes) fail('PEANUT_UPGRADE_ENGINE_BINDING_MISMATCH');
    } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return absolute;
}

function boundSelection(root, absolute, plan) {
    const file = bindingPath(root, absolute);
    existingFileWithin(root, file, 'PEANUT_UPGRADE_ENGINE_BINDING_REQUIRED');
    const receipt = readJsonObject(file);
    if (receipt.schema_version !== 1 || receipt.protocol !== 'peanut.cli-upgrade-engine-binding.v1'
        || receipt.plan_path !== path.relative(root, absolute).split(path.sep).join('/')
        || receipt.plan_file_sha256 !== sha256File(absolute)
        || receipt.native_plan_sha256 !== plan.plan_sha256) fail('PEANUT_UPGRADE_PLAN_BINDING_MISMATCH');
    const selection = receipt.selection;
    assertPlanSource(plan, selection);
    const proof = releaseLockPath(root, selection);
    existingFileWithin(root, proof, 'PEANUT_UPGRADE_RELEASE_LOCK_REQUIRED');
    if (sha256File(proof) !== selection.candidate_lock_sha256) fail('PEANUT_UPGRADE_RELEASE_LOCK_MISMATCH');
    checkedEngine(root, selection);
    if (!selection.adoption) {
        const packageRoot = projectPath(root, `.peanut/upgrades/packages/${selection.artifact.archive.sha256}/${selection.artifact.archive.root}`);
        authenticateTransport(packageRoot, selection);
    }
    return selection;
}

function planResult(root, selection, plan) {
    return { status: plan.status, scope: 'development APP upstream scaffold; no runtime/database migration or production deployment',
        selection, plan, ...riskFields(selection), conflict_resolution: plan.status === 'blocked' ? {
            message: 'Review every conflict; preserve downstream customization or explicitly replace each managed path. The native engine rejects missing, stale or overlapping decisions.',
            command: `peanut upgrade --apply-plan ${shellQuote(plan.plan_path)} --confirm-plan-sha256 ${shellQuote(plan.plan_sha256)} --preserve-paths '<comma-separated-paths|->' --replace-paths '<comma-separated-paths|->'${majorRisk(selection) ? ' --confirm-major-upgrade' : ''} --path ${shellQuote(root)}`,
            ...(majorRisk(selection) ? { major_confirmation_note: 'Cross-major apply also requires human authorization and --confirm-major-upgrade after reviewing the resolved plan.' } : {}),
        } : null };
}

function verifiedCurrentSource(root, selection) {
    const current = validateApplicationManifest(root).generation_source;
    if (current?.repository !== REPOSITORY || current.requested_ref !== selection.requested_ref
        || current.channel !== (selection.target_version.includes('-') ? 'prerelease' : 'stable')
        || current.release_version !== selection.target_version
        || current.commit !== selection.source.commit || current.tree !== selection.source.tree
        || current.inventory_sha256 !== selection.source.inventory_sha256
        || !digest(current.edition_profile_sha256)) fail('PEANUT_UPGRADE_CURRENT_SOURCE_MISMATCH');
    return current;
}

export async function upgradeProject(options = {}, fetcher = fetch) {
    const root = projectRoot(options.path ?? process.cwd());
    const application = validateApplicationManifest(root);
    if (options.applyPlan || options.recoverPlan) {
        const { absolute, plan } = checkedPlan(root, options.applyPlan ?? options.recoverPlan);
        const selection = boundSelection(root, absolute, plan);
        if (options.recoverPlan) return { status: 'recovered', recovery: native(root, selection,
            selection.adoption ? 'release-adoption-recover' : 'recover', [`--plan=${absolute}`]) };
        let selected = plan;
        let planPath = absolute;
        if (options.confirmPlanSha256 || options.preservePaths || options.replacePaths) {
            if (!options.confirmPlanSha256 || !options.preservePaths || !options.replacePaths) fail('PEANUT_UPGRADE_RESOLUTION_ARGUMENTS_REQUIRED');
            selected = native(root, selection, 'resolve', [`--plan=${absolute}`, `--confirm-plan-sha256=${options.confirmPlanSha256}`, `--preserve-paths=${options.preservePaths}`, `--replace-paths=${options.replacePaths}`]);
            planPath = bindPlan(root, selected, selection);
        }
        if (selected.status === 'blocked') return planResult(root, selection, { ...selected, plan_path: planPath });
        if (majorRisk(selection) && !options.confirmMajorUpgrade) return confirmationRequired(root, selection, planPath, selected);
        const applied = native(root, selection, selection.adoption ? 'release-adoption-apply' : 'apply', [`--plan=${planPath}`]);
        const verified = native(root, selection, selection.adoption ? 'release-adoption-verify' : 'verify', [`--plan=${planPath}`]);
        return { status: verified.status, plan_path: planPath, applied, verified,
            current_source: verifiedCurrentSource(root, selection), ...riskFields(selection),
            message: 'The local APP absorbed and aligned with the selected Peanut source. Production remains unchanged; APP release and production upgrade are separate steps.' };
    }
    const selection = await discoverUpgrade(application, options, fetcher);
    if (options.check || !['available', 'release_adoption_available'].includes(selection.status)) return { status: selection.status, selection, ...riskFields(selection), scope: 'release metadata only; application files and upgrade state unchanged' };
    if (selection.origin_channel === 'development' && !options.ref) return { status: 'explicit_release_ref_required', selection,
        ...riskFields(selection), message: 'Select the published release explicitly with --ref before planning or applying a development source transition.' };
    if (selection.adoption) {
        acquireEngine(root, selection);
        const lock = await acquireReleaseLock(root, selection, fetcher);
        const releaseManifest = projectPath(root, `.peanut/upgrades/engines/${selection.source.commit}/scaffold/releases/v${selection.target_version}/scaffold-manifest.json`);
        const proofArgs = [`--release-manifest=${releaseManifest}`, `--release-lock=${lock}`, `--source-repository=${REPOSITORY}`,
            `--source-ref=${selection.requested_ref}`, `--source-channel=${selection.target_version.includes('-') ? 'prerelease' : 'stable'}`,
            `--source-commit=${selection.source.commit}`, `--source-tree=${selection.source.tree}`,
            `--release-version=${selection.target_version}`, `--release-lock-sha256=sha256:${selection.candidate_lock_sha256}`];
        const plan = native(root, selection, 'release-adoption-plan', proofArgs);
        if (plan.protocol !== 'peanut.scaffold-upgrade-plan.v2' || plan.status !== 'ready' || typeof plan.plan_path !== 'string') fail('PEANUT_UPGRADE_NATIVE_PLAN_INVALID');
        const planPath = bindPlan(root, plan, selection);
        if (options.plan) return planResult(root, selection, { ...plan, plan_path: planPath });
        if (majorRisk(selection) && !options.confirmMajorUpgrade) return confirmationRequired(root, selection, planPath, plan);
        const applied = native(root, selection, 'release-adoption-apply', [`--plan=${planPath}`]);
        const verified = native(root, selection, 'release-adoption-verify', [`--plan=${planPath}`]);
        return { status: verified.status, selection, plan_path: planPath, applied, verified,
            current_source: verifiedCurrentSource(root, selection), ...riskFields(selection),
            message: 'The local APP absorbed and aligned with the selected Peanut source. Production remains unchanged; APP release and production upgrade are separate steps.' };
    }
    const packageRoot = await acquirePackage(root, selection, fetcher);
    acquireEngine(root, selection);
    const releaseLock = await acquireReleaseLock(root, selection, fetcher);
    const plan = native(root, selection, 'preflight', [`--package=${packageRoot}`,
        `--release-lock=${releaseLock}`,
        `--source-repository=${REPOSITORY}`, `--source-ref=${selection.requested_ref}`,
        `--source-channel=${selection.target_version.includes('-') ? 'prerelease' : 'stable'}`,
        `--source-commit=${selection.source.commit}`, `--source-tree=${selection.source.tree}`,
        `--release-lock-sha256=sha256:${selection.candidate_lock_sha256}`]);
    if (plan.protocol !== 'peanut.scaffold-upgrade-plan.v2' || !['ready', 'blocked'].includes(plan.status) || typeof plan.plan_path !== 'string') fail('PEANUT_UPGRADE_NATIVE_PLAN_INVALID');
    bindPlan(root, plan, selection);
    const result = planResult(root, selection, plan);
    if (options.plan || plan.status === 'blocked') return result;
    const planPath = checkedPlan(root, plan.plan_path).absolute;
    if (majorRisk(selection) && !options.confirmMajorUpgrade) return confirmationRequired(root, selection, planPath, plan);
    try {
        const applied = native(root, selection, 'apply', [`--plan=${planPath}`]);
        const verified = native(root, selection, 'verify', [`--plan=${planPath}`]);
        return { ...result, status: verified.status, applied, verified,
            current_source: verifiedCurrentSource(root, selection),
            message: 'The local APP absorbed and aligned with the selected Peanut source. Production remains unchanged; APP release and production upgrade are separate steps.' };
    } catch (error) {
        throw new Error(`${error.message}\nRecovery: peanut upgrade --recover-plan ${JSON.stringify(planPath)} --path ${JSON.stringify(root)} (review native journal first)`);
    }
}
