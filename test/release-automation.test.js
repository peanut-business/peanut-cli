import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildProject, parseBuildArguments } from '../lib/build-project.js';
import { sourceSnapshotDigest } from '../lib/source-snapshot.js';

const bin = fileURLToPath(new URL('../bin/peanut.js', import.meta.url));

// Native producer stand-in tests only orchestration and immutable output reuse.
// Template/TAR/schema validation is covered separately; this does not qualify a real release.
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'peanut-release-automation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('scaffold/application-template-inventory.json', { files: [] });
    write('scripts/scaffold-runtime/scaffold.conf.json', { protocol: 'peanut.scaffold-configuration.v1', source_snapshot: {
        excluded_names: ['.local', '.git'], excluded_paths: ['release'], excluded_name_patterns: [], retained_name_patterns: [], retained_paths: [],
    } });
    write('release-versions.json', { scaffold_template: '1.0.0' });
    write('scripts/build-scaffold-release', 'synthetic native producer; not production PHP');
    write('.local/toolchain/host.json', { commands: { python3: [process.execPath] } });
    write('scripts/project-env', `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), root = args[args.indexOf('--root') + 1];
const controlPath = path.join(root, '.local/control.json');
const control = fs.existsSync(controlPath) ? JSON.parse(fs.readFileSync(controlPath)) : {};
if (args.includes('doctor')) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({version:control.environment || process.versions.node,
    cache:control.cache || 'default',extra_path:control.extra_path || [],phprc:control.phprc || ''})).digest('hex');
  console.log(JSON.stringify({status:'ok',writes:false,fingerprint,tools:{node:{version:control.environment || process.versions.node,argv:[process.execPath]}}}));
  process.exit(0);
}
const child = args.slice(args.indexOf('--') + 1);
const option = name => child.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const edition = option('--edition'), output = option('--output'), version = option('--version');
if (!edition || !output) throw new Error('unexpected command; dependency install, DB and network are forbidden');
fs.appendFileSync(path.join(root,'.local/calls.jsonl'),JSON.stringify({edition,output})+'\\n');
fs.mkdirSync(output,{recursive:true});
if (control.failEdition === edition) { fs.writeFileSync(path.join(output,'partial'),'original failed output');process.exit(17); }
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)+'\\n');
const content = Buffer.from('stable payload '+edition);
fs.mkdirSync(path.join(output,'files/src'),{recursive:true});
fs.writeFileSync(path.join(output,'files/src/index.php'),content,{mode:0o644});
const source = {
 source_identity: {kind:'git',commit:control.wrongSource ? 'b'.repeat(40) : option('--source-commit'),tree:'c'.repeat(40)},
 inventory_sha256: sha('fixture inventory'), edition_profile_sha256: sha('fixture '+edition),
};
const manifest = {protocol:'peanut.scaffold-release.v3',schema_version:3,
 release:{version,source_identity:source.source_identity,inventory_sha256:source.inventory_sha256},
 edition:{name:edition,source_sha256:source.edition_profile_sha256},files:[{
 path:'src/index.php',source:'files/src/index.php',template_sha256:sha(content),mode:0o644}]};
const manifestBytes=encode(manifest), tar=Buffer.from('synthetic archive '+edition);
const tarname='peanut-scaffold-'+edition+'.tgz', metaname='peanut-scaffold-'+edition+'.json';
const metadata={protocol:'peanut.template-package.v1',schema_version:1,kind:'scaffold-template',version,edition,
 profile:'full',workflow:'full',source,create_manifest_sha256:sha('fixture creation'),upgrade_tooling_sha256:sha('fixture tooling'),
 archive:{name:tarname,bytes:tar.length,sha256:sha(tar)},scaffold_manifest_sha256:sha(manifestBytes)};
const artifacts={'scaffold-manifest.json':manifestBytes,[tarname]:tar,[metaname]:encode(metadata)};
for(const [name,bytes] of Object.entries(artifacts)) fs.writeFileSync(path.join(output,name),bytes);
fs.writeFileSync(path.join(output,'scaffold-build-inputs.json'),encode({
 protocol:'peanut.scaffold-build-inputs.v1',payload_sha256:sha(content),source,
 artifacts:Object.fromEntries(Object.entries(artifacts).map(([name,bytes])=>[name,{bytes:bytes.length,sha256:sha(bytes)}])),
}));
`);
    const options = { path: root, sourceCommit: 'a'.repeat(40) };
    const run = (extra = {}) => buildProject('release', { ...options, ...extra });
    const calls = () => fs.existsSync(path.join(root, '.local/calls.jsonl'))
        ? fs.readFileSync(path.join(root, '.local/calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    const state = () => {
        const file = fs.readdirSync(path.join(root, '.local/release')).find(name => name.startsWith('operation-') && name.endsWith('.json'));
        const full = path.join(root, '.local/release', file);
        return { file: full, value: JSON.parse(fs.readFileSync(full)) };
    };
    return { root, write, run, calls, state, options };
}

test('release plan is read-only; repeated completed release reuses the identical two archives without environment preparation', t => {
    const f = fixture(t);
    const preview = f.run({ plan: true });
    assert.equal(preview.status, 'planned');
    assert.equal(fs.existsSync(path.join(f.root, '.local/release')), false);
    const first = f.run();
    assert.equal(first.status, 'released');
    assert.equal(f.calls().length, 2);
    const second = f.run();
    assert.equal(second.status, 'reused');
    assert.deepEqual(second.packages, first.packages);
    assert.equal(f.calls().length, 2);
    assert.equal(f.run({ plan: true }).status, 'no_build_needed');
    fs.unlinkSync(path.join(f.root, '.local/toolchain/host.json'));
    assert.throws(() => f.run(), /PEANUT_MODULE_CONFIG_REQUIRED|ENVIRONMENT_NOT_READY/);
    const offlinePlan = f.run({ plan: true });
    assert.equal(offlinePlan.status, 'no_build_needed');
    assert.match(offlinePlan.scope, /does not check the execution environment/);
    assert.equal(f.calls().length, 2);
});

test('completed originals remain intact but cannot reuse a changed native execution fingerprint', t => {
    const f = fixture(t);
    const result = f.run();
    const originalSha = result.packages[0].archive.sha256;
    f.write('.local/control.json', { cache: 'other-cache', phprc: 'other-ini', extra_path: ['/other/tool/bin'] });
    assert.throws(() => f.run(), /COMPLETED_RELEASE_ENVIRONMENT_CHANGED/);
    assert.equal(f.calls().length, 2);
    assert.equal(f.state().value.status, 'complete');
    assert.equal(f.state().value.result.packages[0].archive.sha256, originalSha);
});

test('known failed MT build resumes from the same project-relative output and retains original failed files', t => {
    const f = fixture(t);
    const cwd = path.join(f.root, '.local', 'Invocation Folder');
    fs.mkdirSync(cwd);
    const project = ['--path', '../..', '--source-commit', f.options.sourceCommit];
    const output = ['--output', 'Build Outputs'];
    const sourceFile = 'Build Outputs/local-source.php';
    const lookalike = 'Build Outputs/.1.0.0.stage-Ab123Z/local-source.php';
    f.write(sourceFile, '<?php return 1;');
    f.write(lookalike, '<?php return 1;');
    const run = (...args) => spawnSync(process.execPath, [bin, 'release', ...project, ...args], { cwd, encoding: 'utf8' });
    const planned = run('--plan', ...output);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(JSON.parse(planned.stdout).output, path.join(f.root, output[1], '1.0.0'));
    f.write('.local/control.json', { failEdition: 'multi-tenant' });
    const failed = run(...output);
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /COMMAND_FAILED/);
    assert.equal(f.state().value.status, 'failed');
    assert.equal(f.state().value.editions.standalone.archive_sha256.length, 64);
    const saved = f.state();
    const pending = run('--plan', ...output);
    assert.equal(pending.status, 1, pending.stderr);
    assert.equal(JSON.parse(pending.stdout).status, 'resume_required');
    assert.equal(JSON.parse(pending.stdout).state, saved.file);
    assert.equal(JSON.parse(pending.stdout).input_sha256, JSON.parse(planned.stdout).input_sha256);
    fs.writeFileSync(saved.file, JSON.stringify({ ...saved.value, status: 'building' }));
    const unknown = run(...output, '--resume');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /NATIVE_OUTCOME_UNKNOWN/);
    assert.equal(f.calls().length, 2);
    fs.writeFileSync(saved.file, JSON.stringify(saved.value));
    for (const source of [sourceFile, lookalike]) {
        f.write(source, '<?php return 2;');
        const changed = run(...output, '--resume');
        assert.equal(changed.status, 2);
        assert.match(changed.stderr, /RESUME_OPERATION_NOT_FOUND_FOR_CURRENT_INPUTS/);
        assert.equal(f.calls().length, 2);
        f.write(source, '<?php return 1;');
    }
    for (const sourceRoot of ['.', 'scripts', 'scripts/child']) {
        const unsafe = run('--plan', '--output', sourceRoot);
        assert.equal(unsafe.status, 2);
        assert.match(unsafe.stderr, /OUTPUT_SOURCE_CONFLICT/);
    }
    const blocked = run(...output);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /RESUME_REQUIRED:.*--resume.*--output/);
    const otherOutput = run('--resume');
    assert.equal(otherOutput.status, 2);
    assert.match(otherOutput.stderr, /RESUME_OPERATION_NOT_FOUND_FOR_CURRENT_INPUTS/);
    f.write('.local/control.json', {});
    const resumed = run(...output, '--resume');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).status, 'released');
    assert.deepEqual(f.calls().map(row => row.edition), ['standalone', 'multi-tenant', 'multi-tenant']);
    const retained = f.state().value.retained_failed_outputs;
    assert.equal(retained.length, 1);
    assert.equal(fs.readFileSync(path.join(retained[0], 'partial'), 'utf8'), 'original failed output');
    assert.equal(f.state().file, saved.file);
    const completed = run(...output);
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(JSON.parse(completed.stdout).status, 'reused');
    assert.equal(f.calls().length, 3);
    const overwritten = run(...output, '--overwrite');
    assert.equal(overwritten.status, 0, overwritten.stderr);
    assert.equal(f.state().file, saved.file);
    assert.deepEqual(f.state().value.retained_failed_outputs, retained);
    const afterOverwrite = run(...output);
    assert.equal(afterOverwrite.status, 0, afterOverwrite.stderr);
    assert.equal(JSON.parse(afterOverwrite.stdout).status, 'reused');
    assert.equal(f.calls().length, 5);
});

test('overwrite keeps a prior failed operation stage bound to the same source fingerprint', t => {
    const f = fixture(t);
    const output = 'Build Outputs';
    f.write('.local/control.json', { failEdition: 'multi-tenant' });
    assert.throws(() => f.run({ output }), /COMMAND_FAILED/);
    const failed = f.state();
    const partial = path.join(failed.value.staging, 'multi-tenant', 'partial');
    assert.equal(fs.readFileSync(partial, 'utf8'), 'original failed output');

    f.write('.local/control.json', {});
    const complete = f.run({ output, overwrite: true });
    assert.equal(complete.status, 'released');
    assert.equal(complete.operation, failed.file);
    assert.ok(f.state().value.retained_failed_outputs.includes(failed.value.staging));
    assert.equal(fs.readFileSync(partial, 'utf8'), 'original failed output');
    assert.equal(f.run({ output }).status, 'reused');
    assert.equal(f.calls().length, 4);
});

test('a symlink inside unrecorded custom release output remains a source snapshot error', t => {
    const f = fixture(t);
    const output = 'Build Outputs';
    const run = (...args) => spawnSync(process.execPath, [bin, 'release', '--source-commit', f.options.sourceCommit,
        '--output', output, ...args], { cwd: f.root, encoding: 'utf8' });
    const completion = run();
    assert.equal(completion.status, 0, completion.stderr);
    fs.unlinkSync(f.state().file);
    const archive = path.join(output, '1.0.0', 'standalone', 'peanut-scaffold-standalone.tgz');
    const target = path.join(f.root, '.local', 'retained-archive.tgz');
    fs.renameSync(path.join(f.root, archive), target);
    fs.symlinkSync(target, path.join(f.root, archive));
    const plan = run('--plan');
    assert.equal(plan.status, 2, plan.stderr);
    assert.ok(plan.stderr.includes('SCAFFOLD_SOURCE_SNAPSHOT_SYMLINK: ' + archive.split(path.sep).join('/')));
    assert.equal(f.calls().length, 2);
});

test('a second version shares a custom output root with a previously verified release', t => {
    const f = fixture(t);
    const output = 'Build Outputs';
    const run = (...args) => spawnSync(process.execPath, [bin, 'release', '--source-commit', f.options.sourceCommit,
        '--output', output, ...args], { cwd: f.root, encoding: 'utf8' });
    const source = sourceSnapshotDigest(f.root);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(sourceSnapshotDigest(f.root), source);
    const archive = path.join(f.root, output, '1.0.0', 'standalone', 'peanut-scaffold-standalone.tgz');
    const original = fs.readFileSync(archive);
    const second = run('--version', '1.0.1');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).status, 'released');
    assert.equal(sourceSnapshotDigest(f.root), source);
    assert.deepEqual(fs.readFileSync(archive), original);
    const reuse = run('--version', '1.0.1');
    assert.equal(reuse.status, 0, reuse.stderr);
    assert.equal(JSON.parse(reuse.stdout).status, 'reused');
    assert.equal(f.calls().length, 4);
});

test('both versions remain reusable in a custom release root mixed with source', t => {
    const f = fixture(t);
    const output = 'Build Outputs';
    const run = (version, ...args) => spawnSync(process.execPath, [bin, 'release', '--source-commit', f.options.sourceCommit,
        '--output', output, '--version', version, ...args], { cwd: f.root, encoding: 'utf8' });
    const sourceFiles = ['Build Outputs/local-source.php', 'Build Outputs/9.9.9/source.php'];
    for (const file of sourceFiles) f.write(file, '<?php return 1;');
    const genericSource = sourceSnapshotDigest(f.root);

    const versions = ['1.0.0', '1.0.1'];
    const releases = versions.map(version => {
        const release = run(version);
        assert.equal(release.status, 0, release.stderr);
        return JSON.parse(release.stdout);
    });
    assert.notEqual(sourceSnapshotDigest(f.root), genericSource);
    for (const [index, version] of versions.entries()) {
        const plan = run(version, '--plan');
        assert.equal(plan.status, 0, plan.stderr);
        assert.equal(JSON.parse(plan.stdout).status, 'no_build_needed');
        assert.equal(JSON.parse(plan.stdout).input_sha256, releases[index].input_sha256);
        const reuse = run(version);
        assert.equal(reuse.status, 0, reuse.stderr);
        assert.equal(JSON.parse(reuse.stdout).status, 'reused');
        assert.equal(JSON.parse(reuse.stdout).operation, releases[index].operation);
    }
    for (const file of sourceFiles) {
        f.write(file, '<?php return 2;');
        for (const version of versions) {
            const changed = run(version, '--plan');
            assert.equal(changed.status, 1, changed.stderr);
            assert.equal(JSON.parse(changed.stdout).status, 'blocked');
        }
        f.write(file, '<?php return 1;');
    }
    assert.equal(f.calls().length, 4);
});

test('tampered completed ST archive blocks resume rather than triggering another ST build', t => {
    const f = fixture(t);
    f.write('.local/control.json', { failEdition: 'multi-tenant' });
    assert.throws(() => f.run(), /COMMAND_FAILED/);
    const directory = f.calls()[0].output;
    fs.writeFileSync(path.join(directory, 'peanut-scaffold-standalone.tgz'), 'tampered');
    f.write('.local/control.json', {});
    assert.throws(() => f.run({ resume: true }), /OVERWRITE_ARTIFACT_INVALID/);
    assert.equal(f.calls().length, 2);
});

test('changed sidecar proof cannot inherit a completed Edition result even with the same TAR', t => {
    const f = fixture(t);
    f.write('.local/control.json', { failEdition: 'multi-tenant' });
    assert.throws(() => f.run(), /COMMAND_FAILED/);
    const receipt = path.join(f.calls()[0].output, 'scaffold-build-inputs.json');
    const value = JSON.parse(fs.readFileSync(receipt));
    value.environment = { falsified: true };
    fs.writeFileSync(receipt, JSON.stringify(value));
    f.write('.local/control.json', {});
    assert.throws(() => f.run({ resume: true }), /RESUME_ARTIFACT_PROOF_CHANGED/);
    assert.equal(f.calls().length, 2);
});

test('changed source, environment and unknown native outcomes cannot reuse old validation', t => {
    const f = fixture(t);
    f.write('.local/control.json', { failEdition: 'multi-tenant' });
    assert.throws(() => f.run(), /COMMAND_FAILED/);
    f.write('.local/control.json', { environment: '999.0.0' });
    assert.throws(() => f.run({ resume: true }), /RESUME_ENVIRONMENT_CHANGED/);
    assert.equal(f.calls().length, 2);
    f.write('.local/control.json', { cache: 'another-store' });
    assert.throws(() => f.run({ resume: true }), /RESUME_ENVIRONMENT_CHANGED/);
    assert.equal(f.calls().length, 2);
    f.write('.local/control.json', {});
    const saved = f.state();
    saved.value.status = 'building';
    fs.writeFileSync(saved.file, JSON.stringify(saved.value));
    assert.throws(() => f.run({ resume: true }), /NATIVE_OUTCOME_UNKNOWN/);
    f.write('changed-source.php', '<?php return 1;');
    assert.throws(() => f.run({ resume: true }), /RESUME_OPERATION_NOT_FOUND_FOR_CURRENT_INPUTS/);
    assert.equal(f.calls().length, 2);
});

test('fixed source must equal the native package identity before output promotion', t => {
    const f = fixture(t);
    f.write('.local/control.json', { wrongSource: true });
    assert.throws(() => f.run(), /RELEASE_SOURCE_IDENTITY_INVALID/);
    assert.equal(fs.existsSync(path.join(f.root, 'release/1.0.0')), false);
    assert.throws(() => f.run({ sourceCommit: 'not-a-commit' }), /SOURCE_COMMIT_INVALID/);
});

test('release flags reject duplicates and expose existing entry plan/resume only', () => {
    assert.deepEqual(parseBuildArguments(['--plan', '--path', '/example']), { plan: true, path: '/example' });
    assert.deepEqual(parseBuildArguments(['--resume']), { resume: true });
    assert.throws(() => parseBuildArguments(['--resume', '--resume']), /ARGUMENTS_INVALID/);
});
