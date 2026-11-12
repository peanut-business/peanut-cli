import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existingFileWithin, readJsonObject } from './protocol.js';

/** The APP owns tool constraints, detection and preparation. CLI only selects the public entry. */
export function automaticEnvironment(root) {
    const contract = path.join(root, 'tools/toolchain.json');
    return fs.existsSync(contract) && readJsonObject(existingFileWithin(root, contract)).execution?.protocol === 'peanut.project-env.v2';
}

export function environmentInvocation(root, tools = null, action = 'run') {
    const runner = existingFileWithin(root, path.join(root, 'scripts/project-env'), 'PEANUT_PROJECT_ENV_REQUIRED');
    if (automaticEnvironment(root)) {
        return { executable: process.env.PEANUT_TOOL_PYTHON3 || 'python3',
            args: [runner, '--root', root, '--state-root', root,
                ...(tools ? ['--tools', tools] : []), action, ...(action === 'run' ? ['--'] : [])] };
    }
    const file = path.join(root, '.local/toolchain/host.json');
    if (!fs.existsSync(file)) throw new Error('PEANUT_MODULE_CONFIG_REQUIRED: this APP has the legacy environment entry; run peanut config or upgrade its scaffold');
    const host = readJsonObject(existingFileWithin(root, file, 'PEANUT_MODULE_CONFIG_INVALID'));
    const python = host.commands?.python3;
    if (!Array.isArray(python) || typeof python[0] !== 'string' || !python[0]) throw new Error('PEANUT_MODULE_CONFIG_TOOL_MISSING: python3');
    return { executable: path.resolve(root, host.path_base ?? '.', python[0]),
        args: [runner, '--root', root, '--state-root', root, '--host', file,
            action === 'run' ? 'exec' : action, ...(action === 'run' ? ['--'] : [])] };
}

export function inspectEnvironment(root, tools = null) {
    const invocation = environmentInvocation(root, tools, 'doctor');
    const result = spawnSync(invocation.executable, invocation.args,
        { cwd: root, encoding: 'utf8', shell: false, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) return { status: 'incomplete', writes: false,
        reason: result.error?.message || result.stderr.trim(), exit_code: result.status };
    try {
        const report = JSON.parse(result.stdout);
        if (report.status !== 'ok' || report.writes !== false || !report.tools) throw new Error('Invalid native environment response');
        return report;
    } catch (error) {
        return { status: 'incomplete', writes: false, reason: error.message };
    }
}
