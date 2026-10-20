# Peanut CLI

Independent developer CLI and tooling for Peanut products.

Peanut CLI is the source of truth for the global `peanut` command. It is independently versioned from Peanut Admin, PHP Core, Web Core, downstream applications, and Recipes.

## Current development line

CLI `0.3.2` implements project creation and native development APP upstream upgrades:

```sh
peanut --version
peanut create <target> --name <name> --slug <slug> --package <vendor/name> [--edition standalone|multi-tenant] [--workflow none|runtime|full] [--channel development|stable|prerelease] [--ref <git-ref-or-published-tag>]
peanut doctor [--path <application>]
peanut status [--path <application>]
peanut upgrade --check [--path <application>]
peanut upgrade --plan [--ref <version-or-tag>] [--path <application>]
peanut upgrade [--ref <version-or-tag>] [--path <application>]
peanut recipe list [--path <application>]
peanut recipe status [<id>] [--path <application>]
peanut recipe add github-ci [--path <application>]
```

The current source catalog selects `github-ci@1.0.1` for **new** Recipe installs. It passes the real APP root and explicit `--server-only` to the existing package engine; 1.0.0 and the inactive 1.1.0 source snapshots remain unchanged. Installing this CLI source does not publish it, upgrade an already installed Recipe, or run CI.
`peanut create` defaults to the public `peanut-business/peanut-admin-code` repository, `dev` ref and `development` channel. Use `--ref <tag-or-commit>` to pin a development source; `--source <git-url-or-path>` selects a compatible custom development source. `--channel stable` chooses the latest published stable release unless `--ref` selects a specific published version. `--channel prerelease` chooses the highest published version, including stable versions, unless pinned. Formal channels require the official repository and verify the published Release manifest, SHA-bound candidate lock, source commit/tree, scaffold manifest and template inventory. The recorded channel reflects the selected release, so a stable selection through `prerelease` is recorded as stable.

These source and channel flows require a selected Code source with the native provenance, release-adoption and source-selection interfaces. Historical releases, including Stable 4.0.3, lack these interfaces; updating CLI `dev` does not retrofit them or make these operations executable against those releases.

When a developer runs `peanut create` in an interactive terminal without `--edition`, the CLI requires an explicit choice between `multi-tenant` and `standalone`. Machine/CI usage remains fail-closed and must pass `--edition`. There is no implicit Edition default.

`--profile` selects the file profile (`minimal|standard|full`); `--workflow` independently selects integration (`none|runtime|full`) within either Edition. Omitting `--workflow` keeps the native creator's `runtime` default. An explicit workflow is recorded in the public application manifest and must match the requested value before the target is finalized.

The two Editions are separate deliverables and deployments. `standalone` produces the single-tenant projection and omits the Platform bundle; `multi-tenant` produces the Platform/tenant-management projection. Their runtime directories, configuration and deployment identities must not be mixed, and normal APP/scaffold upgrades remain within the recorded Edition rather than changing Edition as a side effect.

For product validation, shared code and the common lifecycle do not need two identical full test runs. Use the maintainer's two registered permanent APPs for post-package validation; do not create a new test APP per attempt. Shared lifecycle evidence may be reused only for unchanged inputs and genuinely shared behavior. Multi-tenant should be the primary broad functional/regression target because it includes the additional Platform, tenant-management, Host and tenant-switching surfaces. The other Edition still requires its Edition projection checks and critical create/install/start/login/deploy/upgrade smoke path. Edition-specific behavior must be tested in the Edition that owns it.

Creation is fail-closed: it stages the application first, verifies the native `create-app` result, and only then moves the application into the requested target. The native application manifest records the selected repository, requested ref, channel, release version (null for development), and actual generation commit/tree/inventory/Edition profile. `template.version` is a compatibility baseline, not proof that development source was published. The CLI checks the native identity before moving the staging directory. A failed creation does not leave the requested target behind.

### Explicit implementation boundary

The approved simpler product direction is default official template archives, an explicit local archive option, and creation into a strictly empty directory. Those changes are **not implemented in this CLI source**: the current source/ref flow still obtains Code and rejects existing targets, including empty directories. `--source` is a Git source, not a tarball parameter. Do not invent `--force`, rename an APP during an upgrade, or treat an approved design as a working command. Existing APPs use the fixed-plan upgrade path below; their installed docs/baselines change only through an actual accepted upgrade.

## Development APP upstream upgrades

`peanut upgrade` absorbs a published Peanut Admin/scaffold release into a downstream development APP. It uses `scripts/scaffold-upgrade` from the selected public Code source, fixed to the authenticated release commit/tree/inventory SHA while retaining the requested ref, for package authentication, baseline, three-way differences, ownership, conflict resolution, apply, verify, journal and recovery. CLI does not implement another upgrade engine. This command requires PHP, Composer and Python 3 (safe archive extraction). On first use, CLI installs the selected engine's production dependencies from its committed Composer lock, with scripts and plugins disabled and isolated Composer configuration. It does not install or copy the APP's dependencies.

The default channel is `prerelease` for an APP using a prerelease scaffold, otherwise `stable`. `--channel stable|prerelease` selects explicitly; prerelease includes stable releases. For development APPs, read-only discovery checks the latest published release before interpreting the compatibility baseline. An explicit `--ref` is required before planning or applying a development-to-release transition. `--ref 4.0.0-rc.19` and `--ref v4.0.0-rc.19` select the same published tag. A source ahead of or diverged from the release, a custom source, or missing source identity cannot be applied automatically. A genuine file-changing transition requires a strictly newer Edition upgrade package whose declared source range covers the compatibility baseline; equal-version content changes and unsupported ranges fail closed.

`--check` reads public release proof and compares the APP's current `generation_source` with the published candidate commit/tree/inventory. Its `release_adoption_available` result means the source bytes match and the native plan can check the complete APP baseline; it does not apply changes. A development source has no fixed release version, so applying even an equivalent release adoption requires `--confirm-major-upgrade` after review. `--plan` obtains the fixed source engine, verifies its committed bytes and locked dependencies, and asks the native runner for an immutable plan. A content-equivalent release uses the native runner's metadata adoption plan, including installer-only baseline releases; it never substitutes an installer archive for an upgrade package. A real content change uses the Edition upgrade package and its source range. The selected package, engine, plan, source proof and dependency binding remain under `.peanut/upgrades/` for saved-plan apply and recovery. Apply/verify updates the APP's current source identity in its native manifest; the original source is retained in the native plan and recovery journal.

An equal-version fixed-release APP reports `up_to_date` only when its recorded source tree and inventory match the published candidate. An equal-version development APP with different content reports `source_range_unsupported`. Missing identity reports `source_identity_unknown`; source ahead or diverged with different content reports a non-executable relation. Equal tree and inventory can qualify for native adoption even when the commits differ; the native runner still verifies the whole APP baseline and published files before changing metadata.

> **Cross-major upgrade is a risk feature.** It may break custom business behavior, APIs, dependencies or migrations. Review the native plan, keep a recoverable backup and confirm there are no known unresolved risks before attempting apply. An AI or Agent must explain the source and target versions, risks and plan, then obtain human authorization before passing `--confirm-major-upgrade`. Prior explicit authorization for this upgrade or a clearly defined cross-major scope is sufficient; it need not be requested again. Generic development authorization is insufficient.

The default command plans, applies only a ready plan, and verifies through the native engine. Every cross-major apply and development-source apply with an unknown source major requires `--confirm-major-upgrade`, including saved-plan apply. Without it, a ready plan returns `confirmation_required`, the bound plan path, a next command and exit code 1 without applying. The binding checks the native plan's original identity and source proof, so a partly applied APP cannot bypass the gate by updating its current manifest. `--recover-plan` remains available after its binding checks. Neither `--ref`, `--confirm-plan-sha256`, nor conflict choices authorize a risk-gated apply. APP identity/version, downstream code, modules, pages, configuration, secrets and data are protected by native ownership checks. A conflicting plan returns `blocked` and exit code 1 without applying managed changes. Review all native actions, then explicitly preserve or replace every managed conflict:

```sh
peanut upgrade --apply-plan .peanut/upgrades/plans/<candidate>.json \
  --confirm-plan-sha256 sha256:<plan-digest> \
  --preserve-paths path/to/customized-file --replace-paths -
```

Use `-` for an empty decision list. Missing, overlapping or stale decisions are rejected by the native engine. To apply a reviewed ready plan, use `peanut upgrade --apply-plan <plan>` and add `--confirm-major-upgrade` when the plan reports a major or unknown-source-major risk. After a failed apply, review the native journal before `peanut upgrade --recover-plan <plan>`; CLI retains package/plan/recovery state. Native JSON responses must have empty stderr and exit 0; only a blocked native preflight uses exit 2. Non-executable check results and missing risk confirmation exit 1; invalid inputs/download/native failures exit 2. Successful check/plan/apply/recovery exits 0.

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
