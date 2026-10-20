import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { compareSemver, existingFileWithin, projectPath, projectRoot, readJsonObject, sha256, sha256File, validateApplicationManifest, validateSemver } from './protocol.js';
import { OFFICIAL_REPOSITORY, RELEASE_API, githubJson } from './release-source.js';
import { selectTemplatePackage } from './create-project.js';
import { validateTemplatePackage } from './template-package.js';

const REPOSITORY = OFFICIAL_REPOSITORY;
const sourceIdentity = (value) => value && /^[a-f0-9]{40}$/.test(value.commit) && /^[a-f0-9]{40}$/.test(value.tree);
const fail = (code) => { throw new Error(`PEANUT_UPGRADE_${code}`); };
const major = (version) => validateSemver(version).split('.')[0];
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** A normal update stays within the installed major; explicit refs may cross it. */
export async function discoverUpgrade(application, options = {}, fetcher = fetch) {
    const current = validateSemver(application.template.version);
    let selectedOptions = { ...options, edition: application.application.edition };
    if (!options.archive && !options.manifest && !options.ref) {
        const channel = options.channel ?? 'stable';
        if (!['stable', 'prerelease'].includes(channel)) fail('CHANNEL_INVALID');
        const candidates = [];
        for (let page = 1; page <= 20; page++) {
            const releases = await githubJson(`${RELEASE_API}?per_page=100&page=${page}`, fetcher);
            if (!Array.isArray(releases)) fail('RELEASE_RESPONSE_INVALID');
            for (const release of releases) {
                try {
                    const version = validateSemver(release.tag_name?.replace(/^v/, ''));
                    if (!release.draft && major(version) === major(current)
                        && (channel === 'stable' ? !release.prerelease && !version.includes('-') : release.prerelease && version.includes('-'))) candidates.push(version);
                } catch { /* Ignore non-product tags. */ }
            }
            if (releases.length < 100) break;
            if (page === 20) fail('DISCOVERY_LIMIT');
        }
        candidates.sort((a, b) => compareSemver(b, a));
        if (!candidates.length) fail('RELEASE_NOT_FOUND');
        selectedOptions = { ...selectedOptions, ref: 'v' + candidates[0], channel };
    }
    if (selectedOptions.ref && !selectedOptions.channel) selectedOptions.channel = selectedOptions.ref.includes('-') ? 'prerelease' : 'stable';
    const selected = await selectTemplatePackage(selectedOptions, fetcher);
    const target = selected.metadata.version;
    const origin = application.generation_source;
    const same = origin?.commit === selected.metadata.source.commit && origin?.tree === selected.metadata.source.tree
        && origin?.inventory_sha256 === selected.metadata.source.inventory_sha256;
    const comparison = compareSemver(target, current);
    const relation = selected.provenance.channel === 'development' ? { kind: 'explicit_local_selection', content: same ? 'equivalent' : 'different' }
        : await classifySource(origin, { source: selected.metadata.source }, fetcher);
    let status = comparison < 0 ? 'source_range_unsupported' : comparison === 0 ? same ? 'up_to_date' : 'source_identity_mismatch' : 'available';
    if (selected.provenance.channel !== 'development') {
        if (relation.kind === 'unknown') status = 'source_identity_unknown';
        else if (origin?.channel === 'development' && ['ahead', 'diverged'].includes(relation.kind)) status = 'source_' + relation.kind;
        else if (comparison === 0 && relation.content === 'equivalent' && origin?.channel === 'development') status = 'release_adoption_available';
    }
    return { status, source_relation: relation, current_version: current, target_version: target,
        major_change: major(current) !== major(target) || origin?.channel === 'development' && selected.provenance.channel !== 'development', selected };
}

function cacheRoot(root, metadata) {
    if (!digest(metadata.archive?.sha256)) fail('PACKAGE_IDENTITY_INVALID');
    return projectPath(root, `.peanut/upgrades/template-packages/${metadata.archive.sha256}`);
}
function checkedPackage(root, metadata) {
    const directory = cacheRoot(root, metadata);
    const archive = projectPath(directory, metadata.archive.name);
    const sidecar = projectPath(directory, 'template-package.json');
    existingFileWithin(root, archive, 'PEANUT_UPGRADE_PACKAGE_REQUIRED');
    existingFileWithin(root, sidecar, 'PEANUT_UPGRADE_PACKAGE_REQUIRED');
    if (!isDeepStrictEqual(readJsonObject(sidecar), metadata)) fail('PACKAGE_METADATA_CHANGED');
    const bundle = validateTemplatePackage(metadata, fs.readFileSync(archive), metadata.edition);
    const declared = new Set([metadata.archive.name, 'template-package.json']);
    for (const [relative, member] of bundle.members) {
        const file = projectPath(directory, relative);
        existingFileWithin(directory, file, 'PEANUT_UPGRADE_ENGINE_SOURCE_INVALID');
        if (!fs.readFileSync(file).equals(member.bytes) || (fs.statSync(file).mode & 0o777) !== member.mode) fail('ENGINE_CONTENT_MISMATCH');
        declared.add(relative);
    }
    function visit(folder, prefix = '') {
        for (const child of fs.readdirSync(folder, { withFileTypes: true })) {
            const relative = prefix + child.name;
            const file = projectPath(directory, relative);
            if (child.isDirectory()) visit(file, relative + '/');
            else if (!declared.has(relative)) fail('ENGINE_UNDECLARED_INPUT');
        }
    }
    visit(directory);
    return projectPath(directory, 'files/scripts/scaffold-upgrade');
}
function acquirePackage(root, selected) {
    const destination = cacheRoot(root, selected.metadata);
    if (!fs.existsSync(destination)) {
        const parent = projectPath(root, '.peanut/upgrades/template-packages');
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const stage = fs.mkdtempSync(path.join(parent, '.template-'));
        try {
            fs.writeFileSync(path.join(stage, selected.metadata.archive.name), selected.archive, { flag: 'wx', mode: 0o600 });
            fs.writeFileSync(path.join(stage, 'template-package.json'), JSON.stringify(selected.metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
            for (const [relative, member] of selected.bundle.members) {
                const file = projectPath(stage, relative);
                fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
                fs.writeFileSync(file, member.bytes, { flag: 'wx', mode: member.mode });
                fs.chmodSync(file, member.mode);
            }
            fs.renameSync(stage, destination);
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
    return checkedPackage(root, selected.metadata);
}
function checkedEngine(root, metadata) {
    const entry = checkedPackage(root, metadata);
    if (!metadata.upgrade_tooling_sha256) fail('TEMPLATE_TOOLING_REQUIRED');
    return entry;
}
function native(root, metadata, command, args) {
    const result = spawnSync('php', [checkedEngine(root, metadata), command, `--project-root=${root}`, `--tooling-autoload=${path.join(cacheRoot(root, metadata), 'tooling/vendor/autoload.php')}`, ...args],
        { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) fail(`NATIVE_FAILED: ${command}: ${result.error.message}`);
    let output;
    try { output = JSON.parse(result.stdout); } catch { fail(`NATIVE_OUTPUT_INVALID: ${result.stderr.trim()}`); }
    if (result.error || result.stderr.trim() || !(result.status === 0 || (result.status === 2 && ['template-plan', 'resolve'].includes(command) && output.status === 'blocked'))) fail(`NATIVE_FAILED: ${command}: ${result.error?.message ?? result.stderr.trim()}`);
    return output;
}
function checkedPlan(root, input) {
    const relative = path.relative(root, path.resolve(root, input)).split(path.sep).join('/');
    if (!relative.startsWith('.peanut/upgrades/plans/')) fail('PLAN_OUTSIDE_STATE');
    const absolute = projectPath(root, relative);
    existingFileWithin(root, absolute, 'PEANUT_UPGRADE_PLAN_REQUIRED');
    const plan = readJsonObject(absolute);
    if (plan.protocol !== 'peanut.scaffold-upgrade-plan.v2' || !['ready', 'blocked'].includes(plan.status)) fail('PLAN_INVALID');
    return { absolute, relative, plan };
}
function bindingPath(root, relative) { return projectPath(root, `.peanut/upgrades/engine-bindings/${sha256(relative)}.json`); }
function bindPlan(root, output, selection) {
    const saved = checkedPlan(root, output.plan_path);
    const target = saved.plan.identity?.to;
    const metadata = selection.metadata;
    if (saved.plan.plan_sha256 !== output.plan_sha256 || target?.version !== metadata.version
        || target?.source_commit !== metadata.source.commit || target?.source_tree !== metadata.source.tree
        || target?.inventory_sha256 !== metadata.source.inventory_sha256
        || saved.plan.manifest_paths?.to !== path.join(cacheRoot(root, metadata), 'scaffold-manifest.json')) fail('PLAN_SOURCE_MISMATCH');
    const receipt = { protocol: 'peanut.cli-template-upgrade-binding.v1', root, plan_path: saved.relative,
        plan_file_sha256: sha256File(saved.absolute), plan_sha256: output.plan_sha256, ...selection };
    const file = bindingPath(root, saved.relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    if (fs.existsSync(file)) {
        existingFileWithin(root, file, 'PEANUT_UPGRADE_BINDING_INVALID');
        if (fs.readFileSync(file, 'utf8') !== bytes) fail('BINDING_MISMATCH');
    } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return saved;
}

export async function upgradeProject(options = {}, fetcher = fetch) {
    const root = projectRoot(options.path ?? process.cwd());
    if (options.applyPlan || options.recoverPlan) {
        const saved = checkedPlan(root, options.applyPlan ?? options.recoverPlan);
        const file = bindingPath(root, saved.relative);
        existingFileWithin(root, file, 'PEANUT_UPGRADE_BINDING_REQUIRED');
        const binding = readJsonObject(file);
        if (binding.protocol !== 'peanut.cli-template-upgrade-binding.v1' || binding.root !== root
            || binding.plan_path !== saved.relative || binding.plan_file_sha256 !== sha256File(saved.absolute)
            || binding.plan_sha256 !== saved.plan.plan_sha256) fail('PLAN_BINDING_MISMATCH');
        const selection = { metadata: binding.metadata, provenance: binding.provenance, major_change: binding.major_change };
        bindPlan(root, { ...saved.plan, plan_path: saved.absolute }, selection);
        checkedEngine(root, selection.metadata);
        if (options.recoverPlan) return { status: 'recovered', recovery: native(root, selection.metadata, 'recover', [`--plan=${saved.absolute}`]) };
        let chosen = saved;
        if (options.confirmPlanSha256 || options.preservePaths || options.replacePaths) {
            if (!options.confirmPlanSha256 || !options.preservePaths || !options.replacePaths) fail('RESOLUTION_ARGUMENTS_REQUIRED');
            const resolved = native(root, selection.metadata, 'resolve', [`--plan=${saved.absolute}`, `--confirm-plan-sha256=${options.confirmPlanSha256}`, `--preserve-paths=${options.preservePaths}`, `--replace-paths=${options.replacePaths}`]);
            chosen = bindPlan(root, resolved, selection);
        }
        if (chosen.plan.status === 'blocked') return { status: 'blocked', plan_path: chosen.absolute, plan: chosen.plan };
        if (selection.major_change && !options.confirmMajorUpgrade) return { status: 'confirmation_required', plan_path: chosen.absolute, risk: 'major_version_change' };
        const applied = native(root, selection.metadata, 'apply', [`--plan=${chosen.absolute}`]);
        const verified = native(root, selection.metadata, 'verify', [`--plan=${chosen.absolute}`]);
        return { status: verified.status, plan_path: chosen.absolute, applied, verified, scope: 'APP source only; runtime adoption and production unchanged' };
    }
    const application = validateApplicationManifest(root);
    const discovery = await discoverUpgrade(application, options, fetcher);
    const { selected, ...summary } = discovery;
    if (options.check || !['available', 'release_adoption_available'].includes(discovery.status)) return { ...summary, metadata: selected.metadata, scope: 'metadata/archive validation only; APP unchanged' };
    acquirePackage(root, selected);
    checkedEngine(root, selected.metadata);
    const args = [`--template-manifest=${path.join(cacheRoot(root, selected.metadata), 'scaffold-manifest.json')}`];
    if (options.baselineModeManifest) args.push(`--baseline-mode-manifest=${path.resolve(options.baselineModeManifest)}`);
    {
        const metadataPath = path.join(cacheRoot(root, selected.metadata), 'template-package.json');
        args.push(`--source-repository=${OFFICIAL_REPOSITORY}`, `--source-ref=${selected.provenance.requested_ref}`,
            `--source-channel=${selected.provenance.channel}`, `--source-commit=${selected.metadata.source.commit}`, `--source-tree=${selected.metadata.source.tree}`,
            `--template-package-manifest=${metadataPath}`, `--template-package-sha256=sha256:${sha256File(metadataPath)}`);
    }
    const plan = native(root, selected.metadata, 'template-plan', args);
    const saved = bindPlan(root, plan, { metadata: selected.metadata, provenance: selected.provenance, major_change: discovery.major_change });
    return { status: plan.status, plan_path: saved.absolute, plan, scope: 'APP source plan only; use --apply-plan after review; runtime and production unchanged' };
}

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
    if (generation.commit === fixed.source.commit) {
        if (generation.tree !== fixed.source.tree) return unknown('generation_source_tree_invalid');
    } else {
        try {
            const commit = await githubJson(`https://api.github.com/repos/${REPOSITORY}/git/commits/${generation.commit}`, fetcher);
            if (commit?.sha !== generation.commit || commit.tree?.sha !== generation.tree) return unknown('generation_source_tree_invalid');
        } catch { return unknown('generation_source_commit_unavailable'); }
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
