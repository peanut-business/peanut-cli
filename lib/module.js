import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existingFileWithin, projectRoot, readJsonObject } from './protocol.js';

export const MODULE_OPERATIONS = [
    'create', 'check', 'compile', 'pack', 'bundle-pack', 'adopt', 'install', 'upgrade',
    'disable', 'uninstall', 'sync', 'reconcile', 'make', 'lock', 'release-composition', 'work',
];

export function parseModuleArguments(raw) {
    const operation = raw[0];
    if (!MODULE_OPERATIONS.includes(operation)) throw new Error('PEANUT_MODULE_OPERATION_UNSUPPORTED');
    const arguments_ = [];
    let root;
    for (let index = 1; index < raw.length; index += 1) {
        const argument = raw[index];
        if (argument === '--') {
            arguments_.push(...raw.slice(index + 1));
            break;
        }
        if (argument === '--root' || argument.startsWith('--root=')) {
            if (root !== undefined) throw new Error('PEANUT_MODULE_ROOT_DUPLICATE');
            root = argument === '--root' ? raw[++index] : argument.slice(7);
            if (!root || root.startsWith('--')) throw new Error('PEANUT_MODULE_ROOT_REQUIRED');
        } else {
            arguments_.push(argument);
        }
    }
    return { operation, arguments: arguments_, root };
}

export function runModule(options) {
    const root = projectRoot(options.root ?? process.cwd());
    const entry = existingFileWithin(root, path.join(root, 'server/module'), 'PEANUT_MODULE_ENTRY_REQUIRED');
    const runner = existingFileWithin(root, path.join(root, 'scripts/project-env'), 'PEANUT_MODULE_PROJECT_ENV_REQUIRED');
    const hostPath = path.join(root, '.local/toolchain/host.json');
    if (!fs.existsSync(hostPath)) throw new Error('PEANUT_MODULE_CONFIG_REQUIRED: run peanut config first');
    const host = readJsonObject(existingFileWithin(root, hostPath, 'PEANUT_MODULE_CONFIG_INVALID'));
    const python = host.commands?.python3;
    if (!Array.isArray(python) || typeof python[0] !== 'string' || !python[0]) {
        throw new Error('PEANUT_MODULE_CONFIG_TOOL_MISSING: python3');
    }
    const executable = path.resolve(root, host.path_base ?? '.', python[0]);
    const child = spawnSync(executable, [runner, '--root', root, '--state-root', root, '--host', hostPath,
        'exec', '--', 'php', entry], {
        cwd: root,
        input: JSON.stringify({ operation: options.operation, arguments: options.arguments }) + '\n',
        stdio: ['pipe', 'inherit', 'inherit'],
        encoding: 'utf8',
    });
    if (child.error) throw new Error(`PEANUT_MODULE_COMMAND_FAILED: ${child.error.message}`);
    return child.status ?? 128 + (constants.signals[child.signal] ?? 0);
}
