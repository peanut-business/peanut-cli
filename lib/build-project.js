import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { existingFileWithin, projectRoot, readJsonObject, sha256File, validateSemver } from './protocol.js';
import { sourceSnapshotDigest } from './source-snapshot.js';
import { releaseDatabaseBackup } from './release-database-backup.js';

const fail = (code) => { throw new Error(`PEANUT_BUILD_${code}`); };
const rootPath = (root, value) => path.resolve(root, value);
function toolchainRun(root, hostPath, stateRoot, command, args, capture = false) {
    const runner = path.join(root, 'scripts/project-env');
    const host = readJsonObject(hostPath);
    const python = configuredTool(host, 'python3', root);
    const child = spawnSync(python, [runner, '--root', root, '--state-root', stateRoot, '--host', hostPath,
        'exec', '--', command, ...args], { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
    if (child.error || child.status !== 0) fail(`COMMAND_FAILED: project-env: ${child.error?.message ?? child.status}`);
    return capture ? child.stdout.trim() : '';
}

function configuredTool(host, name, root) {
    const argv = host?.commands?.[name];
    if (!Array.isArray(argv) || typeof argv[0] !== 'string') fail(`CONFIG_TOOL_MISSING: ${name}`);
    return path.resolve(root, host.path_base ?? '.', argv[0]);
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
    const flags = new Map([['--with-local-core', 'withLocalCore'], ['--overwrite', 'overwrite']]);
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

export function buildProject(kind, options) {
    if (kind !== 'release') fail('COMMAND_INVALID');
    const root = projectRoot(options.path ?? process.cwd());
    const application = fs.existsSync(path.join(root, '.peanut/application-manifest.json'));
    if (application) fail('SCAFFOLD_REQUIRED');
    existingFileWithin(root, path.join(root, 'scaffold/application-template-inventory.json'));
    const versionContract = readJsonObject(path.join(root, 'release-versions.json'));
    const version = validateSemver(options.version ?? versionContract.scaffold_template);
    if (!options.sourceCommit && version !== versionContract.scaffold_template) fail('VERSION_MISMATCH');
    if ((options.internalCoreInputs || options.apiToolRoot) && !options.sourceCommit) fail('FIXED_GIT_ARGUMENTS_REQUIRE_SOURCE_COMMIT');
    if (options.withLocalCore && (options.corePhp || options.coreWeb)) fail('LOCAL_CORE_OPTIONS_CONFLICT');
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
    if (fs.existsSync(absoluteOutput) && !options.overwrite) fail('VERSION_OUTPUT_EXISTS');
    if (!host) fail('CONFIG_REQUIRED: run peanut config first');
    const databaseBackup = releaseDatabaseBackup(root, host.release_database_backup);
    let databaseBackupReceipt = null;
    if (databaseBackup) {
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
    }
    const temporary = releaseWorkspace(root);
    const snapshot = path.join(temporary, 'source');
    let staging = null;
    let previous = null;
    try {
        const legacyGit = Boolean(options.sourceCommit);
        const php = 'php';
        const pythonExecutable = configuredTool(host, 'python3', root);
        if (!legacyGit) {
            const prepare = existingFileWithin(root, path.join(root, 'scripts/prepare-product-release-candidate'));
            toolchainRun(root, hostPath, root, 'python3', [prepare, `--prepare-release-workspace=${temporary}`,
                `--release-output-root=${releaseBase}`,
                ...(options.withLocalCore ? ['--with-local-core'] : []),
                ...(options.corePhp ? [`--core-php-version=${options.corePhp}`] : []),
                ...(options.coreWeb ? [`--core-web-version=${options.coreWeb}`] : [])]);
        }
        const entryRoot = legacyGit ? root : snapshot;
        const entry = existingFileWithin(entryRoot, path.join(entryRoot, 'scripts/build-scaffold-release'));
        const sourceDigest = legacyGit ? null : sourceSnapshotDigest(snapshot);
        if (fs.existsSync(absoluteOutput)) validateReleaseOutput(absoluteOutput);
        fs.mkdirSync(releaseBase, { recursive: true });
        staging = fs.mkdtempSync(path.join(releaseBase, `.${version}.stage-`));
        const packages = [];
        const producerToolRoot = legacyGit ? root : snapshot;
        for (const edition of ['standalone', 'multi-tenant']) {
            process.stderr.write(`[peanut release] Packaging ${edition}\n`);
            const destination = path.join(staging, edition);
            const args = [`--version=${version}`, `--tool-root=${producerToolRoot}`, `--work-root=${temporary}`,
                `--output=${destination}`, `--edition=${edition}`, `--workflow=${options.workflow ?? 'full'}`];
            if (legacyGit) args.push(`--source-commit=${options.sourceCommit}`);
            else args.push(`--source-snapshot=${snapshot}`);
            if (options.internalCoreInputs) args.push(`--internal-core-inputs=${path.resolve(options.internalCoreInputs)}`);
            if (options.apiToolRoot) args.push(`--api-tool-root=${path.resolve(options.apiToolRoot)}`);
            const result = spawnSync(pythonExecutable, [path.join(root, 'scripts/project-env'), '--root', root,
                '--state-root', root, '--host', hostPath, 'exec', '--', php, entry, ...args],
                { cwd: root, stdio: 'inherit' });
            if (result.error || result.status !== 0) fail(`COMMAND_FAILED: project-env release producer: ${result.error?.message ?? result.status}`);
            packages.push(readJsonObject(path.join(destination, `peanut-scaffold-${edition}.json`)));
        }
        if (legacyGit) {
            const identity = packages[0]?.source?.source_identity;
            if (!identity || identity.kind !== 'git' || packages.some(item => !isDeepStrictEqual(item.source?.source_identity, identity))) fail('RELEASE_SOURCE_IDENTITY_INVALID');
        } else {
            if (sourceSnapshotDigest(snapshot) !== sourceDigest) fail('RELEASE_SOURCE_CHANGED_DURING_BUILD');
            const identity = packages[0]?.source?.source_identity;
            if (!identity || identity.kind !== 'local' || identity.snapshot_sha256 !== sourceDigest
                || packages.some(item => !isDeepStrictEqual(item.source?.source_identity, identity))) fail('RELEASE_SOURCE_IDENTITY_INVALID');
        }
        validateReleaseOutput(staging, version);
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
        return { status: 'released', source_identity: identity, version, output, packages, database_backup: databaseBackupReceipt, publication: 'local-only' };
    } finally {
        if (staging && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function validateReleaseOutput(output, expectedVersion = path.basename(output)) {
    const rootStat = fs.lstatSync(output);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('OVERWRITE_TARGET_INVALID');
    if (fs.readdirSync(output).some(name => !['standalone', 'multi-tenant'].includes(name))) fail('OVERWRITE_UNKNOWN_ARTIFACT');
    for (const edition of ['standalone', 'multi-tenant']) {
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
