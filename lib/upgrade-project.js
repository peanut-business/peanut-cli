import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { checkoutSource } from './create-project.js';
import { compareSemver, existingFileWithin, projectPath, projectRoot, readJsonObject, sha256, sha256File, validateApplicationManifest, validateSemver } from './protocol.js';

const REPOSITORY = 'peanut-business/peanut-admin-code';
const API = `https://api.github.com/repos/${REPOSITORY}/releases`;
const fail = (code) => { throw new Error(code); };
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sourceIdentity = (value) => value && /^[a-f0-9]{40}$/.test(value.commit) && /^[a-f0-9]{40}$/.test(value.tree);

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
    const channel = options.channel ?? (current.includes('-') ? 'prerelease' : 'stable');
    if (!['stable', 'prerelease'].includes(channel)) fail('PEANUT_UPGRADE_CHANNEL_INVALID');
    let release;
    if (options.ref) {
        const version = validateSemver(options.ref.replace(/^v/, ''));
        release = await request(`${API}/tags/${encodeURIComponent(`v${version}`)}`, false, fetcher);
    } else {
        const candidates = [];
        for (let page = 1; ; page += 1) {
            const releases = await request(`${API}?per_page=100&page=${page}`, false, fetcher);
            if (!Array.isArray(releases)) fail('PEANUT_UPGRADE_RELEASE_RESPONSE_INVALID');
            for (const item of releases) {
                if (item.draft || typeof item.tag_name !== 'string') continue;
                let version;
                try { version = validateSemver(item.tag_name.replace(/^v/, '')); } catch { continue; }
                if ((channel === 'stable' && (item.prerelease || version.includes('-'))) || version.split('.')[0] !== current.split('.')[0]) continue;
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
    if (version.split('.')[0] !== current.split('.')[0]) fail('PEANUT_UPGRADE_MAJOR_CHANGE_UNSUPPORTED');
    if (compareSemver(version, current) < 0) fail('PEANUT_UPGRADE_DOWNGRADE_UNSUPPORTED');
    if (options.channel === 'stable' && (release.prerelease || version.includes('-'))) fail('PEANUT_UPGRADE_CHANNEL_MISMATCH');
    const assets = release.assets;
    if (!Array.isArray(assets)) fail('PEANUT_UPGRADE_RELEASE_RESPONSE_INVALID');
    // A first published baseline legitimately has no upgrade asset. Equality needs
    // only release identity, not an install archive masquerading as an upgrade.
    if (compareSemver(version, current) === 0) {
        const manifestUrl = publicAsset(assets.find((asset) => asset.name === 'RELEASE_MANIFEST.json'), 'RELEASE_MANIFEST.json', release.tag_name);
        const lockUrl = publicAsset(assets.find((asset) => asset.name === 'RELEASE_CANDIDATE_LOCK.json'), 'RELEASE_CANDIDATE_LOCK.json', release.tag_name);
        const manifest = await request(manifestUrl, false, fetcher);
        const lockBytes = await request(lockUrl, true, fetcher);
        let lock;
        try { lock = JSON.parse(lockBytes); } catch { fail('PEANUT_UPGRADE_RELEASE_IDENTITY_INVALID'); }
        if (manifest.version !== version || manifest.tag !== release.tag_name
            || manifest.repository !== `https://github.com/${REPOSITORY}`
            || manifest.candidate_lock?.sha256 !== sha256(lockBytes)
            || lock.protocol !== 'peanut.release-candidate-lock.v1' || lock.version !== version
            || lock.tag !== release.tag_name || !sourceIdentity(lock.candidate)
            || manifest.commit !== lock.candidate.commit) fail('PEANUT_UPGRADE_RELEASE_IDENTITY_INVALID');
        const installedSource = { commit: application.template.source_commit ?? null, tree: application.template.source_tree ?? null };
        const differs = (installedSource.commit !== null && installedSource.commit !== lock.candidate.commit)
            || (installedSource.tree !== null && installedSource.tree !== lock.candidate.tree);
        const alignment = differs ? 'different' : sourceIdentity(installedSource) ? 'aligned' : 'unknown';
        return { repository: manifest.repository, ref: release.tag_name, channel, current_version: current,
            target_version: version, status: differs ? 'source_identity_mismatch' : alignment === 'aligned' ? 'up_to_date' : 'version_current',
            installed_source: installedSource, source_alignment: alignment, source: lock.candidate, manifest_url: manifestUrl,
            candidate_lock_url: lockUrl, candidate_lock_sha256: sha256(lockBytes) };
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
    if (compatibility?.major_policy !== 'same-major' || compatibility.source?.maximum_exclusive !== version
        || (compareSemver(version, current) > 0 && compareSemver(current, compatibility.source.minimum_inclusive) < 0)) fail('PEANUT_UPGRADE_SOURCE_VERSION_UNSUPPORTED');
    return { repository: `https://github.com/${REPOSITORY}`, ref: release.tag_name, channel, current_version: current,
        target_version: version, status: compareSemver(version, current) === 0 ? 'up_to_date' : 'available',
        source: artifact.source, artifact, archive_url: archiveUrl, manifest_url: manifestUrl };
}

function sourceGit(checkout, ...args) {
    const result = spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail('PEANUT_UPGRADE_ENGINE_SOURCE_INVALID');
    return result.stdout;
}

function checkedEngine(root, selection) {
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
    // Even ignored files can shadow native require candidates. No extra file is
    // allowed anywhere in the engine checkout outside Git's own metadata.
    function checkFiles(directory, prefix = '') {
        for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
            if (prefix === '' && child.name === '.git') continue;
            const relative = prefix + child.name;
            if (child.isDirectory()) checkFiles(path.join(directory, child.name), relative + '/');
            else if (!tracked.has(relative) || !child.isFile()) fail('PEANUT_UPGRADE_ENGINE_UNTRACKED_CONTENT');
        }
    }
    checkFiles(checkout);
    if (sha256File(projectPath(checkout, 'scaffold/application-template-inventory.json')) !== selection.source.inventory_sha256) fail('PEANUT_UPGRADE_ENGINE_INVENTORY_MISMATCH');
    return entry;
}

function acquireEngine(root, selection) {
    const checkout = projectPath(root, `.peanut/upgrades/engines/${selection.source.commit}`);
    if (!fs.existsSync(checkout)) {
        const parent = projectPath(root, '.peanut/upgrades/engines');
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const stage = fs.mkdtempSync(path.join(parent, '.source-'));
        try {
            checkoutSource(selection.repository + '.git', selection.ref, path.join(stage, 'source'));
            fs.renameSync(path.join(stage, 'source'), checkout);
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
    return checkedEngine(root, selection);
}

function native(root, selection, command, args) {
    const entry = checkedEngine(root, selection);
    const result = spawnSync('php', [entry, command, `--project-root=${root}`, ...args], { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${result.error.message}`);
    let output;
    try { output = JSON.parse(result.stdout); } catch {
        fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${command}: ${(result.stderr || result.stdout).trim()}`);
    }
    if (result.status !== 0 && !(result.status === 2 && output?.status === 'blocked')) {
        fail(`PEANUT_UPGRADE_NATIVE_FAILED: ${command}: ${output?.error ?? result.stderr.trim()}`);
    }
    if (!output || typeof output !== 'object') fail('PEANUT_UPGRADE_NATIVE_OUTPUT_INVALID');
    const expected = { apply: 'applied', verify: 'verified', recover: 'recovered', resolve: 'ready' }[command];
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
    if (target?.source_commit !== selection.source.commit || target?.source_tree !== selection.source.tree
        || target?.inventory_sha256 !== selection.source.inventory_sha256 || target?.version !== selection.target_version) fail('PEANUT_UPGRADE_PLAN_SOURCE_MISMATCH');
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
    checkedEngine(root, selection);
    const packageRoot = projectPath(root, `.peanut/upgrades/packages/${selection.artifact.archive.sha256}/${selection.artifact.archive.root}`);
    authenticateTransport(packageRoot, selection);
    return selection;
}

function planResult(selection, plan) {
    return { status: plan.status, scope: 'development APP upstream scaffold; no runtime/database migration or production deployment',
        selection, plan, conflict_resolution: plan.status === 'blocked' ? {
            message: 'Review every conflict; preserve downstream customization or explicitly replace each managed path. The native engine rejects missing, stale or overlapping decisions.',
            command: `peanut upgrade --apply-plan ${JSON.stringify(plan.plan_path)} --confirm-plan-sha256 ${plan.plan_sha256} --preserve-paths <comma-separated-paths|-> --replace-paths <comma-separated-paths|->`,
        } : null };
}

export async function upgradeProject(options = {}, fetcher = fetch) {
    const root = projectRoot(options.path ?? process.cwd());
    const application = validateApplicationManifest(root);
    if (options.applyPlan || options.recoverPlan) {
        const { absolute, plan } = checkedPlan(root, options.applyPlan ?? options.recoverPlan);
        const selection = boundSelection(root, absolute, plan);
        if (options.recoverPlan) return { status: 'recovered', recovery: native(root, selection, 'recover', [`--plan=${absolute}`]) };
        let selected = plan;
        let planPath = absolute;
        if (options.confirmPlanSha256 || options.preservePaths || options.replacePaths) {
            if (!options.confirmPlanSha256 || !options.preservePaths || !options.replacePaths) fail('PEANUT_UPGRADE_RESOLUTION_ARGUMENTS_REQUIRED');
            selected = native(root, selection, 'resolve', [`--plan=${absolute}`, `--confirm-plan-sha256=${options.confirmPlanSha256}`, `--preserve-paths=${options.preservePaths}`, `--replace-paths=${options.replacePaths}`]);
            planPath = bindPlan(root, selected, selection);
        }
        if (selected.status === 'blocked') return planResult(null, { ...selected, plan_path: planPath });
        const applied = native(root, selection, 'apply', [`--plan=${planPath}`]);
        const verified = native(root, selection, 'verify', [`--plan=${planPath}`]);
        return { status: verified.status, plan_path: planPath, applied, verified };
    }
    const selection = await discoverUpgrade(application, options, fetcher);
    if (options.check || selection.status !== 'available') return { status: selection.status, selection, scope: 'release metadata only; application files and upgrade state unchanged' };
    const packageRoot = await acquirePackage(root, selection, fetcher);
    acquireEngine(root, selection);
    const plan = native(root, selection, 'preflight', [`--package=${packageRoot}`]);
    if (plan.protocol !== 'peanut.scaffold-upgrade-plan.v2' || !['ready', 'blocked'].includes(plan.status) || typeof plan.plan_path !== 'string') fail('PEANUT_UPGRADE_NATIVE_PLAN_INVALID');
    bindPlan(root, plan, selection);
    const result = planResult(selection, plan);
    if (options.plan || plan.status === 'blocked') return result;
    const planPath = checkedPlan(root, plan.plan_path).absolute;
    try {
        const applied = native(root, selection, 'apply', [`--plan=${planPath}`]);
        const verified = native(root, selection, 'verify', [`--plan=${planPath}`]);
        return { ...result, status: verified.status, applied, verified };
    } catch (error) {
        throw new Error(`${error.message}\nRecovery: peanut upgrade --recover-plan ${JSON.stringify(planPath)} --path ${JSON.stringify(root)} (review native journal first)`);
    }
}
