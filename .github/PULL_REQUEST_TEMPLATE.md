<!-- Title must be a Conventional Commit header, e.g. "feat(api): add consent endpoint" -->

## Summary

<!-- What does this change and why? Link the issue if there is one: Closes #123 -->

## Changes

-

## Checklist

- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org) and the PR title does too
- [ ] `bun run ci` is green locally (lint, typecheck, tests, build)
- [ ] Tests added/updated (integration tests run in `workerd` against real bindings where the runtime is involved)
- [ ] New D1 migration (if any) is numbered sequentially in `packages/db/migrations` and contains no `BEGIN`/`COMMIT`/`PRAGMA foreign_keys`
- [ ] Docs updated where behaviour changed (`README.md`, `docs/decisions.md`, spec/plans)
- [ ] No secrets or local config committed (`.dev.vars`, `.wrangler/`)
