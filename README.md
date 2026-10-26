# Peanut CLI

Peanut CLI 是独立版本的 `peanut` 命令行工具，负责 Peanut 应用模板、环境配置、诊断、升级和 Recipe 管理。

## 1. 安装与工作目录

开发期从 CLI 仓库安装或更新：

```sh
cd /path/to/peanut-cli
npm install -g .
```

正式安装或更新使用 GitHub Release 附带的 tarball。npm registry 未配置；开发源码和未发布版本不能描述为正式发行。已下载 tarball 的安装形式如下，文件名仅作占位：

```sh
npm install -g /path/to/peanut-cli-X.Y.Z.tgz
```

按命令操作对象选择工作目录：`config` 和 `release` 使用选定的 Peanut Admin Code 根；`doctor`、`status`、`upgrade`、`package`、`recipe` 使用目标 APP 或脚手架根；`create` 的第一个参数是新目标目录。支持 `--path` 的命令可用它选择根目录。`--path` 自身相对命令当前目录解析；config/release 的其他路径相对选定 Code 根解析。临时 worktree 是独立项目根，勿与日常 Documents 主目录混用。普通用户运行已安装的 `peanut` 命令；CLI 内部调用 Code 的 `scripts/project-env` 和 `scripts/build-scaffold-release`，不直接运行 CLI 仓库 `bin/peanut.js`。

CLI 安装和环境配置是首次准备。环境与路径不变时，日常生成脚手架只需 `peanut release`，无需手动 prepare/install/hash。

## 2. 命令速查

```sh
peanut help
peanut --version
peanut doctor --path /absolute/app
peanut status --path /absolute/app
peanut recipe list --path /absolute/app
peanut recipe status app-ci --path /absolute/app
peanut recipe add app-ci --path /absolute/app
```

| 命令 | 用途 |
| --- | --- |
| `help`, `--version` | 查看命令摘要和 CLI 版本 |
| `config` | 选择已安装工具并保存项目环境配置 |
| `release` | 生成 Standalone、Multi-tenant 脚手架包 |
| `create` | 从官方模板或本地归档创建应用 |
| `upgrade` | 检查、规划、应用或恢复模板升级 |
| `doctor`, `status` | 诊断或查看应用状态 |
| `recipe list` | 列出可用 Recipe |
| `recipe status [id]` | 查看全部或指定 Recipe 状态 |
| `recipe add <id>` | 安装指定 Recipe |
| `package` | 调用应用原生入口生成 server-only 包 |

## 3. 配置环境：config

```sh
peanut config --path /absolute/peanut-admin-code
peanut config --path /absolute/peanut-admin-code --php /usr/bin/php --node /usr/local/bin/node
peanut config --path /absolute/peanut-admin-code --yes
```

| 参数 | 取值 | 默认或复用 | 作用 |
| --- | --- | --- | --- |
| `--path` | Code 根目录 | 当前目录 | 选择配置项目；自身相对当前目录解析 |
| `--php`, `--node`, `--npm`, `--pnpm`, `--composer`, `--python` | 已安装工具路径 | 显式参数 > 有效配置 > 自动发现 | 选择本机工具；首次配置 Core 沿用本项目已选工具；已有 Core 配置则保留其选择 |
| `--core-php`, `--core-web` | 本地 Core 源码目录 | 有效配置或邻接发现 | 登记源码目录；不会因此自动随发行包携带 |
| `--release`, `--backups` | 路径 | release=`release`；backups 初次=`../backups` | 保存发行输出根和备份位置；已有值继续复用 |
| `--pnpm-cache`, `--npm-cache`, `--composer-cache` | 路径 | `.local/toolchain/cache/<tool>` | 设置工具缓存位置 |
| `--extra-path`, `--watch-path` | 路径，可重复 | 未指定时复用已存值 | 显式指定额外搜索目录或观察路径列表 |
| `--yes` | 开关 | 默认预览后询问 | 自动确认写入并执行 prepare；不是只读，也不代替工具选择 |

配置保存在 Code `.local/toolchain/host.json`；Core 各自配置在 `.local/toolchain/cores/<php|web>/host.json`。

## 4. 生成脚手架：release

```sh
cd /absolute/peanut-admin-code
peanut release
peanut release --output ../artifacts --overwrite
peanut release --with-local-core
```

| 参数 | 取值 | 默认或复用 | 作用 |
| --- | --- | --- | --- |
| `--path` | Code 根目录 | 当前目录 | 选择脚手架源码根 |
| `--version` | 版本号 | `release-versions.json.scaffold_template` | 匹配断言，不自动递增 |
| `--core-php`, `--core-web` | 已发行版本 | 最新正式稳定版 | 选择 PHP/Web Core 版本；Web 六包同版 |
| `--with-local-core` | 开关 | 默认不携带 | 携带 PHP Core 源码包和 Web Core 构建库包 |
| `--output` | 路径 | 配置 `paths.release` 或 `./release` | 指定输出根；相对路径以 Code 根解析 |
| `--overwrite` | 开关 | 已有版本默认拒绝 | 原位替换已知产物；存在未知内容时拒绝 |

输出为“解析后的输出根/<版本>/{standalone,multi-tenant}”；仅当输出根为相对路径时才拼接 Code 根。本地 Core 配置目录不会自动随包携带；前端依赖采用 Core 构建库模式。命令内部调用所选 Code 根的环境入口和原生构建脚本；不发布或部署。

## 5. 创建应用：create

```sh
peanut create /absolute/new-app --name "Business App" --slug business-app --package example/business-app --edition standalone
peanut create /absolute/new-app --name "Business App" --slug business-app --package example/business-app --edition standalone --archive /absolute/template.tgz --manifest /absolute/template.json
```

| 参数 | 必需/默认 | 说明 |
| --- | --- | --- |
| `<目标>` | 必需，绝对路径 | 目标必须不存在或为空目录 |
| `--name`, `--slug`, `--package` | 必需 | 产品名、应用 slug、`vendor/name` |
| `--edition` | 交互终端可选择；非交互必需 | `standalone` 或 `multi-tenant`，没有隐式默认 |
| `--application-version` | 模板声明的默认值 | 设置独立 APP 版本 |
| `--ref` | 最新 stable | 固定官方模板版本；`--channel` 可选 `stable`/`prerelease` |
| `--archive`, `--manifest` | 必须成对 | 使用绝对路径本地包；不可与 `--ref`/`--channel` 同用 |
| `--profile`, `--workflow` | 模板固定值 | 可作一致性断言；不匹配会拒绝。Workflow 可为 `none`/`runtime`/`full` |

## 6. 升级应用：upgrade

```sh
peanut upgrade --check --path /absolute/app
peanut upgrade --plan --ref 5.0.2 --path /absolute/app
peanut upgrade --apply-plan /absolute/plan.json --path /absolute/app
peanut upgrade --recover-plan /absolute/plan.json --path /absolute/app
```

| 参数 | 必需/默认 | 说明 |
| --- | --- | --- |
| `--path` | 当前目录 | APP 根目录 |
| `--check` 或 `--plan` | 两者择一；都省略则创建计划 | 不能与 apply/recover 组合 |
| `--ref`, `--channel` | 默认 stable | 选择官方版本/通道；通道为 `stable` 或 `prerelease` |
| `--archive`, `--manifest` | 必须成对 | 本地归档及清单；不能与 `--ref`/`--channel` 同用 |
| `--source-checkout` | 可选 | 本地开发包的来源证明 checkout；须与 archive/manifest 同用 |
| `--baseline-mode-manifest` | 可选 | 为旧 APP 基线模式提供原始发布清单 |
| `--apply-plan` | 使用已有计划时必需 | 应用指定计划；可配 `--confirm-plan-sha256`、`--preserve-paths`、`--replace-paths` |
| `--recover-plan` | 恢复时必需 | 按原计划执行文件恢复；不可与来源选择参数同用 |
| `--confirm-major-upgrade` | 跨主版本 apply 时必需 | 确认跨主版本升级；需先审阅计划并获授权 |

`--apply-plan` 与 `--recover-plan` 是真实命令选项；CLI 没有单独的 `--apply` 开关。`--preserve-paths` 与 `--replace-paths` 使用路径列表，空列表写 `-`。

## 7. 诊断、状态、Recipe 与打包

```sh
peanut doctor --path /absolute/app
peanut status --path /absolute/app
peanut recipe list --path /absolute/app
peanut recipe status --path /absolute/app
peanut recipe status app-ci --path /absolute/app
peanut recipe add app-ci --path /absolute/app
peanut package --path /absolute/app --output /absolute/new-server-package
```

| 命令/参数 | 必需/默认 | 说明 |
| --- | --- | --- |
| `doctor`, `status` | `--path` 默认当前目录 | 检查或输出应用/脚手架状态；根目录须含有效应用清单或脚手架 inventory 及版本合同 |
| `recipe list` | `--path` 默认当前目录 | 列出内置可用 Recipe；不接受 id |
| `recipe status [id]` | id 可省略 | 查看全部或指定 Recipe 状态 |
| `recipe add <id>` | id 必需 | 添加 `app-ci` 或 `scaffold-ci`；路径选 APP 或脚手架仓 |
| `package --path` | 必需有效 APP 根 | 调用 APP 自有 server-only 打包脚本 |
| `package --core-inputs` | 可选，绝对路径 | 使用固定 Core 输入回执；仅用于 package |
| `package --output` | 可选，绝对路径 | 指定新的输出目录 |

`config --core-php/--core-web` 的参数值是**本地源码目录**；`release --core-php/--core-web` 的参数值是**已发行版本号**。

<details>
<summary>维护者参考：高级合同、来源校验与固定发行示例</summary>

### config / release 实现合同

- `config` 先预览工具、推荐版本、路径、来源文件和写入对象，再由用户确认；`--yes` 只跳过最终确认，仍写入并调用 Code `scripts/project-env prepare`。它不消解歧义选择。拒绝确认不改文件；未提供新参数时复用有效绑定和路径。
- 配置只登记已安装工具，不安装软件或修改全局 PATH。Core 要求分别来自其 `composer.json` / `package.json`；Core 源码只读，独立 host 与缓存位于 Code `.local/toolchain/cores/php|web/`。Core 首次选择继承主工具已选 scope，既有 Core scope 复用自身绑定。主缓存默认 `.local/toolchain/cache/{pnpm,npm,composer}`，Core 缓存默认 `.local/toolchain/cores/{php,web}/cache/<tool>`。
- 推荐版本差异只告警；manifest/platform 要求和原生锁仍受校验。外部 Composer 绑定本地路径、版本与文件 SHA-256，用于发现本地文件替换，不证明官方来源。
- `release` 对当前磁盘源码快照发行（包含未提交内容），排除 Git 元数据、本地配置、依赖、运行数据和旧输出。Core 版本独立，Web 六包同版；Core 来源与摘要写入清单。默认不携带 Core 归档。
- 固定 Git/CI 流程可用 `--source-commit` 固定源码提交、`--workflow` 选择投影、`--internal-core-inputs` 消费内部候选冻结 Core 回执、`--api-tool-root` 选择 API 工具入口。它们须符合固定候选来源/工作流合同；普通本地发行不使用这些参数，不能用占位 Git 身份替代正式检查。

The current source catalog separates `app-ci@1.0.0` from `scaffold-ci@1.0.0`. APP CI calls the APP's existing server-only producer with its explicit root. Scaffold CI calls the same native template producer as `peanut release`, serially for both Editions, and uploads the four fixed template files. These workflows prepare candidates; formal GitHub publication still requires the release qualification and authorized CI publication path. The CLI repository's own release workflow publishes only CLI artifacts. Source installation does not publish or execute CI.
`peanut create` defaults to the latest official stable GitHub template attachment. `--ref <version>` pins a release; prereleases require explicit `--channel prerelease`. Releases without the paired Edition template attachments fail closed. Local `--archive` and `--manifest` must be absolute and cannot be combined with release/channel selection. Local provenance remains development/local. There is no Git-source or dev fallback, implicit dependency install, database operation or service start.

Template packages require `peanut.template-package.v1` and its complete creation payload. Historical releases without these attachments cannot be consumed by archive creation; updating CLI does not retrofit published assets.

When a developer runs `peanut create` in an interactive terminal without `--edition`, the CLI requires an explicit choice between `multi-tenant` and `standalone`. Machine/CI usage remains fail-closed and must pass `--edition`. There is no implicit Edition default.

Profile and Workflow are fixed by the template. Optional `--profile`/`--workflow` are assertions; mismatches fail. `--application-version` sets the independent APP version; omission uses the template's declared default. Product names accept Unicode and spaces up to 80 UTF-8 bytes; control characters and code/markup delimiters are rejected.

The two Editions are separate deliverables and deployments. `standalone` produces the single-tenant projection and omits the Platform bundle; `multi-tenant` produces the Platform/tenant-management projection. Their runtime directories, configuration and deployment identities must not be mixed, and normal APP/scaffold upgrades remain within the recorded Edition rather than changing Edition as a side effect.

For product validation, shared code and the common lifecycle do not need two identical full test runs. Use the maintainer's two registered permanent APPs for post-package validation; do not create a new test APP per attempt. Shared lifecycle evidence may be reused only for unchanged inputs and genuinely shared behavior. Multi-tenant should be the primary broad functional/regression target because it includes the additional Platform, tenant-management, Host and tenant-switching surfaces. The other Edition still requires its Edition projection checks and critical create/install/start/login/deploy/upgrade smoke path. Edition-specific behavior must be tested in the Edition that owns it.

Creation validates package/file digests, fixed source, Edition, member uniqueness, regular-file types, size and path boundaries before staging. It records package provenance and rebuilds final file/tree hashes and managed baselines while retaining app-owned defaults. Official Module contents remain fixed; APP branding changes host identity. Composer content-hash and API input hashes use final bytes without dependency resolution. An absent or strictly empty target is accepted; hidden files, `.git`, any other content and symlink path components are refused. Failure removes only the unadopted staging tree.

## Development APP upstream upgrades

`peanut upgrade` selects the same versioned template format used by `create`, from exact official GitHub release attachments or an explicit local archive/manifest pair. It validates and caches the complete fixed archive before calling its native `scripts/scaffold-upgrade`; CLI implements transport and binding, while the PHP runner owns baseline comparison, conflicts, apply, verification, journal and recovery. PHP is required for planning/apply/recovery. Composer, Python and an extra prepare command are unnecessary. A source checkout is needed only for the explicit same-version development successor proof described below. Upgrade tooling dependencies are sealed separately inside the template; they are never installed into the APP by this command.

```sh
peanut upgrade --check --path /absolute/app
peanut upgrade --plan --ref 5.0.2 --path /absolute/app
peanut upgrade --plan --archive /absolute/template.tgz --manifest /absolute/template.json \
  --baseline-mode-manifest /absolute/exact-original-release.json --path /absolute/app
```

Discovery defaults to stable releases within the APP's existing major and Edition. Prereleases and cross-major versions require explicit selection. Local packages record development plus the exact archive identity; official acquisition provenance is recorded independently of the template producer's original source channel. Unknown official source identity, ahead/diverged development sources, downgrades and equal-version official source changes are refused. A content-equivalent development-to-official adoption still needs the native comparison of every recorded baseline byte and mode. Old APP manifests without `baseline_mode` need the exact original release manifest as mode evidence; live file modes are never substituted for missing baseline modes.

For an explicitly selected local development package at the current template version, add `--source-checkout /absolute/peanut-admin-code` to `--check` or `--plan`. Both current and target sources must be development identities; the target producer ref must be its exact commit. CLI reads immutable Git objects from that checkout and verifies its official origin, both commit/tree/inventory/Edition-profile identities, the APP's current recorded base and Edition, each profile's declaration in its source inventory, the declared Workflow, and that the current commit is an ancestor of the target. The APP's retained profile is its own identity; an explicitly selected `full` template does not rename a `standard` APP or add a missing Workflow identity field. It rejects shallow or grafted history, missing objects, unknown identities and non-successors before writing any APP cache or plan. It does not fetch, edit the checkout or require its working tree to match the fixed target. CLI forwards the canonical checkout to native `template-plan` and requires its returned source relation and exact five-field development context: `profile`, `workflow`, `workflow_present`, `workflow_paths_sha256` and `excluded_paths_sha256`. An explicit Workflow value must match the APP; an absent field stays absent while native proves the selected target Workflow against the recorded baseline and fixed base inventory. The presence bool and baseline-path digest remain distinct from the selected value. A template without this native proof remains refused; CLI does not issue an internal-preinstall or runtime context to bypass it. Normal archive checks and native conflict, protection, backup and recovery gates still apply. The native proof and checkout are saved with the engine binding and retained through conflict resolution. Saved apply, verify and recovery reuse that fixed selection and require the same checkout to remain available for native proof revalidation; they do not rediscover a source. This option does not permit a different source at the same official release version.

The default command creates an immutable plan and returns its path. A conflict returns `blocked` without applying managed changes. Review every conflict and explicitly preserve or replace each path; use `-` for an empty decision list:

```sh
peanut upgrade --apply-plan .peanut/upgrades/plans/<candidate>.json \
  --confirm-plan-sha256 sha256:<plan-digest> \
  --preserve-paths path/to/customized-file --replace-paths - --path /absolute/app
```

A ready plan uses `peanut upgrade --apply-plan <plan> --path /absolute/app`. Cross-major and development-to-official transitions additionally require `--confirm-major-upgrade` under the existing human authorization boundary. An AI/Agent must explain the versions and risk and obtain authorization for that scope; prior explicit authorization is sufficient. Neither a ref nor conflict choices replace that authorization. Saved apply and recovery reuse the bound archive, source, engine and plan; they never discover latest again. Altered engine/tooling files, undeclared execution inputs, symlinks and changed plan bindings are rejected.

After a failed apply, inspect the native journal and use `peanut upgrade --recover-plan <plan> --path /absolute/app`. This restores source only. Source upgrades do not install APP dependencies, build clients, run migrations, start services or deploy production. Follow the changed locks and affected clients when preparing the APP's normal runtime and server-only release.

A template that implements native installed-source adoption can bind an already installed generated APP to its immutable installation receipt/baseline and current configuration, under the existing source and instance locks. Its source coordinator requires actual stopped-process/open-file/container observations; a missing Docker configuration file is not evidence of no containers. Python 3 from the template's toolchain, `ps`, `lsof` and a complete readable Docker container view must be available. Missing tools, inaccessible observations, active users or unknown operations are refused, without installing tools or stopping services implicitly. The verified cached template supplies the native tooling, so the old APP does not need a manual upgrade-script patch. Source apply retains maintenance until the same plan is verified or recovered, and does not reopen traffic. Protected runtime projections, partial installations and server deployments retain their full controlled maintenance workflow. File recovery does not establish database recovery qualification.

Native conflict plans use exit 2 with a valid blocked JSON response; CLI preserves the plan binding and returns exit 1. Invalid inputs, download failures or native errors return exit 2. A successful check, plan, apply or recovery returns exit 0. The package/plan/native journal remain under `.peanut/upgrades/` for review and recovery.

The retired combined `github-ci` source bundles are removed from the current catalog. Existing installed Recipe baselines and customized workflows are preserved; adding a new Recipe refuses a colliding file instead of overwriting it.

The CLI has no npm runtime dependencies. It reads stable public Peanut application/release/Recipe protocols and does not import implementation source from Peanut Admin or either Core repository.

## Local development

```sh
npm test
npm run check
node bin/peanut.js --version
```

A checkout can be installed locally for CLI testing with `npm install -g .`. The team development policy is to use the newest approved CLI build from `dev`. Public distribution uses the official GitHub Release package; the npm registry channel is not configured and `@peanut/cli` is not claimed to be published there.

## Public release contract

`.github/workflows/release.yml` publishes only an annotated `vX.Y.Z` or `vX.Y.Z-rc.N` tag at the current `origin/main` commit in `peanut-business/peanut-cli`. The tag version must equal `@peanut/cli`'s package version and its repository/public package identity. The GitHub-hosted job uses Node `22.23.2`, npm `11.15.0` and `npm run check`.

The job packs a temporary archive of that fixed source, adding only the actual source commit as `package.json.gitHead`. It verifies every declared package file against the source bytes and modes, including `bin/peanut.js` mode `0755`, and records the archive SHA-256, SHA-512 SRI and per-file SHA-256 in `cli-release-source.json`. `gitHead` records source identity; content digests prove the selected bytes, not publisher authentication.

The workflow creates a GitHub Release carrying that exact tarball and source receipt, then downloads both assets and compares their bytes. An existing release must have the same tag, published/prerelease state and exactly matching assets; it is never overwritten. Stable tags create formal releases and `-rc.N` tags create prereleases. Failed or uncertain publication must be inspected before retrying. This workflow does not publish to npm or require npm account credentials; registry publication and trust setup remain a separate future channel decision.

The following is a **fixed historical v0.3.0 example, not a latest-version claim**. For that release, download the fixed official assets, bind the receipt to the annotated tag's commit and verify both SHA-256 and SRI before installing. These commands require Node.js, npm, Git and curl:

```sh
set -euo pipefail
cli_download="$(mktemp -d)"
cli_release='https://github.com/peanut-business/peanut-cli/releases/download/v0.3.0'
curl --fail --location "$cli_release/peanut-cli-0.3.0.tgz" --output "$cli_download/peanut-cli-0.3.0.tgz"
curl --fail --location "$cli_release/cli-release-source.json" --output "$cli_download/cli-release-source.json"
cli_source_commit="$(git ls-remote https://github.com/peanut-business/peanut-cli.git 'refs/tags/v0.3.0^{}' | awk '{print $1}')"
node - "$cli_download" "$cli_source_commit" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const directory = process.argv[2], commit = process.argv[3];
const receipt = JSON.parse(fs.readFileSync(`${directory}/cli-release-source.json`, 'utf8'));
const archive = fs.readFileSync(`${directory}/peanut-cli-0.3.0.tgz`);
if (!/^[a-f0-9]{40}$/.test(commit) || receipt.schema_version !== 1
  || receipt.package !== '@peanut/cli' || receipt.version !== '0.3.0'
  || receipt.repository !== 'https://github.com/peanut-business/peanut-cli.git'
  || receipt.tag !== 'v0.3.0' || receipt.source_commit !== commit
  || receipt.filename !== 'peanut-cli-0.3.0.tgz'
  || receipt.sha256 !== crypto.createHash('sha256').update(archive).digest('hex')
  || receipt.integrity !== `sha512-${crypto.createHash('sha512').update(archive).digest('base64')}`) {
  throw new Error('Official release source or archive digest differs; do not install');
}
console.log(`Verified @peanut/cli@0.3.0 from ${commit}`);
NODE
npm install --global "$cli_download/peanut-cli-0.3.0.tgz"
peanut --version
```

## Branches

- `dev`: development and integration
- `main`: release line

## Optional collaboration service: compatibility boundary

The current CLI wrapper validates only `peanut.collaboration.lifecycle.v1`. That is a **legacy APP protocol**, not the new direct-Compose contract in current Code/Hocuspocus. Do not run these wrapper commands against a new APP that no longer supplies this protocol, and do not weaken result validation to make it appear compatible.

For current Code, use the APP-owned `server/docker/scripts/configure-collaboration.py` contract and the matching Hocuspocus README/Compose configuration. PHP decides identity, tenant membership, owner and read/write permissions; Node executes trustworthy grants, rooms, expiry/revocation, synchronization, saving and draining. Ordinary startup has no global register/activate/deployment-prepare ceremony. A document-save prepare is a different protocol and remains necessary where implemented.

For an existing old APP that actually implements lifecycle.v1, the retained wrapper supports plan/enable/status/disable and requires explicit `--path`. It invokes that APP's ordinary single-link entry through Python with literal argv; it does not read secret files or call Node directly. Legacy enable performs its native preparation only; status without probe is not health. Disable keeps the original drain ID on unknown outcomes and requires the exact protocol-2 durable-drain and native-stop proof. Retaining compatibility commands does not authorize restarting a stopped environment.

Strict keys/types/action/exit consistency, signed and paired readiness, holder binding, failure and unknown behavior remain enforced by the existing validator. A malformed response fails closed. Updating this adapter to the new native contract is a separate implementation task; no new service capability or runtime qualification is claimed here.

</details>
