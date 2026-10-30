import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { compareSemver, existingFileWithin, projectPath, projectRoot, readJsonObject, sha256, sha256File, sourceIdentityOf as readSourceIdentity, validateSourceIdentity, validateApplicationManifest, validateSemver } from './protocol.js';
import { OFFICIAL_REPOSITORY, githubJson, officialSource, officialReleaseVersion, listOfficialReleases } from './release-source.js';
import { selectTemplatePackage } from './create-project.js';
import { validateTemplatePackage } from './template-package.js';
import { sourceSnapshotDigest } from './source-snapshot.js';

const REPOSITORY = OFFICIAL_REPOSITORY;
const sourceIdentity = (value) => {
    try { readSourceIdentity(value, true); return true; } catch { return false; }
};
const sourceIdentityOf = (value) => {
    try { return Object.hasOwn(value ?? {}, 'kind') ? validateSourceIdentity(value) : readSourceIdentity(value, true); } catch { return null; }
};
const sameSourceIdentity = (left, right) => sourceIdentityOf(left) !== null && isDeepStrictEqual(sourceIdentityOf(left), sourceIdentityOf(right));
const fail = (code) => { throw new Error(`PEANUT_UPGRADE_${code}`); };
const major = (version) => validateSemver(version).split('.')[0];
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** A normal update stays within the installed major; explicit refs may cross it. */
export async function discoverUpgrade(application, options = {}, fetcher = fetch) {
    if (options.sourceCheckout && (!options.archive || !options.manifest || options.ref || options.channel)) fail('DEVELOPMENT_SOURCE_ARGUMENTS_INVALID');
    const current = validateSemver(application.template.version);
    let selectedOptions = { ...options, edition: application.application.edition };
    if (!options.archive && !options.manifest && !options.ref) {
        const channel = options.channel ?? 'stable';
        if (!['stable', 'prerelease'].includes(channel)) fail('CHANNEL_INVALID');
        const candidates = [];
        for (const release of await listOfficialReleases(fetcher)) {
            const version = officialReleaseVersion(release);
            if (version !== null && !release.draft && major(version) === major(current)
                && (channel === 'stable' ? !release.prerelease && !version.includes('-') : release.prerelease && version.includes('-'))) candidates.push(version);
        }
        candidates.sort((a, b) => compareSemver(b, a));
        if (!candidates.length) fail('RELEASE_NOT_FOUND');
        selectedOptions = { ...selectedOptions, ref: 'v' + candidates[0], channel };
    }
    if (selectedOptions.ref && !selectedOptions.channel) selectedOptions.channel = selectedOptions.ref.includes('-') ? 'prerelease' : 'stable';
    const selected = await selectTemplatePackage(selectedOptions, fetcher);
    const target = selected.metadata.version;
    const origin = application.generation_source;
    const same = sameSourceIdentity(origin, selected.metadata.source)
        && origin?.inventory_sha256 === selected.metadata.source.inventory_sha256
        && application.template_package?.archive_sha256 === selected.metadata.archive.sha256;
    const comparison = compareSemver(target, current);
    let relation = selected.provenance.channel === 'development' ? { kind: 'explicit_local_selection', content: same ? 'equivalent' : 'different' }
        : await classifySource(origin, { source: selected.metadata.source }, fetcher);
    let status = comparison < 0 ? 'source_range_unsupported' : comparison === 0 ? same ? 'up_to_date' : 'source_identity_mismatch' : 'available';
    if (!same && comparison >= 0 && selected.provenance.channel === 'development'
        && origin?.channel === 'development' && selected.metadata.source.channel === 'development') {
        relation = developmentSuccessor(application, selected, options.sourceCheckout);
        status = ['development_successor', 'local_snapshot'].includes(relation.kind) ? 'available'
            : relation.kind === 'unknown' ? 'source_identity_unknown' : 'source_' + relation.kind;
    }
    if (selected.provenance.channel !== 'development') {
        if (relation.kind === 'unknown') status = 'source_identity_unknown';
        else if (origin?.channel === 'development' && ['ahead', 'diverged'].includes(relation.kind)) status = 'source_' + relation.kind;
        else if (comparison === 0 && relation.content === 'equivalent' && origin?.channel === 'development') status = 'release_adoption_available';
    }
    return { status, source_relation: relation, current_version: current, target_version: target,
        major_change: major(current) !== major(target) || origin?.channel === 'development' && selected.provenance.channel !== 'development', selected };
}

/** Prove an explicitly selected development successor from immutable Git objects, never live source files. */
function developmentSuccessor(application, selected, input) {
    const unknown = (reason) => ({ kind: 'unknown', content: 'unknown', reason });
    const base = application.generation_source;
    const target = selected.metadata.source;
    if (sourceIdentityOf(target)?.kind === 'local') {
        const baseIdentity = sourceIdentityOf(base);
        const targetIdentity = sourceIdentityOf(target);
        try {
            if (!baseIdentity || !targetIdentity || base.channel !== 'development' || target.channel !== 'development'
                || base.release_version !== null || target.release_version !== null
                || !/^local:[a-f0-9]{64}$/.test(String(target.requested_ref))
                || target.requested_ref !== `local:${targetIdentity.snapshot_sha256}`
                || !digest(base.inventory_sha256) || !digest(target.inventory_sha256)
                || !digest(base.edition_profile_sha256) || !digest(target.edition_profile_sha256)
                || !isDeepStrictEqual(readSourceIdentity(application.template), baseIdentity)
                || application.template?.inventory_sha256 !== base.inventory_sha256
                || application.edition?.name !== application.application.edition
                || application.edition?.source_sha256 !== base.edition_profile_sha256
                || selected.bundle.create.application_manifest.edition?.source_sha256 !== target.edition_profile_sha256
                || !['none', 'runtime', 'full'].includes(selected.metadata.workflow)
                || (application.application.workflow !== undefined && !['none', 'runtime', 'full'].includes(application.application.workflow))) {
                return unknown('local_development_identity_invalid');
            }
            if (input && sourceSnapshotDigest(projectRoot(input)) !== targetIdentity.snapshot_sha256) return unknown('local_source_snapshot_changed');
            const inventory = selected.bundle.sourceSnapshot?.inventory;
            if (!inventory) return unknown('local_source_snapshot_proof_required');
            if (inventory.protocol !== 'peanut.create-app-inventory.v2' || inventory.template_version !== selected.metadata.version) {
                return unknown('local_source_inventory_invalid');
            }
            const excluded = [];
            for (const row of inventory.files ?? []) {
                if (!Array.isArray(row.profiles) || typeof row.target !== 'string') return unknown('local_source_inventory_invalid');
                if (row.classification !== 'excluded' && row.profiles.includes(application.application.profile)
                    && !row.profiles.includes(selected.metadata.profile)) return unknown('local_source_profile_not_contained');
                if (!row.profiles.includes(application.application.profile)) excluded.push(row.target);
            }
            excluded.sort();
            return { kind: 'local_snapshot', content: 'different', base: baseIdentity, target: targetIdentity,
                base_inventory_sha256: base.inventory_sha256, target_inventory_sha256: target.inventory_sha256,
                excluded_paths: excluded };
        } catch { return unknown('local_source_snapshot_unavailable'); }
    }
    if (!input) return unknown('development_source_checkout_required');
    if (sourceIdentityOf(base)?.kind !== 'git' || sourceIdentityOf(target)?.kind !== 'git'
        || base.repository !== REPOSITORY || target.repository !== REPOSITORY || base.release_version !== null || target.release_version !== null
        || !sourceIdentity(base) || !sourceIdentity(target)
        || !/^(?:[a-f0-9]{40}|local:[a-f0-9]{64})$/.test(base.requested_ref)
        || target.requested_ref !== target.commit
        || !digest(base.inventory_sha256) || !digest(target.inventory_sha256)
        || !digest(base.edition_profile_sha256) || !digest(target.edition_profile_sha256)
        || application.template.source_commit !== base.commit || application.template.source_tree !== base.tree
        || application.template.inventory_sha256 !== base.inventory_sha256
        || application.edition?.name !== application.application.edition
        || application.edition?.source_sha256 !== base.edition_profile_sha256
        || selected.bundle.create.application_manifest.edition?.source_sha256 !== target.edition_profile_sha256
        || !['none', 'runtime', 'full'].includes(selected.metadata.workflow)
        || (application.application.workflow !== undefined && !['none', 'runtime', 'full'].includes(application.application.workflow))) return unknown('development_source_identity_invalid');
    try {
        if (typeof input !== 'string' || !path.isAbsolute(input)) return unknown('development_source_checkout_invalid');
        const checkout = projectRoot(input);
        const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
        Object.assign(gitEnvironment, { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
        const git = (...args) => {
            const result = spawnSync('git', ['--no-replace-objects', '-C', checkout, ...args],
                { encoding: 'utf8', shell: false, env: gitEnvironment, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
            if (result.error || result.signal || result.status !== 0) throw new Error('git_read_failed');
            return result.stdout;
        };
        if (fs.realpathSync(git('rev-parse', '--show-toplevel').trim()) !== checkout
            || !officialSource(git('remote', 'get-url', 'origin').trim())
            || git('rev-parse', '--is-shallow-repository').trim() !== 'false'
            || fs.existsSync(path.resolve(checkout, git('rev-parse', '--git-path', 'info/grafts').trim()))) return unknown('development_repository_invalid');
        for (const source of [base, target]) {
            const inventoryBytes = git('show', `${source.commit}:scaffold/application-template-inventory.json`);
            if (git('rev-parse', `${source.commit}^{commit}`).trim() !== source.commit
                || git('rev-parse', `${source.commit}^{tree}`).trim() !== source.tree
                || sha256(inventoryBytes) !== source.inventory_sha256
                || sha256(git('show', `${source.commit}:scaffold/edition-profiles.json`)) !== source.edition_profile_sha256) return unknown('development_git_identity_mismatch');
            const inventory = JSON.parse(inventoryBytes);
            const profile = source === base ? application.application.profile : selected.metadata.profile;
            if (typeof profile !== 'string' || !Array.isArray(inventory.files)
                || !inventory.files.some((file) => Array.isArray(file.profiles) && file.profiles.includes(profile))) return unknown('development_profile_unavailable');
        }
        const ancestor = (from, to) => {
            const result = spawnSync('git', ['--no-replace-objects', '-C', checkout, 'merge-base', '--is-ancestor', from, to],
                { encoding: 'utf8', shell: false, env: gitEnvironment, timeout: 30000, maxBuffer: 1024 * 1024 });
            if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error('git_graph_unavailable');
            return result.status === 0;
        };
        if (!ancestor(base.commit, target.commit)) return { kind: ancestor(target.commit, base.commit) ? 'ahead' : 'diverged', content: 'different' };
        return { kind: 'development_successor', content: 'different', repository: REPOSITORY,
            application_profile: application.application.profile, template_profile: selected.metadata.profile, template_workflow: selected.metadata.workflow,
            base: { commit: base.commit, tree: base.tree, inventory_sha256: base.inventory_sha256 },
            target: { commit: target.commit, tree: target.tree, inventory_sha256: target.inventory_sha256 } };
    } catch { return unknown('development_git_proof_unavailable'); }
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
}
function checkedEngine(root, metadata) {
    const entry = checkedPackage(root, metadata);
    if (!metadata.upgrade_tooling_sha256) fail('TEMPLATE_TOOLING_REQUIRED');
    return entry;
}
const coordinatorFiles = [
    'scripts/product-upgrade-host', 'server/app/common/services/installation/InstallationExecutionHost.php',
    ...['update-plan.php', 'update-database.php', 'update-preparation.py', 'update-recovery.py',
        'prepare-vendor.sh', 'prepare-vendor.php', 'vendor-state.py', 'configure-collaboration.py'].map((name) => `server/docker/scripts/${name}`),
];
function coordinatorOptions(options) {
    const values = [options.coordinatorRoot, options.coordinatorCommit, options.installationSourceCommit];
    if (values.every((value) => value === undefined)) return null;
    if (values.some((value) => typeof value !== 'string' || !value)
        || !path.isAbsolute(values[0]) || !/^[a-f0-9]{40}$/.test(values[1]) || !/^[a-f0-9]{40}$/.test(values[2])) fail('COORDINATOR_ARGUMENTS_INVALID');
    return { root: values[0], commit: values[1], initial_commit: values[2] };
}
/** Independently verify the fixed coordinator; its identity is separate from the template source. */
function checkedCoordinator(selection) {
    if (!selection || typeof selection.root !== 'string' || !path.isAbsolute(selection.root)
        || !/^[a-f0-9]{40}$/.test(selection.commit) || !/^[a-f0-9]{40}$/.test(selection.initial_commit)) fail('COORDINATOR_IDENTITY_INVALID');
    const root = selection.root;
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) fail('COORDINATOR_ROOT_INVALID');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' });
    const git = (...args) => {
        const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args],
            { env, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        if (result.error || result.signal || result.status !== 0) fail('COORDINATOR_GIT_READ_FAILED');
        return result.stdout;
    };
    const text = (...args) => git(...args).toString('utf8').trim();
    if (text('rev-parse', '--show-toplevel') !== root || text('rev-parse', 'HEAD') !== selection.commit
        || text('rev-parse', `${selection.commit}^{commit}`) !== selection.commit
        || text('rev-parse', '--is-shallow-repository') !== 'false'
        || text('for-each-ref', '--format=%(refname)', 'refs/replace/') !== ''
        || fs.existsSync(path.resolve(root, text('rev-parse', '--git-path', 'info/grafts')))
        || text('status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none') !== '') fail('COORDINATOR_REPOSITORY_INVALID');
    const tree = text('rev-parse', `${selection.commit}^{tree}`);
    if (!/^[a-f0-9]{40}$/.test(tree)) fail('COORDINATOR_TREE_INVALID');
    const rows = coordinatorFiles.map((relative) => {
        const file = path.join(root, relative);
        let current = root;
        for (const component of relative.split('/')) {
            current = path.join(current, component);
            if (fs.lstatSync(current).isSymbolicLink()) fail('COORDINATOR_FILE_INVALID');
        }
        const stat = fs.lstatSync(file);
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)\n$/.exec(git('ls-tree', selection.commit, '--', relative).toString('utf8'));
        if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file || !match || match[3] !== relative
            || (stat.mode & 0o7777) !== (match[1] === '100755' ? 0o755 : 0o644)) fail('COORDINATOR_FILE_INVALID');
        const bytes = git('cat-file', 'blob', match[2]);
        if (!fs.readFileSync(file).equals(bytes)) fail('COORDINATOR_CONTENT_MISMATCH');
        return { path: relative, mode: match[1], blob: match[2], sha256: sha256(bytes) };
    });
    const verified = { root, commit: selection.commit, tree, initial_commit: selection.initial_commit,
        closure_sha256: sha256(JSON.stringify(rows)), rows };
    if (Object.hasOwn(selection, 'rows') && !isDeepStrictEqual(selection, verified)) fail('COORDINATOR_BINDING_MISMATCH');
    return verified;
}
function native(root, metadata, command, args, coordinator = null) {
    const entry = checkedEngine(root, metadata);
    const fixed = coordinator ? checkedCoordinator(coordinator) : null;
    const wrapper = '$coordinator=$argv[1]; $initial=$argv[2]; $argv=array_slice($argv,3); $argc=count($argv); $_SERVER["argv"]=$argv; $_SERVER["argc"]=$argc; $_SERVER["SCRIPT_FILENAME"]=$argv[0]; require $coordinator; PeanutServerUpdatePlan::withApplicationSourceVersionProof($initial, static function () use ($argv, $argc) { require $argv[0]; });';
    const invocation = fixed ? ['-r', wrapper, '--', path.join(fixed.root, 'server/docker/scripts/update-plan.php'), fixed.initial_commit, entry] : [entry];
    const result = spawnSync('php', [...invocation, command, `--project-root=${root}`, `--tooling-autoload=${path.join(cacheRoot(root, metadata), 'tooling/vendor/autoload.php')}`, ...args],
        { cwd: root, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024,
            ...(fixed ? { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } } : {}) });
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
        || !isDeepStrictEqual(readSourceIdentity(target), readSourceIdentity(metadata.source, true))
        || target?.inventory_sha256 !== metadata.source.inventory_sha256
        || saved.plan.manifest_paths?.to !== path.join(cacheRoot(root, metadata), 'scaffold-manifest.json')) fail('PLAN_SOURCE_MISMATCH');
    if (selection.development_successor) {
        const proof = selection.development_successor;
        const expectedRelation = proof.kind === 'local_snapshot'
            ? { kind: proof.kind, base: proof.base, target: proof.target,
                base_inventory_sha256: proof.base_inventory_sha256, target_inventory_sha256: proof.target_inventory_sha256 }
            : { kind: proof.kind, repository: proof.repository, base: proof.base, target: proof.target };
        const context = saved.plan.identity?.development_source;
        const expectedContext = selection.development_source;
        if (!isDeepStrictEqual(saved.plan.identity?.source_relation, expectedRelation)
            || saved.plan.identity?.source_selection?.source_checkout !== selection.source_checkout
            || (proof.kind === 'development_successor' && typeof selection.source_checkout !== 'string')
            || (selection.source_checkout !== undefined && projectRoot(selection.source_checkout) !== selection.source_checkout)
            || !context || !expectedContext || context.profile !== expectedContext.profile || context.workflow !== expectedContext.workflow
            || typeof context.workflow_present !== 'boolean' || context.workflow_present !== expectedContext.workflow_present
            || !['none', 'runtime', 'full'].includes(context.workflow)
            || (context.workflow_present ? context.workflow_paths_sha256 !== null : !digest(context.workflow_paths_sha256))
            || (Object.hasOwn(expectedContext, 'workflow_paths_sha256') && context.workflow_paths_sha256 !== expectedContext.workflow_paths_sha256)
            || !digest(context.excluded_paths_sha256)
            || !isDeepStrictEqual(Object.keys(context).sort(), ['excluded_paths_sha256', 'profile', 'workflow', 'workflow_paths_sha256', 'workflow_present'])
            || (expectedContext.excluded_paths_sha256 !== undefined && context.excluded_paths_sha256 !== expectedContext.excluded_paths_sha256)) fail('PLAN_DEVELOPMENT_SOURCE_MISMATCH');
        for (const [identity, expected] of [[saved.plan.identity?.from, proof.base], [target, proof.target]]) {
            if (proof.kind === 'local_snapshot') {
                if (!isDeepStrictEqual(readSourceIdentity(identity), expected)
                    || identity?.inventory_sha256 !== (identity === target ? proof.target_inventory_sha256 : proof.base_inventory_sha256)) fail('PLAN_BASE_SOURCE_MISMATCH');
            } else if (proof.kind !== 'development_successor' || proof.repository !== REPOSITORY || !expected
                || !isDeepStrictEqual(readSourceIdentity(identity), { kind: 'git', commit: expected.commit, tree: expected.tree })
                || identity?.inventory_sha256 !== expected.inventory_sha256) fail('PLAN_BASE_SOURCE_MISMATCH');
        }
    } else if (saved.plan.identity?.source_relation || saved.plan.identity?.development_source
        || saved.plan.identity?.source_selection?.source_checkout) fail('PLAN_DEVELOPMENT_SOURCE_MISMATCH');
    const receipt = { protocol: 'peanut.cli-template-upgrade-binding.v1', root, plan_path: saved.relative,
        plan_file_sha256: sha256File(saved.absolute), plan_sha256: output.plan_sha256, ...selection,
        ...(selection.development_successor ? { development_source: saved.plan.identity.development_source } : {}) };
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
    const requestedCoordinator = coordinatorOptions(options);
    if (options.applyPlan || options.recoverPlan) {
        const saved = checkedPlan(root, options.applyPlan ?? options.recoverPlan);
        const file = bindingPath(root, saved.relative);
        existingFileWithin(root, file, 'PEANUT_UPGRADE_BINDING_REQUIRED');
        const binding = readJsonObject(file);
        if (binding.protocol !== 'peanut.cli-template-upgrade-binding.v1' || binding.root !== root
            || binding.plan_path !== saved.relative || binding.plan_file_sha256 !== sha256File(saved.absolute)
            || binding.plan_sha256 !== saved.plan.plan_sha256) fail('PLAN_BINDING_MISMATCH');
        if (requestedCoordinator && (!binding.coordinator_source
            || requestedCoordinator.root !== binding.coordinator_source.root || requestedCoordinator.commit !== binding.coordinator_source.commit
            || requestedCoordinator.initial_commit !== binding.coordinator_source.initial_commit)) fail('COORDINATOR_SELECTION_CONFLICT');
        const coordinator = binding.coordinator_source ? checkedCoordinator(binding.coordinator_source) : null;
        const selection = { ...(coordinator ? { coordinator_source: coordinator } : {}), metadata: binding.metadata, provenance: binding.provenance, major_change: binding.major_change,
            ...(binding.development_successor ? { development_successor: binding.development_successor,
                ...(binding.source_checkout !== undefined ? { source_checkout: binding.source_checkout } : {}),
                development_source: binding.development_source } : {}) };
        bindPlan(root, { ...saved.plan, plan_path: saved.absolute }, selection);
        checkedEngine(root, selection.metadata);
        if (options.recoverPlan) return { status: 'recovered', recovery: native(root, selection.metadata, 'recover', [`--plan=${saved.absolute}`], coordinator) };
        let chosen = saved;
        if (options.confirmPlanSha256 || options.preservePaths || options.replacePaths) {
            if (!options.confirmPlanSha256 || !options.preservePaths || !options.replacePaths) fail('RESOLUTION_ARGUMENTS_REQUIRED');
            const resolved = native(root, selection.metadata, 'resolve', [`--plan=${saved.absolute}`, `--confirm-plan-sha256=${options.confirmPlanSha256}`, `--preserve-paths=${options.preservePaths}`, `--replace-paths=${options.replacePaths}`], coordinator);
            chosen = bindPlan(root, resolved, selection);
        }
        if (chosen.plan.status === 'blocked') return { status: 'blocked', plan_path: chosen.absolute, plan: chosen.plan };
        if (selection.major_change && !options.confirmMajorUpgrade) return { status: 'confirmation_required', plan_path: chosen.absolute, risk: 'major_version_change' };
        const applied = native(root, selection.metadata, 'apply', [`--plan=${chosen.absolute}`], coordinator);
        const verified = native(root, selection.metadata, 'verify', [`--plan=${chosen.absolute}`], coordinator);
        return { status: verified.status, plan_path: chosen.absolute, applied, verified, scope: 'APP source only; runtime adoption and production unchanged' };
    }
    const application = validateApplicationManifest(root);
    const discovery = await discoverUpgrade(application, options, fetcher);
    const { selected, ...summary } = discovery;
    if (options.check || !['available', 'release_adoption_available'].includes(discovery.status)) return { ...summary, metadata: selected.metadata, scope: 'metadata/archive validation only; APP unchanged' };
    acquirePackage(root, selected);
    const args = [`--template-manifest=${path.join(cacheRoot(root, selected.metadata), 'scaffold-manifest.json')}`];
    const development = ['development_successor', 'local_snapshot'].includes(discovery.source_relation.kind);
    const sourceCheckout = development && options.sourceCheckout ? projectRoot(options.sourceCheckout) : undefined;
    if (sourceCheckout) args.push(`--source-checkout=${sourceCheckout}`);
    if (options.baselineModeManifest) args.push(`--baseline-mode-manifest=${path.resolve(options.baselineModeManifest)}`);
    {
        const metadataPath = path.join(cacheRoot(root, selected.metadata), 'template-package.json');
        const identity = readSourceIdentity(selected.metadata.source, true);
        args.push('--source-repository=' + (selected.metadata.source.repository ?? '-'), '--source-ref=' + selected.provenance.requested_ref,
            '--source-channel=' + selected.provenance.channel,
            ...(identity.kind === 'local' ? ['--source-snapshot-sha256=' + identity.snapshot_sha256]
                : ['--source-commit=' + identity.commit, '--source-tree=' + identity.tree]),
            `--template-package-manifest=${metadataPath}`, `--template-package-sha256=sha256:${sha256File(metadataPath)}`);
    }
    const coordinator = requestedCoordinator ? checkedCoordinator(requestedCoordinator) : null;
    const plan = native(root, selected.metadata, 'template-plan', args, coordinator);
    const saved = bindPlan(root, plan, { ...(coordinator ? { coordinator_source: coordinator } : {}), metadata: selected.metadata, provenance: selected.provenance, major_change: discovery.major_change,
        ...(development ? { development_successor: discovery.source_relation, ...(sourceCheckout ? { source_checkout: sourceCheckout } : {}),
            development_source: { profile: application.application.profile,
                workflow: Object.hasOwn(application.application, 'workflow') ? application.application.workflow : selected.metadata.workflow,
                workflow_present: Object.hasOwn(application.application, 'workflow') } } : {}) });
    return { status: plan.status, plan_path: saved.absolute, plan, source_relation: discovery.source_relation,
        scope: 'APP source plan only; use --apply-plan after review; runtime and production unchanged' };
}

async function classifySource(generation, fixed, fetcher) {
    const unknown = (reason) => ({ kind: 'unknown', content: 'unknown', reason });
    if (sourceIdentityOf(generation)?.kind !== 'git' || sourceIdentityOf(fixed.source)?.kind !== 'git') {
        return unknown('git_source_proof_required_for_official_release');
    }
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
