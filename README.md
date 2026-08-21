# flare-idp

Cloudflare-native Identity Provider (OIDC) built on Better-Auth, Hono and React.

- Design: `docs/superpowers/specs/2026-08-21-flare-idp-design.md`
- Plans: `docs/superpowers/plans/`
- Decisions / verified facts: docs/decisions.md

## Development

```sh
bun install
bun run --cwd apps/idp types   # generate Cloudflare Env types for your editor (also run by typecheck)
bun run --cwd apps/idp db:apply:local   # create the local D1 schema before first dev run
cp apps/idp/.dev.vars.example apps/idp/.dev.vars   # edit secrets
bun run dev          # Vite + workerd on http://localhost:5173
bun run ci           # lint, typecheck, tests, build
```
