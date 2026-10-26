#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
    commandExists, existingFileWithin, phpEnvironmentChecks, projectPath,
    projectRoot, readJsonObject, validateReleaseVersions,
} from '../lib/protocol.js';
import { RecipeManager } from '../lib/recipe-manager.js';
import { createProject } from '../lib/create-project.js';
import { buildProject, parseBuildArguments } from '../lib/build-project.js';
import { upgradeProject } from '../lib/upgrade-project.js';
import { parseCollaborationArguments, serviceCollaboration } from '../lib/service-collaboration.js';
import { configureProject } from '../lib/configure.js';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_VERSION = readJsonObject(path.join(toolRoot, 'package.json')).version;

function usage(topic = null) {
    if (topic === 'config') {
        process.stdout.write(
            '用法：peanut config [选项]\npeanut help config\n\n'
            + '为当前 Peanut Admin Code 项目选择本机已安装工具，并写入忽略目录 .local/toolchain/host.json；随后调用现有 scripts/project-env prepare。不会安装软件或修改全局 PATH。\n\n'
            + '路径基准：--path 自身相对当前工作目录解析；其余路径及 Core host 中的 commands/caches/extra_path/watch_paths 相对所选 Code 根。\n\n'
            + '选项：\n'
            + '  --path <目录>                   Code 项目根，默认当前目录\n'
            + '  --php <文件>                    PHP 可执行文件\n'
            + '  --node <文件>                   Node.js 可执行文件\n'
            + '  --npm <文件>                    npm 可执行文件\n'
            + '  --pnpm <文件>                   pnpm 可执行文件\n'
            + '  --composer <文件>               Composer 可执行文件或 PHAR\n'
            + '  --python <文件>                 Python 3 可执行文件\n'
            + '  --core-php <目录>               本地 PHP Core 源码目录\n'
            + '  --core-web <目录>               本地 Web Core 源码目录\n'
            + '  --release <路径>                release 输出根，默认 release\n'
            + '  --backups <路径>                backups 目录，首次默认 ../backups\n'
            + '  --pnpm-cache <路径>              pnpm 缓存目录\n'
            + '  --npm-cache <路径>               npm 缓存目录\n'
            + '  --composer-cache <路径>          Composer 缓存目录\n'
            + '  --extra-path <目录>              指定额外搜索目录，可重复\n'
            + '  --watch-path <路径>              登记环境指纹观察路径，可重复\n'
            + '  --yes                            跳过最终确认；仍预览、写配置并执行 prepare\n\n'
            + '工具优先级：显式参数 > 已保存的有效绑定 > 自动发现；已有 host 中未改动的工具及路径设置会复用，不重复选择。失效绑定会报错，不静默改选。多个发现候选会提示选择；推荐版本差异只提示，manifest/平台及原生锁的实际兼容约束仍按 project-env 检查。npm/pnpm 使用同一所选 Node，Composer 使用所选 PHP。Core 工具要求分别从各自 composer.json/package.json 读取；不要求 Core 仓库包含 tools/toolchain.json 或 project-env。Core 源码目录只读，独立配置保存在 Code .local/toolchain/cores/<php|web>/host.json。\n',
        );
        return;
    }
    if (topic === 'release') {
        process.stdout.write(
            '用法：peanut release [选项]\npeanut help release\n\n'
            + '使用 Code 项目配置的工具环境调用其 scripts/build-scaffold-release，生成 Standalone 与 Multi-tenant 两个脚手架包；失败即停止。默认项目根为当前目录。\n\n'
            + '路径基准：--path 指定的项目根（默认当前目录）。--output 与 host 中 paths.release 可用相对或绝对路径；相对路径以项目根为基准。\n\n'
            + '选项：\n'
            + '本地发行选项：\n'
            + '  --path <目录>                    Code 脚手架项目根，默认当前目录\n'
            + '  --version <版本>                 匹配 release-versions.json.scaffold_template\n'
            + '  --core-php <版本>                指定已发布 PHP Core 版本\n'
            + '  --core-web <版本>                指定已发布 Web Core 版本（六包同版）\n'
            + '  --with-local-core                随包携带配置登记的本地 Core\n'
            + '  --output <路径>                  输出根，默认 host.paths.release 或 ./release\n'
            + '  --overwrite                      替换已知产物；遇未知文件或目录拒绝\n\n'
            + '固定 Git/CI 维护选项：\n'
            + '  --source-commit <40hex>          由固定 Git 候选/CI 明确指定真实源码提交\n'
            + '  --workflow <none|runtime|full>    固定生产工作流投影；需与候选合同匹配\n'
            + '  --internal-core-inputs <回执>      消费固定内部候选的 Core 冻结回执；必须与该候选工作流组合使用\n'
            + '  --api-tool-root <目录>             固定 CI/API 工具入口根目录\n'
            + '高级选项用于已固定输入的维护流水线，普通本地发行无需填写；互斥或不完整组合会拒绝。\n\n'
            + 'Core 默认选择最新正式稳定版；PHP 与 Web 版本独立，Web 六包保持同版。最终目录为 <output>/<版本>/standalone 和 multi-tenant。已存在同版本目录默认拒绝。host.paths.backups 仅保存备份路径配置，不会新增备份流程。Core 选择、来源和摘要写入包清单；默认不携带 Core 归档。此命令不发布或部署。\n',
        );
        return;
    }
    process.stdout.write(
        `Peanut CLI ${CLI_VERSION}\n`
        + 'Usage: peanut <command> [options]\n'
        + '       peanut help [config|release]\n'
        + '       peanut config [--path <project-root>] [--php <path>] [--node <path>] [--npm <path>] [--pnpm <path>] [--composer <path>] [--python <path>] [--core-php <path>] [--core-web <path>] [--release <path>] [--backups <path>] [--pnpm-cache <path>] [--npm-cache <path>] [--composer-cache <path>] [--extra-path <path>]... [--watch-path <path>]... [--yes]\n'
        + 'Usage: peanut create <absolute-target> --name <name> --slug <slug> --package <vendor/name> [--edition standalone|multi-tenant] [--application-version <semver>] [--ref <version>] [--channel stable|prerelease]\n'
        + '       peanut create <absolute-target> --name <name> --slug <slug> --package <vendor/name> --edition standalone|multi-tenant --archive <absolute-template.tgz> --manifest <absolute-template.json>\n'
        + '       peanut doctor|status [--path <application>]\n'
        + '       peanut release [--path <scaffold>] [--version <semver>] [--core-php <version>] [--core-web <version>] [--with-local-core] [--output <path>] [--overwrite]\n'
        + '       peanut package [--path <application>] [--core-inputs <absolute-frozen-core-receipt>] [--output <absolute-new-directory>]\n'
        + '       peanut upgrade [--check|--plan] [--ref <version-or-tag>] [--channel stable|prerelease] [--confirm-major-upgrade] [--path <application>]\n'
        + '       peanut upgrade [--check|--plan] --archive <absolute-template.tgz> --manifest <absolute-template.json> [--source-checkout <absolute-official-source>] [--baseline-mode-manifest <exact-old-release.json>] [--path <application>]\n'
        + '       peanut upgrade --apply-plan <plan> [--confirm-plan-sha256 <digest> --preserve-paths <paths|-> --replace-paths <paths|->] [--confirm-major-upgrade] [--path <application>]\n'
        + '       peanut upgrade --recover-plan <plan> [--path <application>]\n'
        + '       Upgrade coordinator override: --coordinator-root <canonical-git-root> --coordinator-commit <40hex> --installation-source-commit <40hex> (all required; persisted for apply/recover).\n'
        + '       peanut service collaboration plan|enable|status|disable --path <application> [--configuration <non-secret-json>] [--expected-revision <n>] [--probe] [--drain-id <original-id>]\n'
        + '       peanut recipe list|status [<id>] [--path <application>]\n'
        + '       peanut recipe add app-ci|scaffold-ci [--path <repository>]\n'
        + '路径规则：config/release 的路径参数可用相对或绝对路径；相对路径均以所选项目根为基准。\n'
        + 'config 配置已安装工具并写入项目 .local/toolchain/host.json，不安装软件、不修改全局 PATH。缺省从 PATH 和常见安装目录发现工具；多个版本会交互选择，并显示推荐版本与实际版本差异。\n'
        + 'config 参数：--path 项目根；--php/--node/--npm/--pnpm/--composer/--python 指定对应可执行文件；--core-php/--core-web 指定本地 Core 仓库；--release/--backups 设置发行与备份目录；--pnpm-cache/--npm-cache/--composer-cache 设置缓存；--extra-path/--watch-path 可重复指定搜索与观察路径。优先级为显式参数 > 已保存的有效配置 > 自动发现；未改动的配置直接复用，不重复选择。详见 peanut help config。\n'
        + 'release 参数：--path 脚手架项目根（默认当前目录）；--version 指定版本，必须等于 release-versions.json.scaffold_template；--core-php/--core-web 固定已发行 Core 版本；--with-local-core 使用 config 选择的本地 Core 快照；--output 指定发行根；--overwrite 仅允许覆盖该版本可识别的脚手架产物，遇到未知文件拒绝。\n'
        + 'release 默认输出到项目 ./release/<版本>/standalone 和 multi-tenant；不会自动递增版本。\n'
        + 'Interactive create prompts for an Edition when --edition is omitted; non-interactive create requires --edition.\n'
        + 'Edition, profile and workflow are fixed by the selected template package; an explicit mismatch is refused.\n'
        + 'Standalone and multi-tenant are separate application artifacts and deployments; normal upgrades remain within the same Edition.\n'
        + 'Create defaults to the latest official stable template attachment. Local archives require their paired manifest. No Git clone, PHP, dependency installation, database or service operation occurs. Target must be absent or strictly empty, including hidden files.\n'
        + 'Fixed-release APP discovery stays within the current major; development APP checks the latest published release. Applying a development source transition requires explicit --ref.\n'
        + 'Risk feature: cross-major upgrades may break custom business code, dependencies, APIs or migrations. Review the plan, keep a recoverable backup and resolve known risks before attempting apply.\n'
        + 'Cross-major apply requires --confirm-major-upgrade. AI/Agent operators must explain source to target, risks and plan and obtain human authorization before passing this flag; prior explicit authorization for this upgrade or a defined cross-major scope is sufficient, but generic development authorization is not.\n',
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
        ['--profile', 'profile'], ['--workflow', 'workflow'], ['--application-version', 'applicationVersion'],
        ['--archive', 'archive'], ['--manifest', 'manifest'], ['--ref', 'ref'], ['--channel', 'channel'],
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
    if (values.workflow !== undefined && !['none', 'runtime', 'full'].includes(values.workflow)) {
        throw new Error('PEANUT_CREATE_WORKFLOW_INVALID');
    }
    return { target, ...values };
}

async function chooseCreateEdition(options) {
    if (options.edition) return options;
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error('PEANUT_CREATE_EDITION_REQUIRED');
    }

    process.stderr.write(
        'Choose application Edition:\n'
        + '  1) multi-tenant  Multi-tenant deployment with Platform and tenant management\n'
        + '  2) standalone    Single-tenant independent deployment\n'
        + 'The two Editions are generated, deployed, and upgraded separately.\n',
    );
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = (await prompt.question('Edition [1/2]: ')).trim().toLowerCase();
        const edition = answer === '1' || answer === 'multi-tenant'
            ? 'multi-tenant'
            : answer === '2' || answer === 'standalone'
                ? 'standalone'
                : null;
        if (edition === null) throw new Error('PEANUT_CREATE_EDITION_INVALID');
        return { ...options, edition };
    } finally {
        prompt.close();
    }
}

function parseUpgradeArguments(raw) {
    const values = {};
    const map = new Map([
        ['--path', 'path'], ['--ref', 'ref'], ['--channel', 'channel'], ['--apply-plan', 'applyPlan'],
        ['--recover-plan', 'recoverPlan'], ['--confirm-plan-sha256', 'confirmPlanSha256'],
        ['--preserve-paths', 'preservePaths'], ['--replace-paths', 'replacePaths'],
        ['--archive', 'archive'], ['--manifest', 'manifest'], ['--baseline-mode-manifest', 'baselineModeManifest'],
        ['--source-checkout', 'sourceCheckout'],
        ['--coordinator-root', 'coordinatorRoot'], ['--coordinator-commit', 'coordinatorCommit'],
        ['--installation-source-commit', 'installationSourceCommit'],
        ['--check', 'check'], ['--plan', 'plan'], ['--confirm-major-upgrade', 'confirmMajorUpgrade'],
    ]);
    for (let index = 0; index < raw.length; index += 1) {
        const argument = raw[index];
        const equals = argument.indexOf('=');
        const flag = equals === -1 ? argument : argument.slice(0, equals);
        const key = map.get(flag);
        if (!key || Object.hasOwn(values, key)) throw new Error('PEANUT_UPGRADE_ARGUMENTS_INVALID');
        if (key === 'check' || key === 'plan' || key === 'confirmMajorUpgrade') {
            if (equals !== -1) throw new Error('PEANUT_UPGRADE_ARGUMENTS_INVALID');
            values[key] = true;
        } else {
            const value = equals === -1 ? (raw[++index] ?? '') : argument.slice(equals + 1);
            if (!value || value.startsWith('--')) throw new Error('PEANUT_UPGRADE_ARGUMENTS_INVALID');
            values[key] = value;
        }
    }
    if ([values.check, values.plan, values.applyPlan, values.recoverPlan].filter(Boolean).length > 1
        || ((values.applyPlan || values.recoverPlan) && (values.ref || values.channel || values.archive || values.manifest || values.baselineModeManifest || values.sourceCheckout))
        || (values.sourceCheckout && (!values.archive || !values.manifest || values.ref || values.channel))
        || ((values.confirmPlanSha256 || values.preservePaths || values.replacePaths) && !values.applyPlan)) {
        throw new Error('PEANUT_UPGRADE_ARGUMENTS_INVALID');
    }
    return values;
}

async function main() {
    if (process.argv[2] === 'help') {
        const topic = process.argv[3];
        if (process.argv.length > 4 || (topic && !['config', 'release'].includes(topic))) throw new Error('PEANUT_HELP_TOPIC_INVALID');
        usage(topic);
        return 0;
    }
    if (['release', 'package'].includes(process.argv[2])) {
        if (process.argv.slice(3).some((item) => ['--help', '-h'].includes(item))) { usage(process.argv[2] === 'release' ? 'release' : null); return 0; }
        output(await buildProject(process.argv[2], parseBuildArguments(process.argv.slice(3))));
        return 0;
    }
    if (process.argv[2] === 'service') {
        if (process.argv[3] !== 'collaboration') throw new Error('PEANUT_SERVICE_UNSUPPORTED');
        const { result, exitCode } = serviceCollaboration(parseCollaborationArguments(process.argv.slice(4)));
        output(result);
        return exitCode;
    }
    if (process.argv[2] === 'create') {
        const createOptions = await chooseCreateEdition(parseCreateArguments(process.argv.slice(3)));
        output(await createProject(createOptions));
        return 0;
    }
    if (process.argv[2] === 'upgrade') {
        const result = await upgradeProject(parseUpgradeArguments(process.argv.slice(3)));
        output(result);
        return ['blocked', 'source_identity_mismatch', 'source_identity_unknown', 'source_range_unsupported', 'source_ahead', 'source_diverged', 'explicit_release_ref_required', 'confirmation_required'].includes(result.status) ? 1 : 0;
    }
    if (process.argv[2] === 'config') {
        const raw = process.argv.slice(3);
        let configRoot = process.cwd();
        let pathSeen = false;
        const options = {};
        const allowed = new Map([
            ['--path', null], ['--php', 'php'], ['--node', 'node'], ['--npm', 'npm'], ['--pnpm', 'pnpm'],
            ['--composer', 'composer'], ['--python', 'python3'], ['--core-php', 'corePhp'], ['--core-web', 'coreWeb'],
            ['--release', 'releasePath'], ['--backups', 'backupsPath'], ['--pnpm-cache', 'pnpmCache'],
            ['--npm-cache', 'npmCache'], ['--composer-cache', 'composerCache'], ['--extra-path', 'extraPaths'],
            ['--watch-path', 'watchPaths'], ['--yes', 'yes'],
        ]);
        for (let index = 0; index < raw.length; index += 1) {
            const split = raw[index].indexOf('=');
            const flag = split < 0 ? raw[index] : raw[index].slice(0, split);
            if (['--help', '-h'].includes(flag)) { usage('config'); return 0; }
            const key = allowed.get(flag);
            if (key === undefined) throw new Error('PEANUT_CONFIG_ARGUMENTS_INVALID');
            if (key === 'yes') {
                if (split !== -1 || Object.hasOwn(options, key)) throw new Error('PEANUT_CONFIG_ARGUMENTS_INVALID');
                options.yes = true;
                continue;
            }
            const value = split < 0 ? (raw[++index] ?? '') : raw[index].slice(split + 1);
            if (!value) throw new Error('PEANUT_CONFIG_ARGUMENTS_INVALID');
            if (key === null) {
                if (pathSeen) throw new Error('PEANUT_CONFIG_ARGUMENTS_INVALID');
                pathSeen = true;
                configRoot = value;
            }
            else if (['extraPaths', 'watchPaths'].includes(key)) (options[key] ??= []).push(value);
            else {
                if (Object.hasOwn(options, key)) throw new Error('PEANUT_CONFIG_ARGUMENTS_INVALID');
                options[key] = value;
            }
        }
        output(await configureProject(projectRoot(configRoot), options));
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
            generation_source: application?.generation_source ?? null,
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
    process.exitCode = await main();
} catch (error) {
    process.stderr.write(`peanut: ${error.message}\n`);
    process.exitCode = 2;
}
