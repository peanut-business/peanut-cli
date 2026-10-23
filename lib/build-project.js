import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { existingFileWithin, projectRoot, readJsonObject, sha256File, validateApplicationManifest, validateSemver } from './protocol.js';

const fail = (code) => { throw new Error(`PEANUT_BUILD_${code}`); };
function run(command, args, root) {
    const result = spawnSync(command, args, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
    if (result.error || result.status !== 0) fail(`COMMAND_FAILED: ${command}: ${result.error?.message ?? result.status}`);
    return result.stdout.trim();
}

export function parseBuildArguments(raw) {
    const options = {};
    const keys = new Map([['--path', 'path'], ['--output', 'output'], ['--version', 'version'], ['--source-commit', 'sourceCommit'], ['--workflow', 'workflow'], ['--api-tool-root', 'apiToolRoot'], ['--internal-core-inputs', 'internalCoreInputs']]);
    for (let index = 0; index < raw.length; index++) {
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
    const root = projectRoot(options.path ?? process.cwd());
    const application = fs.existsSync(path.join(root, '.peanut/application-manifest.json'));
    if (kind === 'release' && application) fail('SCAFFOLD_REQUIRED');
    if (kind === 'package' && !application) fail('APPLICATION_REQUIRED');
    let version;
    let app;
    let commit;
    let apiToolRoot;
    let internalCoreInputs;
    if (kind === 'release') {
        existingFileWithin(root, path.join(root, 'scaffold/application-template-inventory.json'));
        version = validateSemver(options.version ?? readJsonObject(path.join(root, 'release-versions.json')).scaffold_template);
        commit = options.sourceCommit ?? run('git', ['rev-parse', 'HEAD'], root);
        if (!/^[a-f0-9]{40}$/.test(commit)) fail('SOURCE_COMMIT_REQUIRED');
        if (options.workflow && !['none', 'runtime', 'full'].includes(options.workflow)) fail('WORKFLOW_INVALID');
        if (options.internalCoreInputs) {
            if (!path.isAbsolute(options.internalCoreInputs) || path.normalize(options.internalCoreInputs) !== options.internalCoreInputs) fail('CORE_INPUTS_ABSOLUTE_REQUIRED');
            internalCoreInputs = options.internalCoreInputs;
            // The native producer verifies the frozen source and all seven archive digests.
            existingFileWithin(path.dirname(internalCoreInputs), internalCoreInputs);
            if (options.workflow && options.workflow !== 'full') fail('CORE_INPUTS_WORKFLOW_FULL_REQUIRED');
        }
        if (options.apiToolRoot) {
            if (!path.isAbsolute(options.apiToolRoot) || path.normalize(options.apiToolRoot) !== options.apiToolRoot) fail('API_TOOL_ROOT_ABSOLUTE_REQUIRED');
            apiToolRoot = projectRoot(options.apiToolRoot);
            existingFileWithin(apiToolRoot, path.join(apiToolRoot, 'scripts/generate-api-contracts.php'));
        }
    } else {
        if (options.version || options.sourceCommit || options.workflow || options.apiToolRoot || options.internalCoreInputs) fail('PACKAGE_ARGUMENTS_INVALID');
        app = validateApplicationManifest(root);
        version = app.application.version;
    }
    const buildId = `${new Date().toISOString().replaceAll(/[-:.]/g, '')}-${randomUUID()}`;
    const output = options.output ?? path.join(path.dirname(root), 'release',
        ...(kind === 'release' ? ['scaffold', version, buildId] : ['apps', app.application.slug, version, buildId]));
    if (!path.isAbsolute(output) || path.normalize(output) !== output) fail('OUTPUT_ABSOLUTE_REQUIRED');
    let cursor = path.parse(output).root;
    for (const part of output.slice(cursor.length).split('/')) {
        cursor = path.join(cursor, part);
        const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) fail('OUTPUT_PATH_INVALID');
    }
    if (fs.existsSync(output)) fail('OUTPUT_EXISTS');
    if (kind === 'package') {
        const entry = existingFileWithin(root, path.join(root, 'scripts/package-release.sh'));
        run('bash', [entry, output, `--application-root=${root}`, '--server-only'], root);
        const outputStat = fs.lstatSync(output, { throwIfNoEntry: false });
        if (!outputStat?.isDirectory() || outputStat.isSymbolicLink()) fail('PACKAGE_OUTPUT_MISSING');
        const identityPath = existingFileWithin(output, path.join(output, 'server/.peanut/release-identity.json'));
        const archivePath = existingFileWithin(path.dirname(output), output + '.tar.gz');
        const archiveManifestPath = existingFileWithin(path.dirname(output), output + '.tar.gz.manifest.json');
        const identity = readJsonObject(identityPath);
        const archiveManifest = readJsonObject(archiveManifestPath);
        if (identity.schema_version !== 1 || identity.protocol !== 'peanut.server-release.v1'
            || archiveManifest.schema_version !== 1 || archiveManifest.protocol !== 'peanut.server-archive.v1'
            || identity.application?.kind !== 'application'
            || ['name', 'slug', 'package_identity', 'version', 'edition', 'profile'].some(key => identity.application[key] !== app.application[key])
            || identity.application.manifest_sha256 !== sha256File(path.join(root, '.peanut/application-manifest.json'))
            || identity.application.commit !== run('git', ['rev-parse', 'HEAD'], root)
            || identity.application.tree !== run('git', ['rev-parse', 'HEAD^{tree}'], root)
            || !isDeepStrictEqual(identity.template, app.template)
            || !['commit', 'tree', 'inventory_sha256'].every(key => identity.upstream?.[key] === app.generation_source?.[key])
            || !isDeepStrictEqual(archiveManifest.application, identity.application)
            || !isDeepStrictEqual(archiveManifest.upstream, identity.upstream)
            || archiveManifest.identity_sha256 !== sha256File(identityPath)
            || archiveManifest.archive?.filename !== path.basename(archivePath)
            || archiveManifest.archive.bytes !== fs.statSync(archivePath).size
            || archiveManifest.archive.sha256 !== sha256File(archivePath)) fail('PACKAGE_OUTPUT_INVALID');
        return { status: 'packaged', kind: 'server-only', application: app.application, output };
    }
    const entry = existingFileWithin(root, path.join(root, 'scripts/build-scaffold-release'));
    fs.mkdirSync(output, { recursive: true });
    const packages = [];
    for (const edition of ['standalone', 'multi-tenant']) {
        const destination = path.join(output, edition);
        const args = [entry, `--version=${version}`, `--source-commit=${commit}`, `--output=${destination}`, `--edition=${edition}`];
        if (options.workflow && !internalCoreInputs) args.push(`--workflow=${options.workflow}`);
        if (internalCoreInputs) args.push(`--internal-core-inputs=${internalCoreInputs}`, '--workflow=full');
        if (apiToolRoot) args.push(`--api-tool-root=${apiToolRoot}`);
        run('php', args, root);
        packages.push(readJsonObject(path.join(destination, `peanut-scaffold-${edition}.json`)));
    }
    return { status: 'released', source_commit: commit, version, output, packages, publication: 'local-only' };
}
