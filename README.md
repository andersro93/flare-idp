# flare-idp

Cloudflare-native Identity Provider (OIDC) built on Better-Auth, Hono and React.

- Design: `docs/superpowers/specs/2026-08-21-flare-idp-design.md`
- Plans: `docs/superpowers/plans/`

## Development

```sh
bun install
cp apps/idp/.dev.vars.example apps/idp/.dev.vars   # edit secrets
bun run dev          # Vite + workerd on http://localhost:5173
bun run ci           # lint, typecheck, tests, build
```
