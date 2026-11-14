import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { existingFileWithin, readJsonObject, sha256 } from './protocol.js';
import { downloadModule, verifyModuleArchive } from './module-release.js';
import { materializeTemplate } from './template-package.js';

const fail = (code) => { throw new Error(`PEANUT_CREATE_MODULE_${code}`); };
const encode = (value) => JSON.stringify(value, null, 2) + '\n';

/** Transport and source staging only. Code owns closure, admission and the source transaction. */
export async function composeCreate(selected, selectionInput, options, fetcher) {
    const { selection, source, optional } = selectionInput;
    if (selection.blockers.length) return selection;
    if (!['standalone', 'multi-tenant'].includes(selection.edition)
        || selected.metadata.edition !== selection.edition) fail('TEMPLATE_EDITION_MISMATCH');
    const binding = {
        target: options.target, name: options.name, slug: options.slug, package: options.package,
        application_version: options.applicationVersion ?? selected.bundle.release.application.version,
        demo: options.demo ?? 'none', template_sha256: selected.metadata.archive.sha256,
        source: selection.source, preset: selection.preset, optional,
    };
    let stage;
    if (options.compositionStage !== undefined) {
        if (!path.isAbsolute(options.compositionStage)) fail('STAGE_ABSOLUTE_PATH_REQUIRED');
        stage = options.compositionStage;
        if (fs.realpathSync(stage) !== stage || fs.realpathSync(path.join(stage, 'application')) !== path.join(stage, 'application')) fail('STAGE_PATH_INVALID');
        const state = readJsonObject(existingFileWithin(stage, path.join(stage, 'create.json')));
        if (state.protocol !== 'peanut.create-module-stage.v1' || !isDeepStrictEqual(state.binding, binding)) fail('STAGE_IDENTITY_MISMATCH');
        existingFileWithin(stage, path.join(stage, 'application/.peanut/application-manifest.json'));
    } else {
        if (options.planSha256) fail('REVIEWED_STAGE_REQUIRED');
        stage = fs.mkdtempSync(path.join(path.dirname(options.target), `.${path.basename(options.target)}.peanut-composition-`));
        const root = path.join(stage, 'application');
        fs.mkdirSync(root, { mode: 0o700 });
        materializeTemplate(selected.bundle, options, root, selected.provenance);
        // This new, uninstalled consumer has no DB configuration and never boots AppService.
        fs.writeFileSync(path.join(root, 'server/.env'), ['APP_ENV=development\nDEPLOYMENT_MODE=', selection.edition, '\n'].join(''), { mode: 0o600 });
        fs.chmodSync(path.join(root, 'server/.env'), 0o600);
        fs.writeFileSync(path.join(stage, 'create.json'), encode({ protocol: 'peanut.create-module-stage.v1', binding }), { mode: 0o600 });
    }
    const root = path.join(stage, 'application');
    const result = { ...selection, composition_stage: stage, staged_application: root,
        template_bundled_modules: selected.bundle.create.files.filter((file) => /^server\/app\/modules\/[^/]+\/[^/]+\/module.json$/.test(file.path)).length,
        dependencies_installed: false, runtime_activation: 'not-verified' };
    const blocked = (code, details = {}) => ({ ...result, status: 'blocked', blockers: [{ code, ...details }] });
    const writeBytes = (name, bytes) => {
        const file = path.join(stage, name);
        if (fs.existsSync(file)) existingFileWithin(stage, file);
        fs.writeFileSync(file, bytes, { mode: 0o600 });
    };
    const write = (name, value) => writeBytes(name, encode(value));
    const archives = {};
    const catalogCache = new Map();
    try {
        const archiveRoot = path.join(stage, 'archives');
        fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
        if (fs.realpathSync(archiveRoot) !== archiveRoot) fail('STAGE_PATH_INVALID');
        // Supply the full fixed catalog as a source hint; only Code selects its dependency closure.
        for (const row of selection.catalog) {
            const file = path.join(archiveRoot, row.asset);
            let bytes;
            if (fs.existsSync(file)) {
                existingFileWithin(stage, file);
                if (fs.statSync(file).size !== row.bytes) fail('ARCHIVE_DIGEST_MISMATCH');
                bytes = fs.readFileSync(file);
            }
            else if (source.release) bytes = await downloadModule({ ...row, release: source.release }, row.key, fetcher, catalogCache);
            else {
                const local = path.join(path.dirname(options.moduleIndex), row.asset);
                if (!fs.existsSync(local)) return blocked('ARCHIVE_REQUIRED', { key: row.key, path: local });
                existingFileWithin(path.dirname(options.moduleIndex), local);
                if (fs.statSync(local).size !== row.bytes) fail('ARCHIVE_DIGEST_MISMATCH');
                bytes = fs.readFileSync(local);
            }
            if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) fail('ARCHIVE_DIGEST_MISMATCH');
            verifyModuleArchive(bytes, row.key, row);
            if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
            archives[row.key] = file;
        }
        const indexPath = path.join(stage, 'module-release-index.json');
        writeBytes('module-release-index.json', source.bytes);
        const request = { schema_version: 1, protocol: 'peanut.module-source-composition-request.v1',
            edition: selection.edition, preset: selection.preset.name, optional,
            composition_sha256: selection.preset.sha256,
            index: { path: indexPath, sha256: source.sha256, repository: source.index.repository,
                tag: source.index.tag, commit: source.index.commit }, archives };
        const requestPath = path.join(stage, 'composition.json');
        write('composition.json', request);
        result.composition_request = request;
        const required = ['server/module', 'server/vendor/autoload.php', 'server/vendor/topthink/framework/src/helper.php'];
        const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
        if (missing.length) return blocked('CODE_NATIVE_DEPENDENCIES_REQUIRED', { missing,
            reason: 'Prepare this staged consumer through its native locked dependency tooling; vendor is never copied from another application.' });
        for (const file of required) existingFileWithin(root, path.join(root, file));
        if (typeof options.modulePhp !== 'string' || !path.isAbsolute(options.modulePhp)) return blocked('PHP_EXECUTABLE_REQUIRED');
        if (options.planSha256) {
            const reviewed = readJsonObject(existingFileWithin(stage, path.join(stage, 'plan.json')));
            if (reviewed.plan?.status !== 'ready' || reviewed.plan_sha256 !== options.planSha256) fail('REVIEWED_PLAN_REQUIRED');
        }
        const arguments_ = ['--composition', requestPath];
        if (options.planSha256) arguments_.push('--plan-sha256', options.planSha256);
        const child = spawnSync(options.modulePhp, [path.join(root, 'server/module')], {
            cwd: root, input: encode({ operation: 'adopt', arguments: arguments_ }), encoding: 'utf8',
            env: { ...process.env, ENV_NAME: '', PHP_ENV_NAME: '', APP_ENV: 'development', DEPLOYMENT_MODE: selection.edition },
            maxBuffer: 16 * 1024 * 1024,
        });
        result.native_process = { exit_code: child.status, signal: child.signal, stderr: child.stderr,
            error: child.error?.message ?? null };
        let native;
        try { native = JSON.parse(child.stdout); } catch {
            write('native-output.json', { ...result.native_process, stdout: child.stdout });
            return blocked('CODE_NATIVE_RESPONSE_INVALID', { native_process: result.native_process,
                recovery: { status: 'unknown', staged_application: root, command: 'adopt --recover' } });
        }
        result.native = native;
        result.recovery = native.recovery;
        write('native-result.json', { ...result.native_process, native });
        if (child.error || child.status !== 0) return { ...blocked(native.error ?? 'CODE_NATIVE_COMPOSITION_BLOCKED'),
            native, recovery: native.recovery, native_process: result.native_process };
        const plan = native.plan;
        if (plan?.schema_version !== 1 || plan.protocol !== 'peanut.module-source-composition-plan.v1'
            || plan.status !== 'ready' || plan.edition !== selection.edition
            || !isDeepStrictEqual(plan.roots, selection.roots)
            || plan.composition?.sha256 !== selection.preset.sha256 || plan.composition?.preset !== selection.preset.name
            || plan.index?.sha256 !== source.sha256 || plan.index?.repository !== source.index.repository
            || plan.index?.tag !== source.index.tag || plan.index?.commit !== source.index.commit
            || !Array.isArray(plan.modules) || !/^[a-f0-9]{64}$/.test(native.plan_sha256 ?? '')
            || plan.runtime_database_mutated !== false) {
            return { ...blocked('CODE_NATIVE_PLAN_IDENTITY_INVALID'), native, recovery: native.recovery };
        }
        result.plan_sha256 = native.plan_sha256;
        result.dependency_resolution = 'code-native';
        if (source.channel === 'stable' && plan.modules.some((row) => row.version.split('+')[0].includes('-'))) {
            return { ...blocked('PRERELEASE_OPT_IN_REQUIRED'), native, recovery: native.recovery };
        }
        if (!options.planSha256) {
            write('plan.json', native);
            return { ...result, status: 'ready', blockers: [] };
        }
        if (native.status !== 'source-prepared' || native.plan_sha256 !== options.planSha256
            || !['clean', 'recovered'].includes(native.recovery?.status)) {
            return { ...blocked('CODE_NATIVE_PREPARATION_UNCONFIRMED'), native, recovery: native.recovery };
        }
        // Never expose a consumer whose source transaction has not completed.
        const stat = fs.lstatSync(options.target, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(options.target).length)) fail('TARGET_NOT_EMPTY');
        fs.renameSync(root, options.target);
        return { ...result, status: 'source-created', blockers: [], target: options.target,
            staged_application: null, target_mutated: true, source_adoption: 'source-prepared',
            dependencies_installed: false, installation: 'not-run' };
    } catch (error) {
        // Keep native journals, before-images and the exact stage identity for repair/recovery.
        return { ...blocked(error.message), native: result.native, recovery: result.recovery,
            native_process: result.native_process };
    }
}
