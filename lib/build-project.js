import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { existingFileWithin, readJsonObject, resolveWorkingRoot, sha256, sha256File, validateSemver } from './protocol.js';
import { sourceSnapshotDigest } from './source-snapshot.js';
import { releaseDatabaseBackup } from './release-database-backup.js';
import { resolveConfiguredSources } from './core-dev.js';
import { automaticEnvironment, environmentInvocation, inspectEnvironment } from './project-environment.js';

const fail = (code) => { throw new Error(`PEANUT_BUILD_${code}`); };
const rootPath = (root, value) => path.resolve(root, value);
function toolchainRun(root, hostPath, stateRoot, command, args, capture = false) {
    const invocation = environmentInvocation(root);
    const child = spawnSync(invocation.executable, [...invocation.args, command, ...args],
        { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
    if (child.error || child.status !== 0) fail(`COMMAND_FAILED: project-env: ${child.error?.message ?? child.status}`);
    return capture ? child.stdout.trim() : '';
}

function releaseWorkspace(root) {
    let parent = root;
    for (const name of ['.local', 'release']) {
        parent = path.join(parent, name);
        const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('WORKSPACE_PATH_INVALID');
        if (!stat) fs.mkdirSync(parent, { mode: 0o700 });
    }
    return fs.mkdtempSync(path.join(parent, 'build-'));
}

export function parseBuildArguments(raw) {
    const options = {};
    const flags = new Map([['--with-local-core', 'withLocalCore'], ['--overwrite', 'overwrite'], ['--plan', 'plan'], ['--resume', 'resume']]);
    const keys = new Map([['--path', 'path'], ['--output', 'output'], ['--version', 'version'], ['--source-commit', 'sourceCommit'], ['--workflow', 'workflow'], ['--api-tool-root', 'apiToolRoot'], ['--internal-core-inputs', 'internalCoreInputs'], ['--core-php', 'corePhp'], ['--core-web', 'coreWeb']]);
    for (let index = 0; index < raw.length; index++) {
        if (flags.has(raw[index])) {
            const key = flags.get(raw[index]);
            if (Object.hasOwn(options, key)) fail('ARGUMENTS_INVALID');
            options[key] = true;
            continue;
        }
        const split = raw[index].indexOf('=');
        const flag = split < 0 ? raw[index] : raw[index].slice(0, split);
        const key = keys.get(flag);
        const value = split < 0 ? raw[++index] : raw[index].slice(split + 1);
        if (!key || Object.hasOwn(options, key) || !value || value.startsWith('--')) fail('ARGUMENTS_INVALID');
        options[key] = value;
    }
    return options;
}

function saveOperation(file, state) {
    const temporary = file + '.' + randomUUID();
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
}

function releaseInputs(root, options, version, output, localCores) {
    const external = {};
    if (options.internalCoreInputs) external.core_inputs_sha256 = sha256File(path.resolve(options.internalCoreInputs));
    if (options.apiToolRoot) external.api_tool_sha256 = sourceSnapshotDigest(path.resolve(options.apiToolRoot), root);
    if (localCores) {
        external.php = sourceSnapshotDigest(localCores.expected_php_dir, root);
        external.web = sourceSnapshotDigest(localCores.expected_web_dir, root);
    }
    return { protocol: 'peanut.cli-release-inputs.v1', source_sha256: sourceSnapshotDigest(root),
        version, workflow: options.workflow ?? 'full', source_commit: options.sourceCommit ?? null,
        core_php: options.corePhp ?? null, core_web: options.coreWeb ?? null,
        local_core: options.withLocalCore === true, external,
        cli_producer_sha256: sha256File(new URL('./build-project.js', import.meta.url)),
        output };
}

function environmentIdentity(environment) {
    if (environment.status !== 'ok') fail('ENVIRONMENT_NOT_READY: ' + environment.reason);
    // Use the native project's complete execution fingerprint, not a lossy
    // reconstruction from versions and executable bytes. Cache/path/ini changes matter.
    if (!/^[a-f0-9]{64}$/.test(environment.fingerprint ?? '')) fail('ENVIRONMENT_FINGERPRINT_REQUIRED');
    return environment.fingerprint;
}

function editionProof(directory, edition) {
    const names = ['scaffold-manifest.json', 'scaffold-build-inputs.json',
        `peanut-scaffold-${edition}.json`, `peanut-scaffold-${edition}.tgz`];
    if (fs.existsSync(path.join(directory, 'source-snapshot.json'))) names.push('source-snapshot.json');
    return Object.fromEntries(names.map(name => [name, sha256File(existingFileWithin(directory, path.join(directory, name)))]));
}

export function buildProject(kind, options) {
    if (kind !== 'release') fail('COMMAND_INVALID');
    const root = resolveWorkingRoot(options.path);
    const application = fs.existsSync(path.join(root, '.peanut/application-manifest.json'));
    if (application) fail('SCAFFOLD_REQUIRED');
    existingFileWithin(root, path.join(root, 'scaffold/application-template-inventory.json'));
    const versionContract = readJsonObject(path.join(root, 'release-versions.json'));
    const version = validateSemver(options.version ?? versionContract.scaffold_template);
    if (options.sourceCommit && !/^[a-f0-9]{40}$/.test(options.sourceCommit)) fail('SOURCE_COMMIT_INVALID');
    if (!options.sourceCommit && version !== versionContract.scaffold_template) fail('VERSION_MISMATCH');
    if ((options.internalCoreInputs || options.apiToolRoot) && !options.sourceCommit) fail('FIXED_GIT_ARGUMENTS_REQUIRE_SOURCE_COMMIT');
    if (options.withLocalCore && (options.sourceCommit || options.corePhp || options.coreWeb)) fail('LOCAL_CORE_OPTIONS_CONFLICT');
    const hostPath = path.join(root, '.local/toolchain/host.json');
    const host = fs.existsSync(hostPath) ? readJsonObject(hostPath) : null;
    if (host?.paths) {
        for (const key of ['release', 'backups']) {
            if (typeof host.paths[key] === 'string' && path.resolve(root, host.paths[key]) === root) fail('OUTPUT_SOURCE_CONFLICT');
        }
    }
    const releaseBase = rootPath(root, options.output ?? host?.paths?.release ?? 'release');
    if (releaseBase === root) fail('OUTPUT_SOURCE_CONFLICT');
    if (releaseBase.startsWith(root + path.sep)) {
        const relative = path.relative(root, releaseBase).split(path.sep).join('/');
        if (['scripts', 'scaffold', 'server', 'web', 'platform', 'pc', 'uniapp'].some(required =>
            relative === required || required.startsWith(relative + '/') || relative.startsWith(required + '/'))) fail('OUTPUT_SOURCE_CONFLICT');
    }
    const output = path.join(releaseBase, version);
    const absoluteOutput = output;
    if (!path.isAbsolute(absoluteOutput) || path.normalize(absoluteOutput) !== absoluteOutput) fail('OUTPUT_ABSOLUTE_REQUIRED');
    let cursor = path.parse(absoluteOutput).root;
    for (const part of absoluteOutput.slice(cursor.length).split('/')) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) fail('OUTPUT_PATH_INVALID');
    }
    const localCores = options.withLocalCore ? resolveConfiguredSources(root) : null;
    if (localCores && (!localCores.expected_php_dir || !localCores.expected_web_dir)) fail('LOCAL_CORE_SELECTION_REQUIRED');
    const inputs = releaseInputs(root, options, version, output, localCores);
    const inputSha = sha256(JSON.stringify(inputs));
    const stateFile = path.join(root, '.local/release', `operation-${inputSha}.json`);
    let state = fs.existsSync(stateFile) ? readJsonObject(existingFileWithin(root, stateFile)) : null;
    if (state && (state.protocol !== 'peanut.cli-release-operation.v1' || state.input_sha256 !== inputSha
        || !isDeepStrictEqual(state.inputs, inputs))) fail('OPERATION_INPUTS_CHANGED');
    if (state?.status === 'complete' && !options.overwrite) {
        validateReleaseOutput(output, version);
        for (const metadata of state.result?.packages ?? []) {
            const actual = readJsonObject(path.join(output, metadata.edition, `peanut-scaffold-${metadata.edition}.json`));
            if (!isDeepStrictEqual(actual, metadata)) fail('COMPLETED_RELEASE_IDENTITY_CHANGED');
            if (!isDeepStrictEqual(editionProof(path.join(output, metadata.edition), metadata.edition),
                state.editions?.[metadata.edition]?.files)) fail('COMPLETED_RELEASE_EVIDENCE_CHANGED');
        }
        if (state.result?.packages?.length !== 2) fail('COMPLETED_RELEASE_RECEIPT_INVALID');
        if (options.plan) return { status: 'no_build_needed', input_sha256: inputSha, version, output, writes: false, publication: 'local-only' };
        if (state.environment !== environmentIdentity(inspectEnvironment(root))) fail('COMPLETED_RELEASE_ENVIRONMENT_CHANGED');
        return { ...state.result, status: 'reused', input_sha256: inputSha,
            scope: 'original artifact bytes verified; no rebuild, dependency install, database export or fresh runtime tests' };
    }
    if (options.plan) return { status: state ? 'resume_required' : fs.existsSync(output) && !options.overwrite ? 'blocked' : 'planned',
        input_sha256: inputSha, version, output, state: stateFile, writes: false,
        steps: ['native environment detection', 'prepare fixed source once', 'build each missing Edition once',
            'verify original artifact fingerprints', 'atomic output promotion'],
        completed_editions: Object.keys(state?.editions ?? {}), publication: 'not-requested' };
    if (fs.existsSync(absoluteOutput) && !options.overwrite) fail('VERSION_OUTPUT_EXISTS');
    if (state && !options.resume && !options.overwrite) fail(`RESUME_REQUIRED: peanut release --path ${JSON.stringify(root)} --resume; state=${stateFile}`);
    if (options.resume && !state) fail('RESUME_OPERATION_NOT_FOUND_FOR_CURRENT_INPUTS');
    if (!host && !automaticEnvironment(root)) fail('CONFIG_REQUIRED: run peanut config first');
    const databaseBackup = releaseDatabaseBackup(root, host?.release_database_backup);
    let databaseBackupReceipt = null;
    const performDatabaseBackup = () => {
        if (!databaseBackup) return;
        const backupRoot = rootPath(root, host.paths?.backups ?? '../backups');
        if (databaseBackup.output === releaseBase || databaseBackup.output.startsWith(releaseBase + path.sep)) fail('DATABASE_BACKUP_IN_RELEASE_OUTPUT');
        const exporter = existingFileWithin(root, path.join(root, 'scripts/export-release-database'));
        const receipt = toolchainRun(root, hostPath, root, 'php', [exporter,
            `--registry=${databaseBackup.registry}`, `--resource-id=${databaseBackup.resource_id}`,
            `--output=${databaseBackup.output}`, `--backups=${backupRoot}`, `--release-output=${releaseBase}`], true);
        try { databaseBackupReceipt = JSON.parse(receipt); }
        catch { fail('DATABASE_BACKUP_RECEIPT_INVALID'); }
        if (databaseBackupReceipt.protocol !== 'peanut.release-database-backup.v1'
            || databaseBackupReceipt.output !== databaseBackup.output || databaseBackupReceipt.native_exit_code !== 0) fail('DATABASE_BACKUP_RECEIPT_INVALID');
    };
    const environment = environmentIdentity(inspectEnvironment(root));
    const newWorkspace = !state || options.overwrite;
    const temporary = newWorkspace ? releaseWorkspace(root) : state.workspace;
    const snapshot = path.join(temporary, 'source');
    if (!path.isAbsolute(temporary) || !temporary.startsWith(path.join(root, '.local/release/build-'))
        || !fs.existsSync(temporary) || fs.realpathSync(temporary) !== temporary) fail('RESUME_WORKSPACE_INVALID');
    const operationParent = path.dirname(stateFile);
    fs.mkdirSync(operationParent, { recursive: true, mode: 0o700 });
    const lock = stateFile + '.lock';
    let lockFd;
    try { lockFd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(lockFd, String(process.pid)); }
    catch { fail(`OPERATION_RUNNING_OR_UNKNOWN: inspect ${lock}`); }
    if (newWorkspace) state = { protocol: 'peanut.cli-release-operation.v1', input_sha256: inputSha,
        inputs, workspace: temporary, environment, status: 'new', prepared: false, editions: {} };
    if (state.environment !== environment) { fs.closeSync(lockFd); fs.unlinkSync(lock); fail('RESUME_ENVIRONMENT_CHANGED'); }
    let staging = state.staging ?? null;
    let previous = null;
    let success = false;
    saveOperation(stateFile, state);
    try {
        const legacyGit = Boolean(options.sourceCommit);
        const php = 'php';
        const execution = environmentInvocation(root);
        if (['preparing', 'building'].includes(state.status)) fail('NATIVE_OUTCOME_UNKNOWN: inspect the recorded phase before retry');
        if (databaseBackup && !state.database_backup) {
            performDatabaseBackup();
            state.database_backup = databaseBackupReceipt;
            state.database_backup_sha256 = sha256File(databaseBackup.output);
            saveOperation(stateFile, state);
        } else if (databaseBackup) {
            if (sha256File(databaseBackup.output) !== state.database_backup_sha256) fail('BACKUP_INPUT_CHANGED');
            databaseBackupReceipt = state.database_backup;
        }
        if (!legacyGit && !state.prepared) {
            const resumePreparation = fs.existsSync(path.join(temporary, 'preparation.json'));
            if (fs.existsSync(snapshot) && (!resumePreparation || !automaticEnvironment(root))) fail('PARTIAL_PREPARATION_REQUIRES_NATIVE_RECOVERY: ' + temporary);
            state.status = 'preparing';
            saveOperation(stateFile, state);
            const prepare = existingFileWithin(root, path.join(root, 'scripts/prepare-product-release-candidate'));
            toolchainRun(root, hostPath, root, 'python3', [prepare, `--prepare-release-workspace=${temporary}`,
                `--release-output-root=${releaseBase}`,
                ...(resumePreparation ? ['--resume-release-workspace'] : []),
                ...(localCores ? ['--with-local-core', localCores.expected_php_dir, localCores.expected_web_dir] : []),
                ...(options.corePhp ? [`--core-php-version=${options.corePhp}`] : []),
                ...(options.coreWeb ? [`--core-web-version=${options.coreWeb}`] : [])]);
            state.prepared = true;
            state.prepared_source_sha256 = sourceSnapshotDigest(snapshot);
            state.status = 'prepared';
            saveOperation(stateFile, state);
        }
        const entryRoot = legacyGit ? root : snapshot;
        const entry = existingFileWithin(entryRoot, path.join(entryRoot, 'scripts/build-scaffold-release'));
        const sourceDigest = legacyGit ? null : sourceSnapshotDigest(snapshot);
        if (!legacyGit && sourceDigest !== state.prepared_source_sha256) fail('PREPARED_SOURCE_CHANGED');
        if (fs.existsSync(absoluteOutput)) validateReleaseOutput(absoluteOutput);
        fs.mkdirSync(releaseBase, { recursive: true });
        if (staging === null) {
            staging = fs.mkdtempSync(path.join(releaseBase, `.${version}.stage-`));
            state.staging = staging;
            saveOperation(stateFile, state);
        } else if (!staging.startsWith(path.join(releaseBase, `.${version}.stage-`)) || fs.realpathSync(staging) !== staging) fail('RESUME_STAGE_INVALID');
        const packages = [];
        const producerToolRoot = legacyGit ? root : snapshot;
        const internalCoreInputs = options.internalCoreInputs
            ? path.resolve(options.internalCoreInputs)
            : (!legacyGit && options.withLocalCore
                ? path.join(temporary, 'core-inputs', 'frozen', 'release-core-inputs.json') : null);
        for (const edition of ['standalone', 'multi-tenant']) {
            const destination = path.join(staging, edition);
            if (state.editions[edition]) {
                validateReleaseOutput(staging, version, [edition]);
                const metadata = readJsonObject(path.join(destination, `peanut-scaffold-${edition}.json`));
                if (metadata.archive.sha256 !== state.editions[edition].archive_sha256) fail('RESUME_ARTIFACT_CHANGED');
                if (!isDeepStrictEqual(editionProof(destination, edition), state.editions[edition].files)) fail('RESUME_ARTIFACT_PROOF_CHANGED');
                packages.push(metadata);
                process.stderr.write(`[peanut release] Reusing verified ${edition}\n`);
                continue;
            }
            if (fs.existsSync(destination)) {
                if (state.status !== 'failed' || state.phase !== edition || !options.resume) fail('PARTIAL_EDITION_REQUIRES_NATIVE_RECOVERY: ' + destination);
                const retained = path.join(releaseBase, `.${version}.${edition}.failed-${randomUUID()}`);
                fs.renameSync(destination, retained);
                (state.retained_failed_outputs ??= []).push(retained);
                saveOperation(stateFile, state);
            }
            process.stderr.write(`[peanut release] Packaging ${edition}\n`);
            state.status = 'building'; state.phase = edition;
            saveOperation(stateFile, state);
            const args = [`--version=${version}`, `--tool-root=${producerToolRoot}`, `--work-root=${temporary}`,
                `--output=${destination}`, `--edition=${edition}`, `--workflow=${options.workflow ?? 'full'}`];
            if (legacyGit) args.push(`--source-commit=${options.sourceCommit}`);
            else args.push(`--source-snapshot=${snapshot}`);
            if (internalCoreInputs) args.push(`--internal-core-inputs=${internalCoreInputs}`);
            if (options.apiToolRoot) args.push(`--api-tool-root=${path.resolve(options.apiToolRoot)}`);
            const result = spawnSync(execution.executable, [...execution.args, php, entry, ...args],
                { cwd: root, stdio: 'inherit' });
            if (result.error || result.status !== 0) fail(`COMMAND_FAILED: project-env release producer: ${result.error?.message ?? result.status}`);
            validateReleaseOutput(staging, version, [edition]);
            const metadata = readJsonObject(path.join(destination, `peanut-scaffold-${edition}.json`));
            packages.push(metadata);
            state.editions[edition] = { archive_sha256: metadata.archive.sha256, files: editionProof(destination, edition) };
            state.status = 'prepared';
            saveOperation(stateFile, state);
        }
        if (legacyGit) {
            const identity = packages[0]?.source?.source_identity;
            if (!identity || identity.kind !== 'git' || identity.commit !== options.sourceCommit
                || packages.some(item => !isDeepStrictEqual(item.source?.source_identity, identity))) fail('RELEASE_SOURCE_IDENTITY_INVALID');
        } else {
            if (sourceSnapshotDigest(snapshot) !== sourceDigest) fail('RELEASE_SOURCE_CHANGED_DURING_BUILD');
            const identity = packages[0]?.source?.source_identity;
            if (!identity || identity.kind !== 'local' || identity.snapshot_sha256 !== sourceDigest
                || packages.some(item => !isDeepStrictEqual(item.source?.source_identity, identity))) fail('RELEASE_SOURCE_IDENTITY_INVALID');
        }
        validateReleaseOutput(staging, version);
        if (sourceSnapshotDigest(root) !== inputs.source_sha256) fail('SOURCE_CHANGED_DURING_RELEASE');
        if (fs.existsSync(absoluteOutput)) {
            previous = path.join(releaseBase, `.${version}.previous-${randomUUID()}`);
            fs.renameSync(absoluteOutput, previous);
        }
        try {
            fs.renameSync(staging, absoluteOutput);
            staging = null;
        } catch (error) {
            if (previous) {
                try {
                    fs.renameSync(previous, absoluteOutput);
                    previous = null;
                } catch (restoreError) {
                    throw new Error(`PEANUT_BUILD_RELEASE_OUTPUT_RESTORE_FAILED: ${previous}`, { cause: restoreError });
                }
            }
            throw error;
        }
        if (previous) {
            fs.rmSync(previous, { recursive: true, force: false });
            previous = null;
        }
        const identity = packages[0].source.source_identity;
        process.stderr.write(`[peanut release] Complete: ${absoluteOutput}\n`);
        const result = { status: 'released', source_identity: identity, version, output, packages,
            input_sha256: inputSha, operation: stateFile, database_backup: databaseBackupReceipt, publication: 'local-only' };
        state.status = 'complete'; state.result = result;
        delete state.error;
        saveOperation(stateFile, state);
        success = true;
        return result;
    } catch (error) {
        if (!error.message.includes('NATIVE_OUTCOME_UNKNOWN')) state.status = 'failed';
        state.error = error.message;
        saveOperation(stateFile, state);
        throw new Error(`${error.message}; recoverable state: ${stateFile}; use the same inputs with --resume`, { cause: error });
    } finally {
        if (success) fs.rmSync(temporary, { recursive: true, force: true });
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
    }
}

export function validateReleaseOutput(output, expectedVersion = path.basename(output), editions = ['standalone', 'multi-tenant']) {
    const rootStat = fs.lstatSync(output);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('OVERWRITE_TARGET_INVALID');
    if (fs.readdirSync(output).some(name => !['standalone', 'multi-tenant'].includes(name))) fail('OVERWRITE_UNKNOWN_ARTIFACT');
    for (const edition of editions) {
        const directory = path.join(output, edition);
        if (!fs.existsSync(directory)) fail('OVERWRITE_ARTIFACT_MISSING');
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('OVERWRITE_TARGET_INVALID');
        const editionArchive = `peanut-scaffold-${edition}.tgz`;
        const editionMetadata = `peanut-scaffold-${edition}.json`;
        const manifestPath = path.join(directory, 'scaffold-manifest.json');
        const metadataPath = path.join(directory, editionMetadata);
        const archivePath = path.join(directory, editionArchive);
        if (![manifestPath, metadataPath, archivePath, path.join(directory, 'scaffold-build-inputs.json')].every(file => fs.existsSync(file))) fail('OVERWRITE_ARTIFACT_MISSING');
        const manifest = readJsonObject(manifestPath);
        const metadata = readJsonObject(metadataPath);
        const buildInputs = readJsonObject(path.join(directory, 'scaffold-build-inputs.json'));
        if (!['peanut.scaffold-release.v2', 'peanut.scaffold-release.v3', 'peanut.scaffold-release.v4'].includes(manifest.protocol)
            || !Array.isArray(manifest.files) || metadata.protocol !== 'peanut.template-package.v1'
            || metadata.version !== expectedVersion || manifest.release?.version !== metadata.version
            || metadata.edition !== edition || metadata.archive?.name !== editionArchive
            || metadata.archive?.bytes !== fs.statSync(archivePath).size || metadata.archive?.sha256 !== sha256File(archivePath)
            || metadata.scaffold_manifest_sha256 !== sha256File(manifestPath)) fail('OVERWRITE_ARTIFACT_INVALID');
        const expected = new Map();
        for (const row of manifest.files) {
            const relative = row?.path;
            if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\')
                || relative.split('/').some(part => !part || part === '.' || part === '..')
                || row.source !== `files/${relative}` || !/^[a-f0-9]{64}$/.test(row.template_sha256 ?? '')
                || ![0o644, 0o755].includes(row.mode) || expected.has(relative)) fail('OVERWRITE_MANIFEST_INVALID');
            expected.set(relative, row);
        }
        const actual = new Set();
        const walk = (base, relative = '') => {
            for (const name of fs.readdirSync(base)) {
                const file = path.join(base, name);
                const stat = fs.lstatSync(file);
                if (stat.isSymbolicLink()) fail('OVERWRITE_TARGET_INVALID');
                const child = relative ? relative + '/' + name : name;
                if (stat.isDirectory()) walk(file, child);
                else if (stat.isFile()) actual.add(child);
                else fail('OVERWRITE_TARGET_INVALID');
            }
        };
        const payload = path.join(directory, 'files');
        if (fs.existsSync(payload)) {
            if (!fs.lstatSync(payload).isDirectory()) fail('OVERWRITE_TARGET_INVALID');
            walk(payload);
        }
        if (actual.size !== expected.size) fail('OVERWRITE_PAYLOAD_MISMATCH');
        for (const [relative, row] of expected) {
            const file = path.join(payload, relative);
            if (!actual.has(relative) || sha256File(file) !== row.template_sha256 || (fs.statSync(file).mode & 0o777) !== row.mode) fail('OVERWRITE_PAYLOAD_MISMATCH');
        }
        const allowed = new Set(['scaffold-manifest.json', 'scaffold-build-inputs.json', editionArchive, editionMetadata, 'source-snapshot.json', 'files']);
        if (fs.readdirSync(directory).some(name => !allowed.has(name))) fail('OVERWRITE_UNKNOWN_ARTIFACT');
        for (const name of ['scaffold-manifest.json', editionArchive, editionMetadata]) {
            const entry = buildInputs.artifacts?.[name];
            const file = path.join(directory, name);
            if (!entry || entry.bytes !== fs.statSync(file).size || entry.sha256 !== sha256File(file)) fail('OVERWRITE_BUILD_RECEIPT_INVALID');
        }
        const proofPath = path.join(directory, 'source-snapshot.json');
        if (fs.existsSync(proofPath) && (!fs.lstatSync(proofPath).isFile() || fs.lstatSync(proofPath).isSymbolicLink())) fail('OVERWRITE_SOURCE_PROOF_INVALID');
        const hasLocalIdentity = metadata.source?.source_identity?.kind === 'local';
        if (hasLocalIdentity) {
            if (!fs.existsSync(proofPath) || metadata.source_snapshot_sha256 !== sha256File(proofPath)) fail('OVERWRITE_SOURCE_PROOF_INVALID');
            const proof = readJsonObject(proofPath);
            if (proof.protocol !== 'peanut.local-source-snapshot.v1'
                || !isDeepStrictEqual(proof.source_identity, metadata.source.source_identity)
                || !isDeepStrictEqual(proof.source_identity, manifest.release?.source_identity)) fail('OVERWRITE_SOURCE_PROOF_INVALID');
        } else if (fs.existsSync(proofPath)) fail('OVERWRITE_SOURCE_PROOF_INVALID');
    }
}
