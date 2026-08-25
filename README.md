<div align="center">

# flare-idp

**A small but powerful Identity Provider, built natively for Cloudflare Workers.**

OpenID Connect / OAuth 2.1 · passkeys · TOTP 2FA · organizations & teams · one Worker, one deploy.

[![CI](https://github.com/andersro93/flare-idp/actions/workflows/ci.yml/badge.svg)](https://github.com/andersro93/flare-idp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/andersro93/flare-idp?sort=semver&logo=github)](https://github.com/andersro93/flare-idp/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-FE5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Built with Better Auth](https://img.shields.io/badge/Built%20with-Better%20Auth-111827)](https://www.better-auth.com)
[![Bun](https://img.shields.io/badge/bun-1.4-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Checked with Biome](https://img.shields.io/badge/Checked_with-Biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev)

</div>

---

> **Status: early development.** The scaffold, tooling and the risk spikes are done and green (Phase 0). The identity features below are being built phase by phase — see the [roadmap](#roadmap). Do not deploy this as your IdP yet.

## What it is

flare-idp is a self-hosted **OIDC identity provider** for people who run their apps on Cloudflare and want one place to sign in. It is designed to be:

- **Cloudflare-native** — a single Worker serves the API, the UI, a cron job and a queue consumer. Storage is **D1** (SQL) and **KV** (cache); email goes through **Cloudflare Email Service** via a **Queue**. No servers, no containers.
- **Standards-first** — OAuth 2.1 authorization code + PKCE, refresh-token rotation, client credentials, OIDC discovery, JWKS (EdDSA), consent with first-party skip, RFC 7662 introspection / RFC 7009 revocation.
- **Secure by default** — email + password (invite-only), upstream social login (Google, GitHub, Microsoft), TOTP 2FA with backup codes, passkeys (WebAuthn), per-endpoint rate limiting in D1, strict CSP, audit log.
- **Organizations & teams** — users can belong to organizations and teams; memberships and roles are exposed as token claims for relying apps.
- **One stable API** — the web UI talks only to flare-idp's own **OpenAPI 3.1** (Hono + Zod, browsable with Scalar). [Better Auth](https://www.better-auth.com) powers the identity core behind that seam, so upgrades are absorbed inside the server, never by clients.
- **Testable end to end** — every route has contract tests that run inside the real Workers runtime (`workerd`) against real D1/KV/Queue bindings; deploys are gated on a green suite.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    RP[Relying app<br/>OIDC client]
    UI[Admin & account SPA<br/>React + TanStack]
  end

  subgraph Worker["Cloudflare Worker (one deploy)"]
    H[Hono API<br/>OpenAPI 3.1 · Zod · Scalar]
    BA[Better Auth core<br/>OIDC · passkeys · 2FA · orgs]
    CRON[scheduled()<br/>housekeeping]
    Q[queue()<br/>email consumer]
  end

  D1[(D1)]
  KV[(KV cache)]
  QUEUE[[Queue]]
  EMAIL[Email Service]

  RP -- /.well-known · /oauth2/* --> H
  UI -- /api/* --> H
  H --> BA
  BA --> D1
  BA --> KV
  H --> QUEUE --> Q --> EMAIL
  CRON --> D1
```

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (`nodejs_compat`), Workers Static Assets for the SPA |
| Backend | [Hono](https://hono.dev) + [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) + [Scalar](https://scalar.com) |
| Identity core | [Better Auth](https://www.better-auth.com) (`@better-auth/oauth-provider`, passkey, two-factor, organization, admin, jwt) |
| Data | D1 via [Drizzle ORM](https://orm.drizzle.team) migrations · KV as session cache · Queues · Email Service |
| Frontend | React 19 · [TanStack](https://tanstack.com) Router / Query / Form / Table · Tailwind CSS v4 · Base UI |
| Tooling | [bun](https://bun.sh) workspaces · TypeScript · [Biome](https://biomejs.dev) · [Vitest](https://vitest.dev) in `workerd` via `@cloudflare/vitest-plugin` · [`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/) · Wrangler |

## Repository layout

```
apps/idp/            the deployable Worker: wrangler.jsonc, vite.config.ts, src/worker.ts, src/client (SPA), tests
packages/api/        Hono app, Better Auth configuration, OpenAPI routes
packages/db/         Drizzle schema + D1 migrations
packages/shared/     Zod schemas, constants, shared types
packages/email/      EmailSender interface, adapters, templates
docs/                design spec, per-phase plans, measured decisions
```

## Getting started

Prerequisites: [bun](https://bun.sh) ≥ 1.4, Node.js ≥ 22 (Wrangler/Vite run on Node), a Cloudflare account for deployment.

```sh
git clone https://github.com/andersro93/flare-idp.git
cd flare-idp
bun install                                   # also installs the git hooks (lefthook)
bun run --cwd apps/idp types                  # generate Cloudflare Env types for your editor
bun run --cwd apps/idp db:apply:local         # create the local D1 schema
cp apps/idp/.dev.vars.example apps/idp/.dev.vars   # then edit the secrets
bun run dev                                   # Vite + workerd on http://localhost:5173
```

Useful scripts (run from the repo root):

| Command | What it does |
|---|---|
| `bun run dev` | Vite dev server with the Worker running in `workerd` and real local D1/KV/Queue bindings |
| `bun run check` / `bun run format` | Biome lint + format |
| `bun run typecheck` | regenerate Worker types, then `tsc --noEmit` for the whole workspace |
| `bun run test` | unit (jsdom), node and integration (`workerd`) test projects |
| `bun run build` | production build of SPA + Worker |
| `bun run ci` | everything the CI runs: check → typecheck → test → build |
| `bun run --cwd apps/idp check:startup` | measure Worker bundle size and startup CPU |

## Deployment

Deployment targets live in `apps/idp/wrangler.jsonc` as Wrangler environments (`preview`, `production`). The GitHub Actions workflows deploy a preview from `main` and production from release tags once Phase 3 lands; until then, deploy manually:

```sh
cd apps/idp
bunx wrangler d1 migrations apply flare-idp --remote --env production
bun run build && bunx wrangler deploy --env production
```

Secrets (`AUTH_SECRET`, `SETUP_SECRET`, social-provider keys) are set with `wrangler secret put` and never stored in the repo.

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo scaffold, CI, Workers test harness, risk spikes (OIDC on D1, passkeys on `workerd`, KV, Email Service, Queues, cold start) | ✅ done |
| 1 | Drizzle schema, production Better Auth config, Hono skeleton, session + setup API, rate limiting | ✅ done |
| 2 | OAuth 2.1 / OIDC provider: discovery, JWKS, authorization code + PKCE, consent, client credentials, admin client API | 🔜 next |
| 3 | Web UI (sign-in, consent, account), deploy workflows — **first relying app logs in** | ⏳ |
| 4 | Organizations, teams, roles and token claims | ⏳ |
| 5 | TOTP 2FA, passkeys, social login, account linking | ⏳ |
| 6 | Admin console, settings, audit log, stats | ⏳ |
| 7 | Operations: cron housekeeping, queue hardening, runbooks | ⏳ |
| 8 | End-to-end suite (Playwright), hardening | ⏳ |

The verified facts behind these decisions (measured bundle size, cold-start CPU, Better Auth behaviour on D1, cookie/claims shapes) are in [`docs/decisions.md`](docs/decisions.md).

## Documentation

- [Design specification](docs/superpowers/specs/2026-08-21-flare-idp-design.md) — architecture, decisions, testing strategy
- [Implementation plans](docs/superpowers/plans/) — one plan per phase
- [Decisions & verified facts](docs/decisions.md) — outcomes of the Phase 0 spikes
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome. Commits follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by a git hook and in CI); releases are cut automatically by [release-please](https://github.com/googleapis/release-please) using semantic versioning. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Anders Refsdal Olsen
