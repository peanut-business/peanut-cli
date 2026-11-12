# Peanut CLI

Peanut CLI 是独立版本的 `peanut` 命令行工具，负责 Peanut 应用模板、环境配置、诊断、升级、模块工程和 Recipe 管理。

## 1. 安装与工作目录

开发期从 CLI 仓库安装或更新：

```sh
cd /path/to/peanut-cli
npm install -g .
```

正式版通过一个 Tag 向 GitHub Release 与 npm Registry 交付同一固定归档。完成 npm 命名空间首次发布及 OIDC 可信发行者配置后，推荐标准全局安装 `npm install -g @peanut-admin/cli`；**是否已真正上架，以 `npm view @peanut-admin/cli version` 为准，不能用 GitHub Release 成功替代核验**。在 npm 尚未完成接入时，仍从正式 GitHub Release 下载并校验 tarball。已下载 tarball 的安装形式如下，文件名仅作占位：

```sh
npm install -g /path/to/peanut-admin-cli-X.Y.Z.tgz
```

按命令操作对象选择工作目录：`config` 使用选定的 Peanut Admin Code 或生成 APP 根，`release` 使用 Code 根；`doctor`、`status`、`upgrade`、`recipe` 使用对应 APP 或脚手架根；`create` 的第一个参数是新目标目录。支持 `--path` 的命令可用它选择根目录；它自身相对当前目录解析，config/release 的其他路径相对选定项目根解析。临时 worktree 是独立根。普通用户运行已安装的 `peanut`；CLI 内部调用所选项目的 `scripts/project-env`，制包调用 Code 的 `scripts/build-scaffold-release`，不直接运行 CLI 源码仓 `bin/peanut.js`。

CLI 安装和环境配置是首次准备。环境与路径不变时，日常生成脚手架只需 `peanut release`，无需手动 prepare/install/hash。

模板供 `create` / `upgrade` 消费。产品在自己的 Git `dev` 开发，人工审核后定版到 `main` 及 tag；生产采用固定 main 提交，见[产品 Git 交付合同](https://github.com/peanut-business/peanut-admin-code/blob/dev/docs/public/application-release.md)。B 包、`peanut package` 和 `release/apps` 已退役；Recipe 保留独立入口。

创建应用可显式使用 `--demo=workbench` 选择工作台演示数据，默认 `--demo=none`。选择记录在应用manifest与自有配置中，由正常首次安装写入数据；create本身不连接数据库，升级不隐式播种。旧模板不支持该preset时明确拒绝workbench选择。

## 2. 命令速查

```sh
peanut help
peanut --version
peanut doctor --path /absolute/app
peanut status --path /absolute/app
peanut recipe list --path /absolute/app
peanut recipe status app-ci --path /absolute/app
peanut recipe add scaffold-ci --path /absolute/peanut-admin-code
```

| 命令 | 用途 |
| --- | --- |
| `help`, `--version` | 查看命令摘要和 CLI 版本 |
| `config` | 选择已安装工具并保存项目环境配置 |
| `release` | 生成 Standalone、Multi-tenant 脚手架包 |
| `create` | 从官方模板或本地归档创建应用 |
| `upgrade` | 检查、规划、应用或恢复模板升级 |
| `module <operation>` | 使用 APP 已配置的 PHP 执行模块工程与生命周期操作 |
| `doctor`, `status` | 诊断或查看应用状态 |
| `recipe list` | 列出可用 Recipe |
| `recipe status [id]` | 查看全部或指定 Recipe 状态 |
| `recipe add <id>` | 安装指定 Recipe |

### 模块工程：module

```sh
peanut help module
peanut module check --root /absolute/app
peanut module create --help --root /absolute/app
peanut module pack --help --root /absolute/app
peanut module pack peanut.chart --output /absolute/release/modules/peanut.chart-1.0.3.tar --root /absolute/module-app
peanut module install /absolute/release/modules/peanut.chart-1.0.3.tar --sha256 "$REVIEWED_SHA256" --root /absolute/consumer-app
peanut module upgrade /absolute/release/modules/peanut.chart-1.0.3.tar --sha256 "$REVIEWED_SHA256" --root /absolute/consumer-app
peanut module upgrade peanut.file --dry-run --root /absolute/consumer-app
peanut module upgrade peanut.file --version 1.0.47 --root /absolute/consumer-app
peanut module upgrade peanut.file --version 1.0.48-rc.1 --channel prerelease --root /absolute/consumer-app
peanut module install peanut.file --root /absolute/consumer-app
```

公开入口为 `peanut module <operation> [参数] [--root <APP目录>]`，支持 `create`、`check`、`compile`、`pack`、`adopt`、`install`、`upgrade`、`disable`、`uninstall`、`sync`、`reconcile`、`make`、`lock`、`release-composition`、`work`。默认使用当前目录作为 APP 根；`--root` 可用相对或绝对路径，自身相对当前工作目录解析。本地 tar 与其他操作仍只消费 `--root`，其余参数按原顺序交给 APP；`--` 后不再解析 `--root`。各原生操作参数以 `peanut module <operation> --help` 为准；在线参数见 `peanut help module`。

`upgrade|install peanut.<模块名>` 从固定公共仓库 `peanut-opensource/peanut-module-code` 的 GitHub Release 附件获取模块。默认 `--channel stable`，在所有已发布 Release 的索引中独立按模块 SemVer 选择最高兼容稳定版；仓库 Tag 和模块版本可以不同。`--version` 只接受精确版本，精确 RC 也必须显式 `--channel prerelease`；该通道允许稳定版和预发行版。草稿、未发布 Release、原始 HEAD、候选目录、本地 tar 都不会成为在线发现的替代来源。没有已发布附件即报错，不伪称已安装。

在线升级先以固定 SHA 调用原生 `ModuleUpdatePackage --dry-run`，核对目标身份、Edition、宿主能力、依赖和已安装版本，再通过原生受控入口实际升级；指定 `--dry-run` 时只返回原生计划。默认选择只在原生明确报告 Edition、宿主能力或依赖不兼容时尝试下一版；精确版本不回退，任何摘要/身份/运行错误立即停止，不默认或显式降级。在线安装直接使用 `ModuleInstallPackage --dry-run`，成功并核对计划身份后才调用相同 TAR+SHA 的 install；`install --dry-run` 仅返回计划。CLI 不新增依赖求解器、安装器或权限系统；APP 需已有相应原生入口并完成 `peanut config`，具体维护权限仍由 APP 决定。这是已有 APP 的原生模块操作，不是新建薄模板的数据库 bootstrap 前源码准备入口。

发布者需在每个 Release 附带 `module-release-index.json`，唯一生产入口是模块仓的 `scripts/build-module-release-index`。`modules` 必须是数组，一个索引可列出多个模块，每个模块仅一个精确版本。协议如下（摘要、长度与 commit 为形状示例，发布时必须替换为真实值）：

```json
{
  "schema_version": 1,
  "protocol": "peanut.module-release-index.v1",
  "repository": "peanut-opensource/peanut-module-code",
  "tag": "v1.0.0-rc.1",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "modules": [
    {
      "key": "peanut.file",
      "version": "1.0.47",
      "asset": "peanut.file-1.0.47.tar",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "bytes": 12345,
      "license": "Apache-2.0",
      "editions": ["multi-tenant", "standalone"],
      "kernel_constraint": "^1.0",
      "dependencies": [
        { "module_key": "peanut.identity", "version": "^4.0.0-rc.32" },
        { "module_key": "peanut.content-tools", "version": "1.0.1 || 1.0.2" }
      ]
    }
  ]
}
```

CLI 校验 GitHub Release 的官方仓库/API 身份、Tag 页面和附件 `browser_download_url`。索引和 tar 的实际下载字节都必须匹配 GitHub Release API `assets[].digest` 的 `sha256:…`；tar 还必须匹配索引 SHA 和字节长度，不能仅信任索引自述。缺失 digest 即停止。模块 manifest 的 key/version/license/kernel_constraint/dependencies、composer 的 Edition 声明须匹配所选索引项，tar 内 `META-INF/files.sha256` 覆盖及摘要也须一致；完整 schema、版本约束匹配和业务准入由原生入口再次验证。同模块同版本跨 Release 出现不同 SHA 会拒绝，另一版本的 TAR 即使 SHA 相符也不能冒名。同一发行快照的 Tag、固定 commit 和模块版本相互独立；索引 commit 是已验证附件中的来源记录，不用于拉取 HEAD 或执行本地源码。

下载缓存在 APP `.local/module-downloads/<SHA256>/<附件名>`，仅用于保存本次已验证字节。每次命令重新下载并验摘要；单次命令只发现一次 Release 列表，每个索引和候选 tar 下载一次，不轮询或重新解析 Tag。实际原生写入继续使用选定的绝对 tar 路径与 SHA。升级 dry-run 会写下载缓存及原生临时暂存，不写模块产品状态。

S2 与 Code 已交付的原生首次安装预检接口：沿用 stdin JSON `{ "operation": "install", "arguments": ["/absolute/module.tar", "--sha256", "<固定摘要>", "--dry-run"] }`，由 `server/module` 的既有 `ModuleInstallPackage` 入口提供原生只读计划。成功返回退出码 0，采用升级计划已有字段 `schema_version: 1`、`operation: "install"`、`dry_run: true`、`package_key`、`source: null`（尚未安装）及 `target.version/archive_sha256/artifact_sha256/modules`；原生负责先完成包、Edition、Kernel/宿主、依赖、安装状态和迁移身份校验。失败返回非零及 `code/reason/remediation`，`PLUGIN_NOT_INSTALLED` 不作为成功计划。dry-run 只允许可清理暂存，不提升源码、改锁、写安装/授权/迁移状态。CLI 在 Code 接口交付后核对计划身份，再用同一 TAR+SHA 调用 install；CLI 已按 Code 公共合同实际接入该预检，在线 `install --dry-run` 取得并校验官方 TAR 后调用原生安装只读计划，不提升业务产品状态。旧借用升级错误的首次安装准入已退出；实际 DB 安装及浏览器验收仍须另做。

S1 资格须分别记录 CLI 协议测试和真实公开 Release 下载。受控 fetcher 与原生桥模拟只证明 CLI 编排；至少一个真实 GitHub RC 的发现、索引/API 摘要、逐包校验及隔离宿主调用通过后，才能宣称 Gate S1 端到端通过。未核实公开 Release 或 stable 依赖闭包时保留 NOT_RUN/UNKNOWN，不用本地 TAR 或 RC 替代 stable 资格。

### MT 创建与官方组合规划

`create --plan` 从所选模板包内的 `server/config/module_composition.json` 读取版本化 `peanut.application-module-composition.v1` 清单。Code 是唯一产品成员来源；CLI 不维护第二份必选、默认或可选模块表。`standard` 选择 mandatory + default，`minimal` 只选择 mandatory，`--modules` 仅允许清单明确列入 optional 的额外项。必选不会被省略；依赖闭包仍交给 Code 原生检查。

```sh
peanut create /absolute/new-app --name Example --slug example --package example/app \
  --edition multi-tenant --archive /absolute/template.tgz --manifest /absolute/template.json \
  --plan --module-preset standard --module-release "$MODULE_RELEASE_TAG" --module-channel prerelease

# 使用独立索引 SHA 和索引旁的同名 TAR 离线重现；不会联网。
peanut create /absolute/new-app --name Example --slug example --package example/app \
  --edition multi-tenant --archive /absolute/template.tgz --manifest /absolute/template.json \
  --plan --module-preset minimal --module-release "$MODULE_RELEASE_TAG" --module-channel prerelease \
  --module-index /absolute/module-release-index.json --module-index-sha256 "$REVIEWED_INDEX_SHA256"
```

在线核验显式 tag 的已发布不可变 Release、API digest 固定的索引及 catalog TAR；离线核验显式索引、独立 SHA 和同目录 TAR，不声称验证了 GitHub 发行状态。两者保留原始索引字节、commit 和精确制品身份，完整依赖闭包交给 Code。模板与模块渠道独立，RC 须显式选择；离线只接受显式 prerelease。缺少组合清单的旧模板不能规划外置组合。

`--plan` 返回私有 `composition_stage` 与暂存消费者，通过显式 `--module-php /absolute/php` 调用 Code 原生 plan；缺本消费者的 bridge/vendor 时报告精确 blocker 并保留暂存目录。依赖须通过该消费者原生工具准备，不复制其他应用 vendor。重复同一固定参数并加 `--composition-stage` 可继续 plan。审阅后用 `--plan-sha256 <native-sha>` 替换 `--plan`，Code 在原 writer 内复算并比较 hash，原生 `source-prepared` 成功后才提升到目标，返回 `source-created`。错误保留原生退出码、诊断和恢复身份；目标在 plan 或失败时不写入。完整命令、离线约束及恢复见 [MT 组合合同](docs/mt-create-module-planning.md)。当前官方 ST/MT 模板是薄模板，默认不带官方模块源码，modules.lock 为空。需要模块时由模块专用开发应用独立发行，消费者按实际选择和依赖闭包采用；CLI plan 只确认源码范围，不执行依赖/API/模块编译、数据库首装或业务验收。

首次运行先用 `peanut config --path /absolute/app` 配置工具。模块命令通过 APP 的 `scripts/project-env` 选择 PHP，执行内部 `server/module`，以 stdin JSON `{ "operation": "check", "arguments": [] }` 传参；无需 HTTP 或启动站点。APP 的 stdout、stderr 与退出码直接返回，失败不会包装成成功。

模块包默认输出到 APP `.local/toolchain/host.json` 的 `paths.release` 下的 `modules`，未配置发行路径时为 APP `release/modules`；相对发行路径以 APP 根解析。操作支持的显式输出参数由 APP 处理，CLI 不依赖私有工作区路径或 Project 仓库。

## 3. 配置环境：config

```sh
peanut config --path /absolute/peanut-admin-code
peanut config --path /absolute/peanut-admin-code --php /usr/bin/php --node /usr/local/bin/node
peanut config --path /absolute/peanut-admin-code --yes
```

| 参数 | 取值 | 默认或复用 | 作用 |
| --- | --- | --- | --- |
| `--path` | Code 或生成 APP 根目录 | 当前目录 | 选择配置项目；自身相对当前目录解析 |
| `--php`, `--node`, `--npm`, `--pnpm`, `--composer`, `--python` | 已安装工具路径 | 显式参数 > 有效配置 > 自动发现 | 选择本机工具；首次配置 Core 时沿用本项目已选择的工具；已有 Core 配置时保留其已选工具 |
| `--core-php`, `--core-web` | 本地 Core 源码目录（可相对所选项目根） | 显式参数 > 已保存选择（含 `null`）；Code 可邻接发现 | 始终保存绝对路径，固定绑定实际 Core 位置；生成 APP 默认不发现相邻源码仓，使用模板锁定的 Core 依赖；显式选择源码可用于联合开发 |
| `--release`, `--backups` | 路径 | release=`release`；backups 初次=`../backups` | 保存发行输出根和备份位置；已有值继续复用 |
| `--release-database-registry`, `--release-database-resource`, `--release-database-sql` | 绝对登记文件、稳定资源 ID、绝对 `.sql` 文件 | 默认关闭；启用后三项复用 | 可选维护配置，制包前导出开发库快照；登记及 SQL 位于 Code 源码外，SQL 不进入模板 |
| `--no-release-database-backup` | 开关 | 默认保留现有选择 | 清除已保存的数据库备份配置；不删除已有快照 |
| `--pnpm-cache`, `--npm-cache`, `--composer-cache` | 路径 | `.local/toolchain/cache/<tool>` | 设置工具缓存位置 |
| `--extra-path`, `--watch-path` | 路径，可重复 | 未指定时复用已存值 | 显式指定额外搜索目录或观察路径列表 |
| `--yes` | 开关 | 默认预览后询问 | 自动确认写入并执行 prepare；不是只读，也不代替工具选择 |

配置保存在 Code `.local/toolchain/host.json`；Core 各自配置在 `.local/toolchain/cores/<php|web>/host.json`。

生成 APP 同样使用自身 `.local/toolchain/host.json`。存在 `.peanut/application-manifest.json` 时，首次配置不会因目录相邻而绑定 PHP/Web Core 源码；默认继续采用模板锁定的依赖及包内冻结归档。需要源码联合开发时显式传入 `--core-php` / `--core-web`，配置只记录选择并准备工具环境，不自动链接依赖。已保存的选择继续复用，`core.php` / `core.web` 为 `null` 表示不绑定对应源码。

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

输出为“解析后的输出根/<版本>/{standalone,multi-tenant}”；仅当输出根为相对路径时才拼接 Code 根。本地 Core 配置目录不会自动随包携带；前端依赖采用 Core 构建库模式。CLI负责参数、环境调用、输出核对和原子采用；Code既有`prepare-product-release-candidate`负责输入准备、Core冻结/锁投影、依赖与API/inventory生成，`build-scaffold-release`负责Edition封装。环境未变时日常只需`peanut release`，不发布或部署。

可选维护备份保存在私有 `host.json.release_database_backup`（`registry`、`resource_id`、`output`），不依赖任何固定私有仓库路径。启用后，CLI 在默认源码准备或固定 Git 制包之前调用 Code `scripts/export-release-database` 一次，两 Edition 共用该快照；失败即停止。普通开发备份按登记核对数据库、宿主与私有输出目录，并协调真实冲突写入，不要求额外 lease proof。SQL 使用登记远端容器内的原生 mysqldump；旧文件保全后原子替换，旁边 `.sql.json` 记录摘要和来源。SQL 与 receipt 不进入应用模板或发行附件；完整快照可能包含业务秘密，只能在合适的私有备份仓库管理，CLI 不自动提交或推送 Git。`build-scaffold-release --check` 不触发备份。

本次可变工作区位于Code `.local/release/build-*/`，正常结束清理；最终输出同卷暂存仅在输出根短暂使用`.<版本>.stage-*`，覆盖恢复临时使用`.<版本>.previous-*`。本机工具配置仍位于`.local/toolchain`。模板声明统一由Code的`scripts/scaffold-runtime/scaffold.conf.json`登记：源码过滤与交付排除分开，文件映射、归属、profile、既有transform选择及文本替换由Code展开和执行；CLI仅读取其中的`source_snapshot`计算升级本地源码摘要。未登记配置的本地源码输入明确失败，不用CLI内置规则替代。配置原样进入APP受管载荷；既有归档仍按固定manifest、来源证明和原生升级器读取，不改写历史制品。

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
| `--confirm-major-upgrade` | 跨主版本 apply 时必需 | 确认跨主版本或 development→stable 正式来源切换；先审阅计划并获授权 |

`--apply-plan` 与 `--recover-plan` 是真实命令选项；CLI 没有单独的 `--apply` 开关。`--preserve-paths` 与 `--replace-paths` 使用路径列表，空列表写 `-`。

## 7. 诊断、状态与 Recipe

```sh
peanut doctor --path /absolute/app
peanut status --path /absolute/app
peanut recipe list --path /absolute/app
peanut recipe status --path /absolute/app
peanut recipe status app-ci --path /absolute/app
peanut recipe add scaffold-ci --path /absolute/peanut-admin-code
```

| 命令/参数 | 必需/默认 | 说明 |
| --- | --- | --- |
| `doctor`, `status` | `--path` 默认当前目录 | 检查或输出应用/脚手架状态；根目录须含有效应用清单或脚手架 inventory 及版本合同 |
| `recipe list` | `--path` 默认当前目录 | 列出内置可用 Recipe；不接受 id |
| `recipe status [id]` | id 可省略 | 查看全部或指定 Recipe 状态 |
| `recipe add <id>` | id 必需 | 添加 `app-ci` 或 `scaffold-ci`；路径选 APP 或脚手架仓 |

`config --core-php/--core-web` 的参数值是**本地源码目录**，可相对所选 Code 根输入，但配置始终保存绝对路径，以固定绑定实际 Core 位置，避免改变 Code 工作目录后按另一基准解析。`.local` 配置不随 Git 合并，因此新工作区须重新运行 `config`；Code 或 Core 目录位置变化后也须重新运行并提供新的 Core 位置。`release --core-php/--core-web` 的参数值是**已发行版本号**。

<details>
<summary>维护者参考：高级合同、来源校验与固定发行示例</summary>

### config / release 实现合同

- `config` 先预览工具、推荐版本、路径、来源文件和写入对象，再由用户确认；`--yes` 只跳过最终确认，仍写入并调用 Code `scripts/project-env prepare`。它不消解歧义选择。拒绝确认不改文件；未提供新参数时复用有效绑定和路径。
- 配置只登记已安装工具，不安装软件或修改全局 PATH。Core 要求分别来自其 `composer.json` / `package.json`；Core 源码只读，独立 host 与缓存位于 Code `.local/toolchain/cores/php|web/`。Core 首次选择继承主工具已选 scope，既有 Core scope 复用自身绑定。主缓存默认 `.local/toolchain/cache/{pnpm,npm,composer}`，Core 缓存默认 `.local/toolchain/cores/{php,web}/cache/<tool>`。
- 推荐版本差异只告警；manifest/platform 要求和原生锁仍受校验。外部 Composer 绑定本地路径、版本与文件 SHA-256，用于发现本地文件替换，不证明官方来源。
- `release` 对当前磁盘源码快照发行（包含未提交内容），排除 Git 元数据、本地配置、依赖、运行数据和旧输出。Core 版本独立，Web 六包同版；Core 来源与摘要写入清单。默认不携带 Core 归档。
- 固定 Git/CI 流程可用 `--source-commit` 固定源码提交、`--workflow` 选择投影、`--internal-core-inputs` 消费内部候选冻结 Core 回执、`--api-tool-root` 选择 API 工具入口。它们须符合固定候选来源/工作流合同；普通本地发行不使用这些参数，不能用占位 Git 身份替代正式检查。

The current source catalog separates `app-ci@1.0.0` from `scaffold-ci@1.0.0`. APP CI still calls the existing server-only producer with its explicit root; it has not been adapted to the product Git delivery workflow and is not a routine production prerequisite. Scaffold CI calls the same native template producer as `peanut release`, serially for both Editions, and uploads the four fixed template files. These workflows prepare candidates; formal GitHub publication still requires release qualification and authorized CI publication. The CLI repository's own release workflow publishes only CLI artifacts. Source installation does not publish or execute CI.
`peanut create` defaults to the latest official stable GitHub template attachment. `--ref <version>` pins a release; prereleases require explicit `--channel prerelease`. Releases without the paired Edition template attachments fail closed. Local `--archive` and `--manifest` must be absolute and cannot be combined with release/channel selection. Local provenance remains development/local. There is no Git-source or dev fallback, implicit dependency install, database operation or service start.

Template packages require `peanut.template-package.v1` and its complete creation payload. Historical releases without these attachments cannot be consumed by archive creation; updating CLI does not retrofit published assets.

When a developer runs `peanut create` in an interactive terminal without `--edition`, the CLI requires an explicit choice between `multi-tenant` and `standalone`. Machine/CI usage remains fail-closed and must pass `--edition`. There is no implicit Edition default.

Profile and Workflow are fixed by the template. Optional `--profile`/`--workflow` are assertions; mismatches fail. `--application-version` sets the independent APP version; omission uses the template's declared default. Product names accept Unicode and spaces up to 80 UTF-8 bytes; control characters and code/markup delimiters are rejected.

The two Editions are separate deliverables and deployments. `standalone` produces the single-tenant projection and omits the Platform bundle; `multi-tenant` produces the Platform/tenant-management projection. Their runtime directories, configuration and deployment identities must not be mixed, and normal APP/scaffold upgrades remain within the recorded Edition rather than changing Edition as a side effect.

Creating a template or APP does not establish runtime, upgrade or production qualification. Record verification against the actual selected source and Edition; reuse evidence only when its inputs and behavior remain applicable. Existing APP directories, installation identities and data remain intact. This public CLI contract does not require access to maintainer environments or authorize test runs.

Creation validates package/file digests, fixed source, Edition, member uniqueness, regular-file types, size and path boundaries before staging. It records package provenance and rebuilds final file/tree hashes and managed baselines while retaining app-owned defaults. Official Module contents remain fixed; APP branding changes host identity. Composer content-hash and API input hashes use final bytes without dependency resolution. An absent or strictly empty target is accepted; hidden files, `.git`, any other content and symlink path components are refused. Failure removes only the unadopted staging tree.

## Development APP upstream upgrades

`peanut upgrade` selects the same versioned template format used by `create`, from exact official GitHub release attachments or an explicit local archive/manifest pair. It validates and caches the complete fixed archive before calling its native `scripts/scaffold-upgrade`; CLI implements transport and binding, while the PHP runner owns baseline comparison, conflicts, apply, verification, journal and recovery. PHP is required for planning/apply/recovery. Composer, Python and an extra prepare command are unnecessary. A source checkout is needed only for the explicit development successor proof described below. Upgrade tooling dependencies are sealed separately inside the template; they are never installed into the APP by this command.

```sh
peanut upgrade --check --path /absolute/app
peanut upgrade --plan --ref 5.0.2 --path /absolute/app
peanut upgrade --plan --archive /absolute/template.tgz --manifest /absolute/template.json \
  --baseline-mode-manifest /absolute/exact-original-release.json --path /absolute/app
```

Discovery defaults to stable releases within the APP's existing major and Edition. Prereleases and cross-major versions require explicit selection. Local packages record development plus the exact archive identity; official acquisition provenance is recorded independently of the template producer's original source channel. Unknown official source identity, ahead/diverged development sources, downgrades and equal-version official source changes are refused. A content-equivalent development-to-official adoption still needs the native comparison of every recorded baseline byte and mode. Old APP manifests without `baseline_mode` need the exact original release manifest as mode evidence; live file modes are never substituted for missing baseline modes.

A recorded local development baseline can select a newer official release without inventing Git ancestry or changing the old source identity. Discovery reports `recorded_local_baseline` with unknown content equivalence; the official template's native runner must validate the APP's retained baseline bytes and modes, then classify customized files and Module boundaries in the normal three-way plan. This path does not use `--source-checkout` or a development intermediate package. Equal-version local-to-official adoption remains refused until its content equivalence can be established.

An explicitly selected local **snapshot** archive can also upgrade an APP recorded against an official stable/prerelease Git baseline. CLI and the native runner validate that baseline's repository, version/ref/channel and identity, then bind the target's complete snapshot, payload, Edition, profile and Workflow proof to the normal plan. This is a development adoption, never an official release or a claim of Git ancestry. Downgrades remain refused; retained baseline bytes/modes, conflict choices, apply verification and recovery are unchanged. No manifest editing or intermediate APP is required. A source checkout is unnecessary for a sealed snapshot archive; when explicitly supplied, its digest must match the target.

For an explicitly selected Git-backed development package at the current or a newer template version, add `--source-checkout /absolute/peanut-admin-code` to `--check` or `--plan`. Both current and target sources must be development identities; the target producer ref must be its exact commit. CLI reads immutable Git objects from that checkout and verifies its official origin, both commit/tree/inventory/Edition-profile identities, the APP's current recorded base and Edition, each profile's declaration in its source inventory, the declared Workflow, and that the current commit is an ancestor of or equal to the target. A matching Code source is up to date only when the recorded template archive digest also matches: the archive fixes the complete Code, PHP Core and Web Core projection. A Core-only change can therefore enter the same native three-way plan without manufacturing a Code commit. Applying records the selected package digest for the next comparison. The APP's retained profile is its own identity; an explicitly selected `full` template does not rename a `standard` APP or add a missing Workflow identity field. It rejects shallow or grafted history, missing objects, unknown identities and divergent or older sources before writing any APP cache or plan. It does not fetch, edit the checkout or require its working tree to match the fixed target. CLI forwards the canonical checkout to native `template-plan` and requires its returned source relation and exact five-field development context: `profile`, `workflow`, `workflow_present`, `workflow_paths_sha256` and `excluded_paths_sha256`. An explicit Workflow value must match the APP; an absent field stays absent while native proves the selected target Workflow against the recorded baseline and fixed base inventory. The presence bool and baseline-path digest remain distinct from the selected value. A template without this native proof remains refused; CLI does not issue an internal-preinstall or runtime context to bypass it. Normal archive checks and native conflict, protection, backup and recovery gates still apply. The native proof and checkout are saved with the engine binding and retained through conflict resolution. Saved apply, verify and recovery reuse that fixed selection and require the same checkout to remain available for native proof revalidation; they do not rediscover a source. This option does not permit a different source at the same official release version.

The default command creates an immutable plan and returns its path. A conflict returns `blocked` without applying managed changes. Review every conflict and explicitly preserve or replace each path; use `-` for an empty decision list:

```sh
peanut upgrade --apply-plan .peanut/upgrades/plans/<candidate>.json \
  --confirm-plan-sha256 sha256:<plan-digest> \
  --preserve-paths path/to/customized-file --replace-paths - --path /absolute/app
```

A ready plan uses `peanut upgrade --apply-plan <plan> --path /absolute/app`. Cross-major and development-to-official transitions additionally require `--confirm-major-upgrade` under the existing human authorization boundary. An AI/Agent must explain the versions and risk and obtain authorization for that scope; prior explicit authorization is sufficient. Neither a ref nor conflict choices replace that authorization. Saved apply and recovery reuse the bound archive, source, engine and plan; they never discover latest again. Altered engine/tooling files, undeclared execution inputs, symlinks and changed plan bindings are rejected.

After a failed apply, inspect the native journal and use `peanut upgrade --recover-plan <plan> --path /absolute/app`. This restores source only. Source upgrades do not install APP dependencies, build clients, run migrations, start services or deploy production. Prepare the APP runtime according to changed locks and affected clients; product Git versioning and production adoption are separate stages.

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

A checkout can be installed locally for CLI testing with `npm install -g .`. The team development policy is to use the newest approved CLI build from `dev`. Public distribution uses the same fixed tarball in GitHub Release and npm Registry, after the one-time npm bootstrap and OIDC binding are completed. `npm install -g @peanut-admin/cli` is supported only after the target version is confirmed in npm Registry; an unqualified development checkout is never a formal release.

## Public release contract

`.github/workflows/release.yml` publishes only an annotated `vX.Y.Z` or `vX.Y.Z-rc.N` tag at the current `origin/main` commit in `peanut-business/peanut-cli`. The tag version must equal `@peanut-admin/cli`'s package version and its repository/public package identity. The GitHub-hosted job uses Node `22.23.2`, npm `11.15.0` and `npm run check`.

The job packs a temporary archive of that fixed source, adding only the actual source commit as `package.json.gitHead`. It verifies every declared package file against the source bytes and modes, including `bin/peanut.js` mode `0755`, and records the archive SHA-256, SHA-512 SRI and per-file SHA-256 in `cli-release-source.json`. `gitHead` records source identity; content digests prove the selected bytes, not publisher authentication.

The workflow creates a GitHub Release carrying that exact tarball and source receipt, then downloads both assets and compares their bytes. An existing release must have the same tag, published/prerelease state and exactly matching assets; it is never overwritten. Stable tags create formal releases and `-rc.N` tags create prereleases. The next step publishes **that identical tarball** to npm Registry using GitHub Actions OIDC (`id-token: write`), without a long-lived npm publish token. Existing registry versions are accepted only when the package name, exact version and SHA-512 integrity match the GitHub archive; a differing immutable version fails instead of being overwritten. Stable versions use npm dist-tag `latest`, prereleases use `rc`. The GitHub Release may exist when the npm step fails; do not mark the entire release successful in this case. Inspect registry and the original workflow run before rerunning the same tag.

### 当前 npm 与 GitHub 发行合同

CLI 的唯一公开包名是 @peanut-admin/cli，GitHub 源仓为 peanut-business/peanut-cli。2026-11-12 已从 npm Registry 直接核实 latest=0.3.4、rc=0.3.4-rc.1；安装前仍应以实际 npm view 输出为准：

    npm view @peanut-admin/cli version dist-tags --json
    npm install -g @peanut-admin/cli

CLI 与 Code 脚手架、Core、模块和业务 APP 各自独立版本；不能用 CLI 发布替代应用首次安装、模块采用或项目升级。CLI 发行使用已登记的 GitHub 工作流 release.yml 与可信 npm OIDC 发行者。仅当前 npm 包名、同一固定发布归档、tag/源提交、GitHub Release 与 npm 实际 tarball/SRI 均核验通过，才算 CLI 两渠道完成。

以前 v0.3.3 的旧包名 @peanut/cli 和首次 npm 命名空间引导操作是历史记录，只在 Git 历史或旧发行回执里追溯，不是现在需要重复执行的日常步骤。不要再次手工 npm bootstrap、设置 Token、重发未改变版本或把旧包名复活。若发行失败，先查原 GitHub run/npm 公开对象及 OIDC 状态，只恢复缺失的一环；版本身份和摘要不一致时拒绝发布。

## Branches

- `dev`: development and integration
- `main`: release line

## Optional collaboration service: compatibility boundary

The current CLI wrapper validates only `peanut.collaboration.lifecycle.v1`. That is a **legacy APP protocol**, not the new direct-Compose contract in current Code/Hocuspocus. Do not run these wrapper commands against a new APP that no longer supplies this protocol, and do not weaken result validation to make it appear compatible.

For current Code, use the APP-owned `server/docker/scripts/configure-collaboration.py` contract and the matching Hocuspocus README/Compose configuration. PHP decides identity, tenant membership, owner and read/write permissions; Node executes trustworthy grants, rooms, expiry/revocation, synchronization, saving and draining. Ordinary startup has no global register/activate/deployment-prepare ceremony. A document-save prepare is a different protocol and remains necessary where implemented.

For an existing old APP that actually implements lifecycle.v1, the retained wrapper supports plan/enable/status/disable and requires explicit `--path`. It invokes that APP's ordinary single-link entry through Python with literal argv; it does not read secret files or call Node directly. Legacy enable performs its native preparation only; status without probe is not health. Disable keeps the original drain ID on unknown outcomes and requires the exact protocol-2 durable-drain and native-stop proof. Retaining compatibility commands does not authorize restarting a stopped environment.

Strict keys/types/action/exit consistency, signed and paired readiness, holder binding, failure and unknown behavior remain enforced by the existing validator. A malformed response fails closed. Updating this adapter to the new native contract is a separate implementation task; no new service capability or runtime qualification is claimed here.

</details>
