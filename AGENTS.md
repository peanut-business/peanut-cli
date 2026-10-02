# peanut-cli

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
