#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    commandExists, existingFileWithin, phpEnvironmentChecks, projectPath,
    projectRoot, readJsonObject, validateReleaseVersions,
} from '../lib/protocol.js';
import { RecipeManager } from '../lib/recipe-manager.js';
import { createProject } from '../lib/create-project.js';

const CLI_VERSION = '0.2.0';
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
    process.stdout.write(
        `Peanut CLI ${CLI_VERSION}\n`
        + 'Usage: peanut create <target> --name <name> --slug <slug> --package <vendor/name> --edition standalone|multi-tenant [--profile <profile>] [--application-version <semver>] [--source <git-url-or-path>] [--ref <git-ref>]\n'
        + '       peanut doctor|status [--path <application>]\n'
        + '       peanut recipe list|status [<id>] [--path <application>]\n'
        + '       peanut recipe add github-ci [--path <application>]\n'
        + 'Create defaults to the public Peanut Admin repository at the latest dev ref; pin --ref for reproducible creation.\n',
    );
}

function output(result) { process.stdout.write(JSON.stringify(result, null, 4) + '\n'); }

function parseArguments(raw) {
    const arguments_ = [];
    let pathValue = null;
    for (let index = 0; index < raw.length; index += 1) {
        const argument = raw[index];
        if (argument === '--path' || argument.startsWith('--path=')) {
            if (pathValue !== null) throw new Error('PEANUT_DUPLICATE_PATH');
            pathValue = argument === '--path' ? (raw[++index] ?? '') : argument.slice(7);
            if (pathValue === '') throw new Error('PEANUT_PATH_REQUIRED');
        } else if (argument.startsWith('-')) {
            if (['--help', '-h'].includes(argument) && raw.length === 1) return { special: 'help' };
            if (argument === '--version' && raw.length === 1) return { special: 'version' };
            throw new Error('PEANUT_OPTION_UNSUPPORTED');
        } else {
            arguments_.push(argument);
        }
    }
    return { arguments: arguments_, pathValue };
}

function regularFile(file) {
    try {
        const stat = fs.lstatSync(file);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

function parseCreateArguments(raw) {
    const target = raw[0] ?? '';
    if (target === '' || target.startsWith('-')) throw new Error('PEANUT_CREATE_TARGET_REQUIRED');
    const values = {};
    const map = new Map([
        ['--name', 'name'], ['--slug', 'slug'], ['--package', 'package'], ['--edition', 'edition'],
        ['--profile', 'profile'], ['--application-version', 'applicationVersion'],
        ['--source', 'source'], ['--ref', 'ref'],
    ]);
    for (let index = 1; index < raw.length; index += 1) {
        const argument = raw[index];
        const equals = argument.indexOf('=');
        const flag = equals === -1 ? argument : argument.slice(0, equals);
        const key = map.get(flag);
        if (!key || Object.prototype.hasOwnProperty.call(values, key)) throw new Error('PEANUT_CREATE_ARGUMENTS_INVALID');
        const value = equals === -1 ? (raw[++index] ?? '') : argument.slice(equals + 1);
        if (value === '') throw new Error('PEANUT_CREATE_ARGUMENTS_INVALID');
        values[key] = value;
    }
    return { target, ...values };
}

function main() {
    if (process.argv[2] === 'create') {
        output(createProject(parseCreateArguments(process.argv.slice(3))));
        return 0;
    }
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.special === 'help') { usage(); return 0; }
    if (parsed.special === 'version') {
        process.stdout.write(`Peanut CLI ${CLI_VERSION}\n`);
        return 0;
    }
    const arguments_ = parsed.arguments;
    if (arguments_.length === 0) { usage(); return 0; }

    const root = projectRoot(parsed.pathValue ?? process.cwd());
    const recipes = new RecipeManager(toolRoot);
    const command = arguments_[0];

    if (command === 'recipe') {
        const action = arguments_[1] ?? '';
        const id = arguments_[2] ?? null;
        if (arguments_.length > 3 || (action === 'list' && id !== null)) {
            throw new Error('PEANUT_ARGUMENTS_INVALID');
        }
        if (action === 'list') output({ available: recipes.catalog() });
        else if (action === 'status') {
            const states = [];
            for (const recipe of id === null ? Object.keys(recipes.catalog()) : [id]) {
                states.push(recipes.status(root, recipe));
            }
            output({ recipes: states });
        } else if (action === 'add' && id !== null) output(recipes.add(root, id));
        else throw new Error('PEANUT_RECIPE_COMMAND_UNSUPPORTED');
        return 0;
    }

    if (arguments_.length !== 1 || !['doctor', 'status'].includes(command)) {
        throw new Error('PEANUT_COMMAND_UNSUPPORTED');
    }

    const manifestPath = projectPath(root, '.peanut/application-manifest.json');
    const application = fs.existsSync(manifestPath) ? recipes.application(root) : null;
    if (application === null && !regularFile(projectPath(root, 'scaffold/application-template-inventory.json'))) {
        throw new Error('APPLICATION_MANIFEST_REQUIRED');
    }

    const versionsPath = projectPath(root, 'release-versions.json');
    existingFileWithin(root, versionsPath, 'VERSION_CONTRACT_REQUIRED');
    const versions = validateReleaseVersions(readJsonObject(versionsPath));
    const recipeStates = Object.keys(recipes.catalog()).map((id) => recipes.status(root, id));

    if (command === 'status') {
        output({
            cli_version: CLI_VERSION,
            kind: application === null ? 'source_checkout' : 'application',
            application: application?.application ?? null,
            scaffold: application?.template ?? null,
            versions,
            recipes: recipeStates,
            upgrade_state_present: fs.existsSync(projectPath(root, '.peanut/upgrades')),
        });
        return 0;
    }

    const checks = {
        ...phpEnvironmentChecks(),
        tool_node: commandExists('node'),
        tool_npm: commandExists('npm'),
        tool_pnpm: commandExists('pnpm'),
    };
    for (const file of [
        'server/composer.json', 'server/composer.lock', 'web/package.json', 'web/pnpm-lock.yaml',
        'plugins.lock', 'RELEASE_METADATA.json', 'resources/project-resources.json',
        'scripts/project-composer', 'scripts/upgrade',
    ]) {
        const target = projectPath(root, file);
        checks[file] = regularFile(target);
        if (checks[file]) {
            existingFileWithin(root, target, 'DOCTOR_INPUT_INVALID');
            if (file.endsWith('.json') || (file.endsWith('.lock') && file !== 'web/pnpm-lock.yaml')) {
                readJsonObject(target);
            }
        }
    }
    checks.recipe_installation_complete = !recipeStates.some((state) => state.status === 'recovery_required');
    const ok = !Object.values(checks).includes(false);
    output({
        status: ok ? 'ok' : 'incomplete',
        scope: 'local tooling and metadata; no dependency install, network or runtime health check',
        checks,
    });
    return ok ? 0 : 1;
}

try {
    process.exitCode = main();
} catch (error) {
    process.stderr.write(`peanut: ${error.message}\n`);
    process.exitCode = 2;
}
