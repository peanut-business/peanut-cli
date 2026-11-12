# MT create and native source composition

CLI selects and verifies inputs, stages an uninstalled MT consumer, and calls the template's `server/module` JSON bridge. Code alone resolves dependencies and promotes module source and `modules.lock`. There is no CLI resolver, installer, database bootstrap or implicit switch to another release. ST composition is deferred. Ordinary create without composition options retains its existing template rendering behavior.

## Fixed inputs

The template inventory must include `server/config/module_composition.json`, covered by its archive/file digests. This `peanut.application-module-composition.v1` manifest owns mandatory, default and optional roots. `minimal` selects mandatory; `standard` adds default; `--modules` accepts only explicitly declared optional roots. An older manifest missing optional remains blocked. CLI ships no product membership list.

`--module-release` names one exact tag independently of template ref/channel. Online input uses the official module repository's published, immutable GitHub Release, API asset digests and original `peanut.module-release-index.v1` bytes. Every catalog TAR is downloaded through the existing module transport and checked against both the independent API digest and index digest/length, canonical inventory and package identity/metadata. The full catalog is a source hint; Code selects the actual closure. Code verifies ranges, cycles, retained versions, full package contracts, host/Core/Edition compatibility, migration and path ownership.

Offline input requires `--module-index /absolute/module-release-index.json`, an independently reviewed `--module-index-sha256`, explicit `--module-channel prerelease`, and TAR files with their exact indexed asset names beside the index. This proves bytes and index identity, not GitHub publication or immutability. Stable channel rejects prerelease roots and prerelease modules in the native closure.

## Plan, review, prepare

Run create with all existing application/template arguments plus:

```sh
--edition multi-tenant --plan --module-release v1.0.0-rc.2 --module-channel prerelease \
--module-php /absolute/selected/php
```

The result returns `composition_stage`, `staged_application`, original index SHA, template/source identity and `composition_request`. The private stage lives beside the target on the same filesystem. It contains the rendered application, verified archives, original index, request and native result. The target remains absent or empty. Planning writes no module source transaction, module lock or database state. The staged server environment is an owner-only ordinary file with explicit `APP_ENV=development` and `DEPLOYMENT_MODE=multi-tenant`.

The request is Code's `peanut.module-source-composition-request.v1`, sent as stdin `{"operation":"adopt","arguments":["--composition","/absolute/composition.json"]}`. `composition_sha256` binds the template's exact config bytes; index path/SHA/repository/tag/commit bind the unchanged downloaded index; `archives` maps every supplied catalog key to its verified TAR. Code uses its safe source-only bootstrap, without AppService, business Module or database initialization.

The template must supply the native bridge and the staged consumer must own its native PHP dependencies. Missing `server/module`, `server/vendor/autoload.php` or the framework helper returns `CODE_NATIVE_DEPENDENCIES_REQUIRED` with exact missing paths. Prepare this consumer using its documented native locked dependency tools; CLI neither copies another application's vendor nor invents a dependency preparation entry. Choose PHP explicitly with `--module-php`. Native autoload/compatibility errors retain exit code, stderr and native diagnostics. Missing native dependencies never return ready.

After preparing dependencies, repeat the same fixed create arguments and add `--composition-stage <returned-stage>` to plan on that consumer. A stage cannot be reused for another target, template, application identity, source index, provenance, preset or optional selection. Cached archives are reverified; Code revalidates the actual current consumer state.

Only native `ready` with matching identity yields CLI `ready` and a `plan_sha256`. Review the returned native plan, full closure, versions, file/lock writes, migrations, diagnostics and pending actions. Repeat the fixed arguments with the returned stage and replace `--plan` with:

```sh
--composition-stage /absolute/returned-stage --plan-sha256 <reviewed-native-plan-sha>
```

CLI requires the saved ready plan; Code recomputes it inside the original writer lock and compares the reviewed hash. Only a successful native `source-prepared` response with the same hash and completed recovery state permits the staged application to be renamed to the still-empty target. CLI returns `source-created`, retaining the native transaction/receipt. This means source adoption only: dependencies, registry/API/client compilation, database first installation, activation, tenant enablement and RBAC remain separate native operations.

## Recovery and limits

All blocked/error paths retain the original stage. `native-result.json` records the exact exit, stderr, parsed response and recovery handle. An unparseable/unknown response is saved in `native-output.json`; inspect its existing journal before resubmitting anything. Native nonzero exits retain `error`, diagnostics, transaction, completed writes, journal and `adopt --recover` arguments. Run that recovery through the same staged consumer's `server/module`, not another install or a fresh stage. Then re-plan and review the resulting current state before promotion. Do not delete a failed stage or its before-images.

Current Code templates still include eight official modules and their native dependency inputs. `template_bundled_modules` reports the actual inventory count. This integration does not remove them or establish a thin template. A conflict between bundled sources and selected release bytes is a real native blocker; it must not be bypassed by deleting sources or rewriting locks. Uninstalled native dependency/API/compile orchestration and real MT first-install/HTTP acceptance remain separate work. No archived ST/MT applications, business instances, databases or production resources are operated by this command.

Tests distinguish CLI protocol stand-ins from the real Code native composition test. Neither proves public Release consumption by a fresh consumer with its own installed dependencies or real database/HTTP acceptance. Exact execution results and fixed inputs are recorded in the S3.2 result receipt.
