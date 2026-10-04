# Peanut CLI

Independent developer CLI and tooling for Peanut products.

Peanut CLI is the source of truth for the global `peanut` command. It is independently versioned from Peanut Admin, PHP Core, Web Core, downstream applications, and Recipes.

## Current development line

CLI `0.2.0` implements the extracted MVP, project creation and native development APP upstream upgrades:

```sh
peanut --version
peanut create <target> --name <name> --slug <slug> --package <vendor/name> --edition standalone|multi-tenant
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

Creation is fail-closed: it stages the application first, verifies the native `create-app` result, and only then moves the application into the requested target. The result records the selected repository, ref, commit, and tree. A failed creation does not leave the requested target behind.

## Development APP upstream upgrades

`peanut upgrade` absorbs a published Peanut Admin/scaffold release into a downstream development APP. It uses the APP's installed `scripts/scaffold-upgrade` entrypoint for package authentication, baseline, three-way differences, ownership, conflict resolution, apply, verify, journal and recovery. CLI does not implement another upgrade engine. This command requires the installed APP's Composer dependencies, PHP and Python 3 (safe archive extraction); it does not install dependencies automatically.

The default channel is `prerelease` for an APP using a prerelease scaffold, otherwise `stable`. `--channel stable|prerelease` selects explicitly; prerelease includes stable releases. Discovery considers published releases in the current major version from the public `peanut-business/peanut-admin-code` repository. `--ref 4.0.0-rc.19` and `--ref v4.0.0-rc.19` select the same published tag. Mutable branches, unreleased commits, downgrades and automatic major changes are rejected.

`--check` reads release metadata without writing APP files or upgrade state. Its result identifies the repository, tag, channel, source commit/tree, Edition asset, compatibility and SHA-256. It reports availability, not successful package authentication or conflict readiness. `--plan` downloads the Edition upgrade package, verifies archive size/SHA and external manifest/inventory/source identity, then asks the installed engine to authenticate the package and persist its immutable plan and journal. Packages stay in `.peanut/upgrades/packages/<archive-sha256>/` so saved plans and recovery retain their source inputs. Existing packages are rechecked; the native engine reauthenticates inventory and baseline. The public release and its external manifest are the selected source of trust; no private keys or signatures are required.

An equal-version APP checks its recorded template source commit/tree against the public release manifest and SHA-bound candidate lock, without requiring an upgrade archive. It reports `up_to_date` only when both identities align, `source_identity_mismatch` when a recorded identity differs, or `version_current` with unknown source alignment when identity is absent. Equality never triggers apply or silently relabels the installed source. The first public baseline (rc18) has installer assets only; subsequent upgradeable releases must publish both Edition upgrade archives and their external manifests. Missing upgrade assets fail closed and installer archives are never substituted.

The default command plans, applies only a ready plan, and verifies through the native engine. APP identity/version, downstream code, modules, pages, configuration, secrets and data are protected by its ownership contract. A conflicting plan returns `blocked` and exit code 1 without applying managed changes. Review all native actions, then explicitly preserve or replace every managed conflict:

```sh
peanut upgrade --apply-plan .peanut/upgrades/plans/<candidate>.json \
  --confirm-plan-sha256 sha256:<plan-digest> \
  --preserve-paths path/to/customized-file --replace-paths -
```

Use `-` for an empty decision list. Missing, overlapping or stale decisions are rejected by the native engine. To apply a reviewed ready plan, use `peanut upgrade --apply-plan <plan>`. After a failed apply, review the native journal before `peanut upgrade --recover-plan <plan>`; CLI retains package/plan/recovery state and does not automatically discard or replay it. Blocked conflicts and same-version source mismatch exit 1; invalid inputs/download/native failures exit 2. Successful check/plan/apply/recovery exits 0.

This is a development source operation. It does not start servers, run dependency installation/builds, execute database migrations, switch production containers or deploy. Follow the APP's normal local dependency, migration and startup workflow after absorbing upstream changes. Production lifecycle follows the distribution's deployment contract: full-source instances use the distinct installed `scripts/upgrade` coordinator; server-only distributions use their `update.sh` deployment workflow.

 `github-ci@1.1.0` is carried as an inactive candidate and is not selected by the catalog.

The CLI has no npm runtime dependencies. It reads stable public Peanut application/release/Recipe protocols and does not import implementation source from Peanut Admin or either Core repository.

## Local development

```sh
npm test
npm run check
node bin/peanut.js --version
```

A checkout can be installed locally for CLI testing with `npm install -g .`. The team development policy is to use the newest approved CLI build from `dev`; public npm publication and GitHub Release are separate release gates, and this repository does not claim `@peanut/cli` is already published.

## Branches

- `dev`: development and integration
- `main`: release line
