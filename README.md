# Peanut CLI

Independent developer CLI and tooling for Peanut products.

Peanut CLI is the source of truth for the global `peanut` command. It is independently versioned from Peanut Admin, PHP Core, Web Core, downstream applications, and Recipes.

## Current development line

CLI `0.3.2` implements project creation and native development APP upstream upgrades:

```sh
peanut --version
peanut create <target> --name <name> --slug <slug> --package <vendor/name> [--edition standalone|multi-tenant]
peanut doctor [--path <application>]
peanut status [--path <application>]
peanut upgrade --check [--path <application>]
peanut upgrade --plan [--ref <version-or-tag>] [--path <application>]
peanut upgrade [--ref <version-or-tag>] [--path <application>]
peanut recipe list [--path <application>]
peanut recipe status [<id>] [--path <application>]
peanut recipe add github-ci [--path <application>]
```

`github-ci@1.0.0` remains the active default Recipe.
`peanut create` defaults to the public `peanut-business/peanut-admin-code` repository at the latest `dev` ref for normal team development. Use `--ref <tag-or-commit>` when a project must be reproduced from an exact source revision; `--source <git-url-or-path>` selects an explicitly compatible source.

When a developer runs `peanut create` in an interactive terminal without `--edition`, the CLI requires an explicit choice between `multi-tenant` and `standalone`. Machine/CI usage remains fail-closed and must pass `--edition`. There is no implicit Edition default.

The two Editions are separate deliverables and deployments. `standalone` produces the single-tenant projection and omits the Platform bundle; `multi-tenant` produces the Platform/tenant-management projection. Their runtime directories, configuration and deployment identities must not be mixed, and normal APP/scaffold upgrades remain within the recorded Edition rather than changing Edition as a side effect.

For product validation, shared code and the common lifecycle do not need two identical full test runs. A complete lifecycle can be proven with one Edition; the current permanent `peanut-app` may remain the Standalone lifecycle instance. Multi-tenant should be the primary broad functional/regression target because it includes the additional Platform, tenant-management, Host and tenant-switching surfaces. The other Edition still requires its Edition projection checks and critical create/install/start/login/deploy/upgrade smoke path. Edition-specific behavior must be tested in the Edition that owns it.

Creation is fail-closed: it stages the application first, verifies the native `create-app` result, and only then moves the application into the requested target. The result records the selected repository, ref, commit, and tree. A failed creation does not leave the requested target behind.

## Development APP upstream upgrades

`peanut upgrade` absorbs a published Peanut Admin/scaffold release into a downstream development APP. It uses `scripts/scaffold-upgrade` from the selected public Code source, fixed to the published tag and authenticated commit/tree/inventory SHA for package authentication, baseline, three-way differences, ownership, conflict resolution, apply, verify, journal and recovery. CLI does not implement another upgrade engine. This command requires PHP, Composer and Python 3 (safe archive extraction). On first use, CLI installs the selected engine's production dependencies from its committed Composer lock, with scripts and plugins disabled and isolated Composer configuration. It does not install or copy the APP's dependencies.

The default channel is `prerelease` for an APP using a prerelease scaffold, otherwise `stable`. `--channel stable|prerelease` selects explicitly; prerelease includes stable releases. Automatic discovery considers published releases in the current major version from the public `peanut-business/peanut-admin-code` repository. `--ref 4.0.0-rc.19` and `--ref v4.0.0-rc.19` select the same published tag. An explicit `--ref` may select a published cross-major release only when its Edition upgrade manifest declares a valid `source-range` containing the installed version; the old `same-major` policy continues to require one major version throughout its source range and target. Mutable branches, unreleased commits, downgrades and unsupported source ranges are rejected. Existing published artifacts retain their original compatibility policy; this CLI capability does not imply that a 4→5 release is available today.

`--check` reads release metadata without writing APP files or upgrade state. Its result identifies the repository, tag, channel, source commit/tree, Edition asset, compatibility and SHA-256. A cross-major result includes `risk` and `human_confirmation_required: true`. It reports availability, not successful package authentication or conflict readiness. `--plan` downloads the Edition upgrade package, verifies archive size/SHA and external manifest/inventory/source identity, checks the fixed source checkout's tracked bytes and prepares its locked engine dependencies, then asks that source engine to authenticate the package and persist its immutable plan and journal. It also reports the cross-major risk and saves the plan without applying it, even if `--confirm-major-upgrade` was supplied. Packages stay in `.peanut/upgrades/packages/<archive-sha256>/` so saved plans and recovery retain their source inputs. The fixed source is retained in `.peanut/upgrades/engines/<commit>/`, and `peanut.cli-upgrade-engine-binding.v1` receipts bind each saved native plan's file digest and native digest to that same selection. Dependency receipts in `.peanut/upgrades/engine-dependencies/<commit>.json` bind the Composer manifest/lock digests, exact installed package identities and dependency file inventory after the first locked installation. This local binding detects subsequent dependency changes; it is an integrity record, not publisher authentication of dependency bytes. Every native invocation rechecks the committed source bytes, rejects extra files outside `server/vendor`, symlinks and hardlinks, and verifies that dependency inventory. Changed or unbound dependencies fail closed. Resolve, apply and recovery retain the same engine and bindings. Old APPs without an installed upgrader use this same selected source engine and its own autoload. The cache is ignored APP upgrade state and is excluded from committed APP release inputs. Existing packages are rechecked; the native engine reauthenticates inventory and baseline. The public release and its external manifest are the selected source of trust; no private keys or signatures are required.

An equal-version APP checks its recorded template source commit/tree against the public release manifest and SHA-bound candidate lock, without requiring an upgrade archive. It reports `up_to_date` only when both identities align, `source_identity_mismatch` when a recorded identity differs, or `version_current` with unknown source alignment when identity is absent. Equality never triggers apply or silently relabels the installed source. The first public baseline (rc18) has installer assets only; subsequent upgradeable releases must publish both Edition upgrade archives and their external manifests. Missing upgrade assets fail closed and installer archives are never substituted.

The default command plans, applies only a ready plan, and verifies through the native engine. Every cross-major apply, including default `peanut upgrade` and `--apply-plan` for a saved plan, additionally requires the Boolean `--confirm-major-upgrade` flag. Without it, a ready plan returns `confirmation_required`, the bound plan path, a next command and exit code 1 without applying. The binding checks the native plan's original `identity.from.version` against the receipt's `selection.current_version`, so a partly applied APP whose manifest now names the target cannot bypass the gate. `--recover-plan` remains available without this flag after its existing binding checks. Neither `--ref`, `--confirm-plan-sha256`, nor conflict choices authorize a cross-major apply. The CLI cannot tell whether a person authorized an AI or Agent: before passing `--confirm-major-upgrade`, the operator must explain the source and target versions, potential API, business behavior, dependency and migration breakage, the native plan and recoverable backup, and obtain human authorization for this upgrade or a clearly defined cross-major scope. Generic development authorization is insufficient. Resolve known risks before attempting apply. APP identity/version, downstream code, modules, pages, configuration, secrets and data are protected by its ownership contract. A conflicting plan returns `blocked` and exit code 1 without applying managed changes. Review all native actions, then explicitly preserve or replace every managed conflict:

```sh
peanut upgrade --apply-plan .peanut/upgrades/plans/<candidate>.json \
  --confirm-plan-sha256 sha256:<plan-digest> \
  --preserve-paths path/to/customized-file --replace-paths -
```

Use `-` for an empty decision list. Missing, overlapping or stale decisions are rejected by the native engine. To apply a reviewed ready plan, use `peanut upgrade --apply-plan <plan>` and add `--confirm-major-upgrade` for an authorized cross-major apply. After a failed apply, review the native journal before `peanut upgrade --recover-plan <plan>`; CLI retains package/plan/recovery state and does not automatically discard or replay it. Native JSON responses must have empty stderr and exit 0; only a blocked native preflight uses exit 2. A native error cannot be accepted as a successful plan, apply or recovery. Blocked conflicts, major confirmation required and same-version source mismatch exit 1; invalid inputs/download/native failures exit 2. Successful check/plan/apply/recovery exits 0.

This is a development source operation. It prepares only the selected engine's locked dependencies; it does not start servers, install APP dependencies, run builds, execute database migrations, switch production containers or deploy. Follow the APP's normal local dependency, migration and startup workflow after absorbing upstream changes. Production lifecycle follows the distribution's deployment contract: full-source instances use the distinct installed `scripts/upgrade` coordinator; server-only distributions use their `update.sh` deployment workflow.

 `github-ci@1.1.0` is carried as an inactive candidate and is not selected by the catalog.

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

For the published `v0.3.0` release, download the fixed official assets, bind the receipt to the annotated tag's commit and verify both SHA-256 and SRI before installing. These commands require Node.js, npm, Git and curl:

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
