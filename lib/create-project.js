import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULT_SOURCE = 'https://github.com/peanut-business/peanut-admin-code.git';
const DEFAULT_REF = 'dev';

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
    run('git', ['-C', checkout, 'fetch', '--quiet', '--depth=1', 'origin', ref]);
    run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    return {
        commit: run('git', ['-C', checkout, 'rev-parse', 'HEAD']),
        tree: run('git', ['-C', checkout, 'rev-parse', 'HEAD^{tree}']),
    };
}

export function createProject(options) {
    const target = targetPath(options.target);
    const name = requireString(options.name, 'PEANUT_CREATE_NAME_REQUIRED');
    const slug = requireString(options.slug, 'PEANUT_CREATE_SLUG_REQUIRED');
    const packageIdentity = requireString(options.package, 'PEANUT_CREATE_PACKAGE_REQUIRED');
    const edition = requireString(options.edition, 'PEANUT_CREATE_EDITION_REQUIRED');
    if (!['standalone', 'multi-tenant'].includes(edition)) fail('PEANUT_CREATE_EDITION_INVALID');

    const source = requireString(options.source ?? DEFAULT_SOURCE, 'PEANUT_CREATE_SOURCE_REQUIRED');
    const ref = requireString(options.ref ?? DEFAULT_REF, 'PEANUT_CREATE_REF_REQUIRED');
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-create-source-'));
    const checkout = path.join(sourceRoot, 'source');
    const staging = path.join(path.dirname(target), `.${path.basename(target)}.peanut-create-${process.pid}-${randomUUID()}`);

    try {
        const { commit: sourceCommit, tree: sourceTree } = checkoutSource(source, ref, checkout);
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
        ];
        if (options.profile) createArgs.push(`--profile=${options.profile}`);
        if (options.applicationVersion) createArgs.push(`--application-version=${options.applicationVersion}`);
        const raw = run('php', createArgs);
        let created;
        try { created = JSON.parse(raw); } catch { fail('PEANUT_CREATE_OUTPUT_INVALID'); }
        if (created?.status !== 'created') fail('PEANUT_CREATE_OUTPUT_INVALID');
        if (!fs.statSync(path.join(staging, '.peanut', 'application-manifest.json'), { throwIfNoEntry: false })?.isFile()) {
            fail('PEANUT_CREATE_MANIFEST_MISSING');
        }
        fs.renameSync(staging, target);
        return { ...created, target, source: { repository: source, ref, commit: sourceCommit, tree: sourceTree } };
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
}

export const createDefaults = Object.freeze({ source: DEFAULT_SOURCE, ref: DEFAULT_REF });
