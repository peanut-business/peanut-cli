import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildProject, parseBuildArguments } from '../lib/build-project.js';

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
const manifest = {protocol:'peanut.scaffold-release.v3',release:{version},files:[{
 path:'src/index.php',source:'files/src/index.php',template_sha256:sha(content),mode:0o644}]};
const manifestBytes=encode(manifest), tar=Buffer.from('synthetic archive '+edition);
const tarname='peanut-scaffold-'+edition+'.tgz', metaname='peanut-scaffold-'+edition+'.json';
const metadata={protocol:'peanut.template-package.v1',version,edition,
 source:{source_identity:{kind:'git',commit:control.wrongSource ? 'b'.repeat(40) : option('--source-commit'),tree:'c'.repeat(40)}},
 archive:{name:tarname,bytes:tar.length,sha256:sha(tar)},scaffold_manifest_sha256:sha(manifestBytes)};
const artifacts={'scaffold-manifest.json':manifestBytes,[tarname]:tar,[metaname]:encode(metadata)};
for(const [name,bytes] of Object.entries(artifacts)) fs.writeFileSync(path.join(output,name),bytes);
fs.writeFileSync(path.join(output,'scaffold-build-inputs.json'),encode({artifacts:Object.fromEntries(
 Object.entries(artifacts).map(([name,bytes])=>[name,{bytes:bytes.length,sha256:sha(bytes)}]))}));
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
    assert.equal(f.run({ plan: true }).status, 'no_build_needed');
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

test('known failed MT build resumes only MT and retains original failed files', t => {
    const f = fixture(t);
    f.write('.local/control.json', { failEdition: 'multi-tenant' });
    assert.throws(() => f.run(), /COMMAND_FAILED/);
    assert.equal(f.state().value.status, 'failed');
    assert.equal(f.state().value.editions.standalone.archive_sha256.length, 64);
    assert.throws(() => f.run(), /RESUME_REQUIRED/);
    f.write('.local/control.json', {});
    const result = f.run({ resume: true });
    assert.equal(result.status, 'released');
    assert.deepEqual(f.calls().map(row => row.edition), ['standalone', 'multi-tenant', 'multi-tenant']);
    const retained = f.state().value.retained_failed_outputs;
    assert.equal(retained.length, 1);
    assert.equal(fs.readFileSync(path.join(retained[0], 'partial'), 'utf8'), 'original failed output');
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
