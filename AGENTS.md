# peanut-cli

**最高研发基准条款：Core 提供底层依赖、Scaffold 提供通用底座、Module 应用开发并发行共用能力、业务应用基于脚手架安装模块后实现业务。**

CLI 是跨四层的独立版本编排/入口工具，不是新的业务实现层，不维护共用 Module 功能或 APP 行业规则。后续本仓规则不得与该分工冲突；仅在实际输入及授权允许时执行对应层的创建、安装、升级或发行，禁止因单个 Module 变更重制 Scaffold 或 Core。

Peanut CLI is an independent public product line. It owns the global `peanut` command, CLI UX, local diagnostics, Peanut product discovery/orchestration, and versioned optional Recipes.

## Boundaries

- Do not depend on the private `peanut-admin-project` repository at runtime or package time.
- Do not import implementation source from `peanut-admin-code`, PHP Core, or Web Core. Shared behavior must be expressed through stable public files/protocols or independent protocol validators with compatibility tests.
- Peanut Admin and both Core repositories never import CLI implementation code.
- CLI versions are independent from Peanut Admin, scaffold, Core, downstream APP, and Recipe versions.
- Recipes have independent version identity and baseline. Installing or updating a Recipe must not silently claim or overwrite downstream-owned files.
- Do not expose placeholder success for unimplemented `create`, `upgrade`, remote download, release, or publish flows.

## Git and release

- `dev` is the development/integration branch.
- `main` is the release branch.
- Never force-push or rewrite shared history.
- Tags, GitHub Releases, npm publication, deployment, and package-signing are separate publication effects.
