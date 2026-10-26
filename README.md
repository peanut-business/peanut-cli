# Peanut CLI

Independent developer CLI and tooling for Peanut products.

Peanut CLI is the source of truth for the global `peanut` command. It is independently versioned from Peanut Admin, PHP Core, Web Core, downstream applications, and Recipes.

## Current development line

The current development source implements archive-based creation and native release/package entries. These changes are not claimed as a published CLI version until a release receipt exists.

```sh
peanut --version
peanut config --path <project-root>
peanut create /absolute/new-app --name "Business App" --slug business-app --package example/business-app --edition standalone
peanut create /absolute/new-app --name "Business App" --slug business-app --package example/business-app --edition standalone --archive /absolute/peanut-scaffold-standalone.tgz --manifest /absolute/peanut-scaffold-standalone.json
peanut release [--path <scaffold>] [--version <semver>] [--core-php <version>] [--core-web <version>] [--with-local-core] [--output <path>] [--overwrite]
peanut package --path /absolute/app --output /absolute/new-server-package
peanut doctor [--path <application>]
peanut status [--path <application>]
peanut upgrade --check [--path <application>]
peanut upgrade --plan [--ref <version-or-tag>] [--path <application>]
peanut upgrade [--ref <version-or-tag>] [--path <application>]
peanut recipe list [--path <application>]
peanut recipe status [<id>] [--path <application>]
peanut recipe add app-ci --path <application>
peanut recipe add scaffold-ci --path <scaffold>
```

The current source catalog separates `app-ci@1.0.0` from `scaffold-ci@1.0.0`. APP CI calls the APP's existing server-only producer with its explicit root. Scaffold CI calls the same native template producer as `peanut release`, serially for both Editions, and uploads the four fixed template files. These workflows prepare candidates; formal GitHub publication still requires the release qualification and authorized CI publication path. The CLI repository's own release workflow publishes only CLI artifacts. Source installation does not publish or execute CI.
`peanut create` defaults to the latest official stable GitHub template attachment. `--ref <version>` pins a release; prereleases require explicit `--channel prerelease`. Releases without the paired Edition template attachments fail closed. Local `--archive` and `--manifest` must be absolute and cannot be combined with release/channel selection. Local provenance remains development/local. There is no Git-source or dev fallback, implicit dependency install, database operation or service start.

Template packages require `peanut.template-package.v1` and its complete creation payload. Historical releases without these attachments cannot be consumed by archive creation; updating CLI does not retrofit published assets.

When a developer runs `peanut create` in an interactive terminal without `--edition`, the CLI requires an explicit choice between `multi-tenant` and `standalone`. Machine/CI usage remains fail-closed and must pass `--edition`. There is no implicit Edition default.

Profile and Workflow are fixed by the template. Optional `--profile`/`--workflow` are assertions; mismatches fail. `--application-version` sets the independent APP version; omission uses the template's declared default. Product names accept Unicode and spaces up to 80 UTF-8 bytes; control characters and code/markup delimiters are rejected.

The two Editions are separate deliverables and deployments. `standalone` produces the single-tenant projection and omits the Platform bundle; `multi-tenant` produces the Platform/tenant-management projection. Their runtime directories, configuration and deployment identities must not be mixed, and normal APP/scaffold upgrades remain within the recorded Edition rather than changing Edition as a side effect.

For product validation, shared code and the common lifecycle do not need two identical full test runs. Use the maintainer's two registered permanent APPs for post-package validation; do not create a new test APP per attempt. Shared lifecycle evidence may be reused only for unchanged inputs and genuinely shared behavior. Multi-tenant should be the primary broad functional/regression target because it includes the additional Platform, tenant-management, Host and tenant-switching surfaces. The other Edition still requires its Edition projection checks and critical create/install/start/login/deploy/upgrade smoke path. Edition-specific behavior must be tested in the Edition that owns it.

Creation validates package/file digests, fixed source, Edition, member uniqueness, regular-file types, size and path boundaries before staging. It records package provenance and rebuilds final file/tree hashes and managed baselines while retaining app-owned defaults. Official Module contents remain fixed; APP branding changes host identity. Composer content-hash and API input hashes use final bytes without dependency resolution. An absent or strictly empty target is accepted; hidden files, `.git`, any other content and symlink path components are refused. Failure removes only the unadopted staging tree.

### Explicit implementation boundary

`peanut config` first previews all selected tools, recommendations, paths, source files, and files/directories it will write. It saves only after explicit confirmation; use `--yes` after reviewing the preview for noninteractive execution. Declining leaves the filesystem unchanged. It writes installed tool bindings and release/backups/Core locations to the selected Code project's ignored `.local/toolchain/host.json`. Relative paths use the selected Code root; absolute paths are also accepted. PHP/Web Core requirements come from each Core's `composer.json` or `package.json`; their independent bindings and caches stay in Code `.local/toolchain/cores/php|web/host.json`, and Core source directories remain read-only. Recommended version differences are warnings; manifest/platform requirements and native lock behavior remain enforced. A selected external Composer is bound locally by its path, version and file SHA-256; this digest detects local file replacement and is not proof of official origin. Config does not install software or alter global PATH. After confirmation it creates configured cache directories and calls the existing Code `scripts/project-env prepare` entry.

`peanut help config`, `peanut config --help`, `peanut help release` and `peanut release --help` display the full Chinese option descriptions, defaults and path rules. Config supports `--path`, per-tool executable selectors (`--php`, `--node`, `--npm`, `--pnpm`, `--composer`, `--python`), `--core-php`/`--core-web` checkout paths, `--release`/`--backups`, per-manager cache paths, repeatable `--extra-path`/`--watch-path` values, and `--yes` confirmation after preview. Tool selection follows explicit options, valid saved host bindings, then automatic discovery; an unchanged configuration reuses its saved tool and path settings without asking again. Main cache defaults are `.local/toolchain/cache/{pnpm,npm,composer}`; Core cache defaults are `.local/toolchain/cores/{php,web}/cache/<tool>`.

`peanut release` runs each Edition through the selected project environment and the Code checkout's native `scripts/build-scaffold-release`. It snapshots current disk source, including dirty and uncommitted files, while excluding Git metadata, local configuration, dependencies, runtime data and prior outputs. The default output is `release/<scaffold-version>/{standalone,multi-tenant}`. `--version` must match `release-versions.json.scaffold_template`; versions are never bumped automatically. Existing version output is refused unless `--overwrite` is explicit; unknown files block overwrite. Relative `--path` and `--output` values use the selected project root. PHP Core and Web Core versions are independent; the Web Core six packages share one version. `package` delegates to the APP's own `scripts/package-release.sh --server-only`. Neither command publishes or deploys.

Fixed Git/CI workflows retain their explicit advanced options: `--source-commit` pins the real source commit; `--workflow` selects the fixed projection; `--internal-core-inputs` consumes the frozen Core receipt for an internal candidate; `--api-tool-root` selects the prepared API generator checkout. These are not required for a normal local release. The frozen receipt must match its fixed source and workflow; package mode does not accept release-only options. No option substitutes a placeholder Git identity or changes the fixed formal release checks.


`package` reports success only after the native producer exits successfully and its output directory, server identity, archive and paired archive manifest exist and match the selected APP, committed source and recorded digests. A missing or inconsistent output remains a failed command even if an older native script exits zero prematurely.

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
