import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existingFileWithin, projectRoot, readJsonObject, validateApplicationManifest, validateSemver } from './protocol.js';

const fail = (code) => { throw new Error(`PEANUT_BUILD_${code}`); };
function run(command, args, root) {
    const result = spawnSync(command, args, { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
    if (result.error || result.status !== 0) fail(`COMMAND_FAILED: ${command}: ${result.error?.message ?? result.status}`);
    return result.stdout.trim();
}

export function parseBuildArguments(raw) {
    const options = {};
    const keys = new Map([['--path', 'path'], ['--output', 'output'], ['--version', 'version'], ['--source-commit', 'sourceCommit'], ['--workflow', 'workflow']]);
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
    if (kind === 'release') {
        existingFileWithin(root, path.join(root, 'scaffold/application-template-inventory.json'));
        version = validateSemver(options.version ?? readJsonObject(path.join(root, 'release-versions.json')).scaffold_template);
        commit = options.sourceCommit ?? run('git', ['rev-parse', 'HEAD'], root);
        if (!/^[a-f0-9]{40}$/.test(commit)) fail('SOURCE_COMMIT_REQUIRED');
        if (options.workflow && !['none', 'runtime', 'full'].includes(options.workflow)) fail('WORKFLOW_INVALID');
    } else {
        if (options.version || options.sourceCommit || options.workflow) fail('PACKAGE_ARGUMENTS_INVALID');
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
        return { status: 'packaged', kind: 'server-only', application: app.application, output };
    }
    const entry = existingFileWithin(root, path.join(root, 'scripts/build-scaffold-release'));
    fs.mkdirSync(output, { recursive: true });
    const packages = [];
    for (const edition of ['standalone', 'multi-tenant']) {
        const destination = path.join(output, edition);
        const args = [entry, `--version=${version}`, `--source-commit=${commit}`, `--output=${destination}`, `--edition=${edition}`];
        if (options.workflow) args.push(`--workflow=${options.workflow}`);
        run('php', args, root);
        packages.push(readJsonObject(path.join(destination, `peanut-scaffold-${edition}.json`)));
    }
    return { status: 'released', source_commit: commit, version, output, packages, publication: 'local-only' };
}
