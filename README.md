# Peanut CLI

Independent developer CLI and tooling for Peanut products.

Peanut CLI is the source of truth for the global `peanut` command. It is independently versioned from Peanut Admin, PHP Core, Web Core, downstream applications, and Recipes.

## Current development line

CLI `0.2.0` implements the extracted MVP plus project creation:

```sh
peanut --version
peanut create <target> --name <name> --slug <slug> --package <vendor/name> --edition standalone|multi-tenant
peanut doctor [--path <application>]
peanut status [--path <application>]
peanut recipe list [--path <application>]
peanut recipe status [<id>] [--path <application>]
peanut recipe add github-ci [--path <application>]
```

`github-ci@1.0.0` remains the active default Recipe.
`peanut create` defaults to the public `peanut-business/peanut-admin-code` repository at the latest `dev` ref for normal team development. Use `--ref <tag-or-commit>` when a project must be reproduced from an exact source revision; `--source <git-url-or-path>` selects an explicitly compatible source.

Creation is fail-closed: it stages the application first, verifies the native `create-app` result, and only then moves the application into the requested target. The result records the selected repository, ref, commit, and tree. A failed creation does not leave the requested target behind.

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
