# Contributing to flare-idp

Thanks for your interest! This document explains how the project is developed so that contributions land smoothly.

## Ground rules

- Be kind — the [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere in this project.
- Security issues are **not** reported as public issues — see [SECURITY.md](SECURITY.md).
- Small, focused pull requests are easier to review than large ones. Open an issue first for anything non-trivial so we can agree on the approach (the [design spec](docs/superpowers/specs/2026-08-21-flare-idp-design.md) is the architectural reference).

## Development setup

Prerequisites: [bun](https://bun.sh) ≥ 1.4 and Node.js ≥ 22 (Wrangler, Vite and Vitest execute on Node).

```sh
bun install                                   # also installs git hooks via lefthook
bun run --cwd apps/idp types                  # Cloudflare Env types for your editor
bun run --cwd apps/idp db:apply:local         # local D1 schema
cp apps/idp/.dev.vars.example apps/idp/.dev.vars
bun run dev
```

Before pushing, run the same gate as CI:

```sh
bun run ci        # biome check → typecheck → tests (jsdom, node, workerd) → build
```

## Commit messages — Conventional Commits

All commits **must** follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org). This is enforced locally by a `commit-msg` hook (lefthook + commitlint) and again in CI for every commit in a pull request and for the PR title. Releases and the changelog are generated from these messages by [release-please](https://github.com/googleapis/release-please).

```
<type>(<optional scope>): <short summary>

<optional body>

<optional footer(s)>
```

| Type | Use for | Release effect |
|---|---|---|
| `feat` | a user-visible feature | minor bump |
| `fix` | a bug fix | patch bump |
| `perf` | performance improvement | patch bump |
| `revert` | reverting a previous commit | patch bump |
| `docs` | documentation only | none (listed in changelog) |
| `refactor`, `test`, `build`, `ci`, `chore`, `style` | internal changes | none |

- A breaking change is marked with `!` after the type/scope (`feat(api)!: …`) and/or a `BREAKING CHANGE:` footer. Before 1.0.0 a breaking change bumps the **minor** version.
- Suggested scopes: `api`, `auth`, `db`, `web`, `email`, `ci`, `deps`, `docs`, `spike`.
- Keep the summary in the imperative mood, preferably starting with a lower-case letter (`feat: add …`), and under 72 characters (hard limit 100); wrap the body at 100 columns.
- Dependabot, Renovate and release-please commits already follow this format.

## Pull requests

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the commit history meaningful — squash fix-ups locally; the PR title must itself be a valid conventional commit header because it becomes the merge commit subject.
3. Add or update tests. Integration tests run inside the real Workers runtime (`workerd`) via `@cloudflare/vitest-plugin` against real D1/KV/Queue bindings — prefer those over mocks for anything touching the runtime.
4. D1 migrations live in `packages/db/migrations` and are numbered sequentially (`NNNN_name.sql`); CI rejects a number that already exists on `main` under a different name.
5. Make sure `bun run ci` is green, then open the PR using the template.

## Releases and versioning

- The project follows [Semantic Versioning](https://semver.org). `main` is always releasable.
- [release-please](https://github.com/googleapis/release-please) watches `main`, keeps a release pull request up to date with the pending version bump and `CHANGELOG.md`, and — when that PR is merged — tags `vX.Y.Z` and publishes a GitHub Release. Nobody tags by hand.
- Pre-1.0: `feat` bumps the minor version, `fix` the patch version, breaking changes the minor version.

## Project documentation

- `docs/superpowers/specs/` — design specification (the authority for architectural decisions)
- `docs/superpowers/plans/` — per-phase implementation plans
- `docs/decisions.md` — measured facts and decisions from the Phase 0 spikes (read before touching the identity core)
