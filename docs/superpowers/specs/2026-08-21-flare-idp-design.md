# flare-idp — Cloudflare-native Identity Provider (design + implementation plan)

## Context

Anders wants a self-contained Identity Provider that runs natively on Cloudflare Workers: a personal SSO hub that issues OIDC identities to his own apps (the sibling Workers projects and future ones). It must be deployable from one repo with its wrangler config, use D1 (database) + KV (cache), build on Better-Auth (users, 2FA, passkeys, organizations + teams, OAuth/OIDC provider, admin), expose a fully OpenAPI-described Hono backend (Zod + Scalar), and ship a React + TanStack (Router/Query/Form/Table) frontend. Everything must be testable so that dependency updates and deploys happen confidently when the suite is green.

Key architectural choice (made during planning): **our own OpenAPI facade is the only API the SPA talks to**. Better-Auth sits entirely behind that seam (called server-side via `auth.api.*`); the SPA does not use the Better-Auth client at all. Only protocol routes called by third parties (OAuth2/OIDC endpoints for relying parties, social-provider callbacks) are served natively by Better-Auth, behind an explicit allowlist. This keeps one stable contract for the SPA and absorbs Better-Auth's churn (1.5 and 1.7 were both breaking) inside our handlers, verified by contract tests.

`/home/anders/projects/privat/flare-idp` is empty (not a git repo yet). The sibling `/home/anders/projects/privat/mi-casa-su-casa` already runs Better-Auth 1.7.1 + Drizzle + D1 + Hono in one Worker with miniflare integration tests and is the convention reference (Biome, `wrangler.jsonc` with `preview`/`production` envs, env validation, security headers, D1-backed rate limiting, D1 migrations, GitHub Actions).

## Decisions (from the interview — settled)

| Topic | Decision |
|---|---|
| Purpose / tenancy | Personal SSO hub, single tenant. Orgs/teams = user groupings; OAuth clients are global, admin-managed. |
| OIDC | Auth code + PKCE, discovery, JWKS, refresh rotation, client credentials, consent screen with first-party skip, org/team/role claims in tokens (`orgs` scope). |
| Sign-in | Email + password, **invite-only** (no public sign-up), upstream social login Google/GitHub/Microsoft with account linking. 2FA (TOTP + backup codes), passkeys. |
| Topology | Monorepo (bun workspaces) but **one deployed Worker**: Hono API + SPA (static assets) + `scheduled` cron + `queue` consumer in the same Worker. Workers **Paid** plan. |
| DB / cache | D1 via `@better-auth/drizzle-adapter` + single Drizzle schema + drizzle-kit SQL migrations applied by wrangler. KV for Better-Auth `secondaryStorage` (session read cache) and app caches; rate-limit counters in D1. |
| API shape | **Full facade**: every SPA-facing endpoint is ours (`@hono/zod-openapi`, one OpenAPI 3.1 doc, one Scalar source, one `hc<AppType>` client). Handlers call `auth.api.*` with `headers: c.req.raw.headers` and forward `Set-Cookie` via `returnHeaders: true`. Native Better-Auth routes only for third-party-called protocol endpoints behind an allowlist. Better-Auth `openAPI` plugin not used. |
| Frontend | Vite SPA (not TanStack Start — still RC), React 19, TanStack Router (file-based) + Query v5 + Form v1 + Table v9, Tailwind v4 + `@base-ui/react`. API via `hc<AppType>` + TanStack Query only; WebAuthn ceremonies via `@simplewebauthn/browser`. **No `better-auth/react` client.** |
| Email | Cloudflare **Email Service** (`send_email` binding, beta, Paid) behind an `EmailSender` interface with a console/capture adapter for dev/tests; dispatched via a Queue. |
| Admin scope v1 | Users (list/search/create-invite/ban/reset 2FA/sessions/impersonate), OAuth clients (CRUD, secret rotation, redirect URIs, trusted flag, scopes), orgs & teams, audit log + system settings. |
| Tooling / CI | bun 1.4 workspaces, Biome 2.x, TypeScript, `@cloudflare/vite-plugin` dev loop, `@cloudflare/vitest-plugin` 1.0, Playwright e2e, GitHub Actions CI → preview on main → production on tag/manual. |
| Testability | First-class: unit + integration (real D1/KV/queue/email in workerd) + contract tests per facade route + e2e OIDC round-trip; deploys gated on green + post-deploy smoke. |

## Research facts that constrain the design (verified Aug 2026)

- **Better-Auth 1.7.1** (no v2; lockstep `@better-auth/*` packages at 1.7.1). 1.7 replaced `oidcProvider` with **`@better-auth/oauth-provider`** (`oauthClient` tables, `auth.api.adminCreateOAuthClient/getOAuthClients/updateOAuthClient/rotateClientSecret/deleteOAuthClient`, consent endpoint, RFC 7591/8414/7662/7009/9207, `skip_consent`, `customIdTokenClaims/customAccessTokenClaims/customUserInfoClaims`, client-credentials scopes per client; **requires `jwt()`**). Discovery is served at `/api/auth/.well-known/openid-configuration` → root `/.well-known/*` rewrites needed (issuer = APP_URL). CLI is `npx auth@latest generate|migrate` (old `@better-auth/cli` frozen at 1.4) and stubs `cloudflare:workers`.
- Every Better-Auth endpoint is callable server-side as `auth.api.<name>({ body, query, headers, returnHeaders?: true, asResponse?: true })`; cookie-setting flows return `Set-Cookie` headers to forward. **Better-Auth's rate limiter and origin/CSRF checks run only in its HTTP handler** → the facade needs its own rate limiting (D1-backed, ported from mi-casa `security/rate-limit.ts`) and origin checks.
- D1 has **no interactive transactions** → `drizzleAdapter(..., { transaction: false })`; SCIM out. `nodejs_compat` required. `better-auth/minimal` drops Kysely (valid with Drizzle adapter).
- `SecondaryStorage` (1.7) requires `get/set/delete/getAndDelete/increment`. `increment` only used when `rateLimit.storage === "secondary-storage"` (silent default with secondaryStorage → set `"database"` explicitly; KV rejects TTL < 60 s); `getAndDelete` only in `consumeVerificationValue` when `verification.storeInDatabase` is false → set it `true`. oauth-provider throws unless `session.storeSessionInDatabase: true` with secondaryStorage. Net: **KV = session read cache only**; TTL clamped ≥ 60 s.
- Passkey plugin (SimpleWebAuthn) on workerd: not in Better-Auth's own Cloudflare smoke fixture but mi-casa runs it in prod → confirm in spike. Browser side = `@simplewebauthn/browser` `startRegistration/startAuthentication` against our facade's options/verify routes.
- Workers cold-start CPU + recurring `createRequire` startup-crash class in Better-Auth → pin exact versions, cold-start smoke in CI.
- Hono: `@hono/zod-openapi` needs Zod 4 (`import { z } from "@hono/zod-openapi"`), `app.doc31`; typing bug when chaining `.use()`/`.openapi()` on one instance (honojs/middleware#930/#637) → middleware in separate statements, `Variables` on the generic, chain only `.route()` for `AppType`.
- Scalar: `Scalar()` (not `apiReference`), self-host bundle via `cdn:`; `/api/docs` needs `style-src 'unsafe-inline'`.
- Cloudflare: `@cloudflare/vite-plugin` runs the Worker in workerd with real bindings; `vite build` emits `dist/client` + `dist/<worker>/wrangler.json` used by `wrangler deploy`; `@cloudflare/vitest-plugin` 1.0 (`cloudflareTest`, `readD1Migrations`; `cloudflare:test` exposes `env, SELF, applyD1Migrations, createScheduledController, createMessageBatch, getQueueResult`).
- **Email Service** = `send_email` key (`{ "name": "EMAIL" }`), `env.EMAIL.send({ to, from, subject, html, text }) → { messageId }`; domain onboarded in dashboard; arbitrary recipients need Paid. `wrangler dev`/vite simulate it; miniflare `email: { send_email: [{ name: "EMAIL" }] }`.
- **Queues**: free-plan capable; producer + consumer in one Worker; miniflare `queueProducers`/`queueConsumers`.
- TanStack Start still RC → Router SPA. Router/Form take Zod 4 directly. Table v9 stable. Base UI = **`@base-ui/react` 1.7.0**.

## Architecture

### Repo layout

```
flare-idp/
  package.json                 # workspaces ["apps/*","packages/*"]; root scripts fan out via `bun run --filter`
  bunfig.toml  biome.json  tsconfig.base.json  .gitignore  README.md
  .github/workflows/{ci,preview-deploy,production-deploy,production-d1-migrate}.yml
  docs/                        # architecture.md, operations.md, runbook.md, oidc-integration.md, decisions.md, upgrading-better-auth.md, superpowers/specs/
  apps/idp/                    # @flare-idp/app — THE deployable Worker
    wrangler.jsonc  vite.config.ts  vitest.config.ts  playwright.config.ts  index.html  worker-configuration.d.ts  .dev.vars.example
    public/vendor/scalar/standalone.js   # copied by scripts/copy-scalar.ts (prebuild)
    src/worker.ts              # export default { fetch, scheduled, queue }
    src/client/                # SPA: main.tsx, router.tsx, routes/**, components/ui/**, lib/{api,query,webauthn,queries/*}.ts, styles.css
    test/{unit,integration,fixtures}/**  e2e/**
  packages/api/                # @flare-idp/api (source exports, no build step)
    src/auth/{auth.ts,kv-secondary-storage.ts,access-control.ts,claims.ts,email-hooks.ts,forward.ts}
    src/http/{app.ts,context.ts,errors.ts,env.ts,log.ts,security/{origin,compare,rate-limit}.ts,middleware/{session,require-auth,require-admin,rate-limit}.ts}
    src/routes/{health,setup,session,auth/{password,email-verification,two-factor,passkeys,social},account/{profile,sessions,connections},orgs/{orgs,members,invitations,teams},oauth/consent,admin/{users,oauth-clients,orgs,audit,settings,stats},me}.ts
    src/openapi/{doc.ts,scalar.ts,protocol-routes.ts}   # protocol-routes: hand-described OAuth2/OIDC + callback paths for the doc
    src/audit.ts  src/jobs/housekeeping.ts  src/queue/email-consumer.ts
    src/index.ts               # exports app, AppType, auth, createAuth, handleScheduled, handleQueue
  packages/db/                 # @flare-idp/db — Drizzle schema + migrations
    src/schema/{auth.ts (generated),app.ts,index.ts}  src/client.ts  src/repositories/{audit,settings,memberships,rate-limit}.ts
    drizzle.config.ts  migrations/*.sql
  packages/shared/             # @flare-idp/shared — Zod schemas (requests/responses), constants (roles, org roles, scopes + descriptions, permissions), error codes
  packages/email/              # @flare-idp/email — EmailSender, cloudflareEmailSender, consoleEmailSender, queueEmailSender, templates/*
```

Workspace packages export TypeScript source; Vite bundles them into the Worker. `wrangler.jsonc` stays in `apps/idp` with `main: "src/worker.ts"`; `migrations_dir: "../../packages/db/migrations"` (spike S1; fallback = relative symlink).

### Request flow (apps/idp/src/worker.ts → packages/api/src/http/app.ts)

`assets.run_worker_first: true` (every request through the Worker so one `secureHeaders` block governs SPA + API). Middleware order: `secureHeaders` (strict CSP; `/api/docs` relaxed style-src) → `cors` on `/api/*` (APP_URL only, credentials) → origin/CSRF check on mutating `/api/*` **except** `/api/auth/oauth2/{token,introspect,revoke}` (client-authenticated, server-to-server) → env validation (503 fail-closed, `/api/health/live` exempt) → failed-request logging → session loader (`auth.api.getSession`) → D1-backed rate limiter on sensitive routes → routes:

- **Native Better-Auth allowlist** (third-party callers only; everything else under `/api/auth/*` → 404, enforced by a test):
  `/api/auth/oauth2/{authorize,token,userinfo,introspect,revoke,end-session}`, `/api/auth/.well-known/*`, `/api/auth/jwks`, `/api/auth/callback/:provider` (social provider redirect target). Root rewrites: `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server` → `/api/auth/.well-known/*`; `/.well-known/jwks.json` → `/api/auth/jwks`. These are hand-described in our OpenAPI doc (`openapi/protocol-routes.ts`) so the doc is complete.
- **Facade** (`OpenAPIHono` modules, the only thing the SPA calls) — see table below.
- `app.doc31("/api/openapi.json")`; `/api/docs` Scalar (single source, self-hosted bundle).
- `app.all("/api/*", 404 json)`; `app.get("*", ASSETS.fetch re-wrapped)`.
- `scheduled`: housekeeping. `queue`: email consumer.

### Facade seam (packages/api/src/auth/forward.ts)

```ts
// Call a Better-Auth endpoint with the caller's headers; forward Set-Cookie (and any other response headers we allow) onto our Hono response.
export async function callAuth<T>(c: Context, fn: () => Promise<{ headers: Headers; response: T }>): Promise<T> {
  const { headers, response } = await fn();                 // fn = () => auth.api.signInEmail({ body, headers: c.req.raw.headers, returnHeaders: true })
  headers.getSetCookie().forEach((v) => c.header("Set-Cookie", v, { append: true }));
  return response;
}
// Better-Auth APIError → our error envelope: { error: { code, message, details? } }, mapped status; every facade route declares its error responses in OpenAPI.
```

### Facade route families (all Zod-described in OpenAPI, `AppType` covers all)

| Family | Routes (prefix `/api`) | Wraps |
|---|---|---|
| health | `GET /health/live`, `/ready` | D1 + KV checks |
| setup | `GET /setup/status`, `POST /setup/complete` | first admin (SETUP_SECRET, claim-then-create) |
| session | `GET /session`, `POST /session/sign-in/password`, `POST /session/sign-out`, `POST /session/sign-out-all` | `getSession`, `signInEmail` (returns `{ twoFactorRequired }` or session), `signOut`, `revokeSessions` |
| auth/password | `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/password/change` | `requestPasswordReset` (redirect to SPA `/reset-password`), `resetPassword`, `changePassword` |
| auth/email | `POST /auth/email/verify`, `POST /auth/email/resend` | `verifyEmail` (token from SPA page), `sendVerificationEmail` |
| auth/two-factor | `POST /auth/two-factor/verify-totp`, `/verify-backup-code` (challenge after sign-in), `POST /account/two-factor/enable`, `/verify-setup`, `/disable`, `/backup-codes/regenerate`, `GET /account/two-factor` | twoFactor plugin endpoints; interim 2FA cookie forwarded |
| auth/passkeys | `POST /auth/passkeys/authenticate/options`, `/authenticate/verify`; `GET /account/passkeys`, `POST /account/passkeys/register/options`, `/register/verify`, `PATCH /account/passkeys/:id`, `DELETE /account/passkeys/:id` | passkey plugin (`generatePasskey*Options`, `verifyPasskey*`, list/update/delete); challenge cookie forwarded; SPA uses `@simplewebauthn/browser` |
| auth/social | `POST /auth/social/:provider/start` → `{ url }`; `GET /account/connections`, `POST /account/connections/:provider/link` → `{ url }`, `DELETE /account/connections/:provider` | `signInSocial`, `listUserAccounts`, `linkSocialAccount`, `unlinkAccount`; provider callback stays native |
| account | `GET/PATCH /account/profile`, `GET /account/sessions`, `DELETE /account/sessions/:id`, `GET /me/audit` | `updateUser`, `listSessions`, `revokeSession`; our audit repo |
| orgs | `GET/POST /orgs`, `GET/PATCH/DELETE /orgs/:slug`, `POST /orgs/:slug/activate`, members (`GET`, `PATCH role`, `DELETE`, `POST leave`), invitations (`GET/POST`, `DELETE`, `POST /invitations/:id/accept|reject`), teams (`GET/POST`, `PATCH/DELETE /teams/:id`, members add/remove) | organization plugin endpoints |
| oauth | `GET /oauth/consent?client_id&scope…` (client info + scope descriptions), `POST /oauth/consent` → `{ redirectTo }` | oauth-provider consent endpoint (+ `getOAuthClient` public info) |
| admin | `/admin/users` (list/search, `POST invite` = `createUser` + set-password email, `PATCH role`, `POST ban|unban`, sessions list/revoke, `POST impersonate`, `POST reset-two-factor`, `POST remove`), `/admin/oauth-clients` (list/get/create/update/rotate-secret/delete; policy: https or loopback redirect URIs, PKCE for public clients, allowed scopes, `skip_consent`, client-credentials scopes), `/admin/orgs` (list/create-for-user/delete), `GET /admin/audit`, `GET/PUT /admin/settings`, `GET /admin/stats` | admin plugin, oauth-provider admin APIs, organization plugin, our repos |

Conventions: cursor/offset pagination envelope `{ items, nextCursor }`, error envelope `{ error: { code, message } }`, `security: [{ cookieAuth: [] }]` on authenticated routes, `x-rate-limit` documented on sensitive routes, every route has success + error responses declared.

### Identity core (packages/api/src/auth/auth.ts)

```ts
import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth/minimal";
export function createAuth(e: Env, sender: EmailSender) {            // factory for tests; singleton below for runtime
  return betterAuth({
    appName: e.APP_NAME, baseURL: e.APP_URL, secret: e.AUTH_SECRET, trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(dbFor(e.DB), { provider: "sqlite", schema, transaction: false }),
    secondaryStorage: kvSecondaryStorage(e.KV),                        // get/set/delete; TTL clamped ≥60s
    session: { storeSessionInDatabase: true, expiresIn: 14d, updateAge: 1d, cookieCache: { enabled: true, maxAge: 300 } },
    verification: { storeInDatabase: true },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, revokeSessionsOnPasswordReset: true, sendResetPassword },
    emailVerification: { sendVerificationEmail /* link → SPA /verify-email?token */, autoSignInAfterVerification: true },
    socialProviders: { google?, github?, microsoft? },                // included only if env secrets exist
    account: { accountLinking: { enabled: true, trustedProviders: [...] } },
    rateLimit: { enabled: false },                                     // facade rate-limits; Better-Auth's limiter only guards its own handler
    advanced: { database: { generateId: "uuid" }, ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }, useSecureCookies: e.ENVIRONMENT !== "development" },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      organization({ ac, roles, teams: { enabled: true }, creatorRole: "owner", sendInvitationEmail }),
      oauthProvider({ loginPage: "/sign-in", consentPage: "/oauth/consent", scopes, storeClientSecret: "hashed",
                      clientPrivileges: ({ user }) => user?.role === "admin", customIdTokenClaims, customAccessTokenClaims, customUserInfoClaims }),
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } }, disabledPaths: ["/token"] }),
      twoFactor({ issuer: e.APP_NAME, trustDevice: true }), passkey({ rpID, rpName, origin }),
    ],
  });
}
export const auth = createAuth(env as Env, queueEmailSender(env.EMAIL_QUEUE));
```

Native handler mount: `app.on(["GET","POST"], "/api/auth/*", allowlist(PROTOCOL_PATHS), c => auth.handler(c.req.raw))`. Better-Auth's built-in rate limiting is replaced by our middleware on `/api/auth/oauth2/token` etc. as well.

Claims: with the `orgs` scope, id_token/userinfo get `role` and `orgs: [{ id, slug, name, role, teams: [{ id, name }] }]` from `repositories/memberships.ts` (capped, documented). Invite-only onboarding: `POST /api/admin/users/invite` = `auth.api.createUser` (random password, role) + password-reset email rendered as "set your password" (link → SPA `/set-password?token`).

### Frontend (apps/idp/src/client)

Router context `{ queryClient }`; `sessionQuery` (`GET /api/session`, `staleTime` 60 s, invalidated on sign-in/out) is the session source. Pathless layouts: `_public` (sign-in incl. password/passkey/social buttons, two-factor challenge, invite.$token, set-password, verify-email, forgot/reset-password, oauth/consent, setup), `_auth` (`beforeLoad`: `ensureQueryData(sessionQuery)` or `redirect("/sign-in?redirect=")`), `_auth/_admin` (role check). Pages: dashboard; account (profile, security: password/2FA enrol w/ QR + backup codes/passkeys/sessions/linked accounts); orgs (list/create, `$slug` members/roles, invitations, teams, settings); admin (users, oauth-clients, orgs, audit, settings). `lib/api.ts` = `hc<AppType>("/")`; `lib/webauthn.ts` = `@simplewebauthn/browser` wrappers; `queryOptions` per resource, loaders use `ensureQueryData`; TanStack Form + Zod 4 schemas from `@flare-idp/shared`; Table v9; `components/ui/*` on `@base-ui/react` + Tailwind v4; per-route code splitting.

### Security posture

Strict CSP (`default-src 'self'`, `script-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`; no inline styles outside `/api/docs`), HSTS, same-origin cookies (`useSecureCookies` outside dev), Origin-checked mutations, `trustedOrigins`, env fail-closed, **our D1-backed per-endpoint rate limits** keyed by `cf-connecting-ip` (+ per-account for sign-in/2FA), audit log for admin/security actions, PKCE mandatory for public clients, hashed client secrets, refresh rotation + replay detection, Better-Auth surface minimized to the protocol allowlist, secrets via `wrangler secret`/`.dev.vars`, `keep_vars`, `invocation_logs: false`.

### Testing strategy ("green = deployable")

- **Unit** (node/jsdom): shared schemas, email templates/escaping, client components & hooks, router guards with `createMemoryHistory`, wrangler-config + migrations-lint tests (ported).
- **Integration** (workerd via `@cloudflare/vitest-plugin`, real D1 with migrations + KV + queue + `send_email` stub): **contract test per facade route** (request/response schema, error envelope, authz, audit side-effect, cookie forwarding); auth flows via `SELF.fetch` with cookie jar (setup → sign-in → 2FA → passkey → org invite → admin actions); **full OIDC round-trip** (admin creates client → authorize → consent via facade → code → token → userinfo → verify id_token vs JWKS → refresh → revoke → introspect; trusted client skips consent; PKCE enforced), client-credentials; **allowlist test** (every non-allowlisted `/api/auth/*` path → 404); security headers; rate limits; env guard; schema-drift (Drizzle vs `PRAGMA table_info`); OpenAPI 3.1 validity + snapshot; `scheduled` via `createScheduledController`; queue via `createMessageBatch`/`getQueueResult`; cold-start timing smoke.
- **E2E** (Playwright vs built artifact under `vite preview`/`wrangler dev`): setup → sign-in → create client → tiny RP app (`apps/e2e-rp`) completes OIDC login; 2FA enrol; passkey via virtual authenticator.
- **Pipeline**: PR → biome + typecheck + unit + integration + build (+ e2e). `main` → preview deploy → smoke (`/api/health/ready`, discovery, JWKS) → production on tag/manual with the same smoke. Renovate groups Better-Auth lockstep packages; `docs/upgrading-better-auth.md` = bump → run suite → fix facade handlers until green.

## Implementation phases (each phase: TDD, ends green with `bun run ci`)

**Step 0 — after plan approval.** `git init`, save this design as `docs/superpowers/specs/2026-08-21-flare-idp-design.md`, then run the `superpowers:writing-plans` skill to expand the phases below into the bite-sized TDD task plan that implementation follows.

**Phase 0 — Scaffold, tooling, CI, risk spikes.** Root workspace files (port biome/tsconfig from mi-casa; ignore `routeTree.gen.ts`, `worker-configuration.d.ts`), `apps/idp` with hello-world `worker.ts` (fetch/scheduled/queue), `wrangler.jsonc`, `vite.config.ts`, `vitest.config.ts` (unit jsdom project + integration `cloudflareTest` project with `readD1Migrations`, KV, queues, `email.send_email`), `wrangler types`, empty packages, `ci.yml` (bun). Spikes as throwaway integration tests in `apps/idp/test/spikes/`: **S1** workspace `main`/`migrations_dir` resolution under vite plugin + vitest; **S2** cold start/bundle size of `better-auth/minimal` + drizzle adapter + all plugins; **S3** passkey options/verify on workerd; **S4** oauth-provider code+PKCE → consent (via `auth.api` consent call) → token → userinfo → refresh on D1 with `transaction: false`, discovery + JWKS; **S5** Email Service + Queue in miniflare; **S6** KV secondaryStorage with `storeSessionInDatabase: true`; **S7 facade seam**: `auth.api.signInEmail({ returnHeaders: true })` → forward `Set-Cookie` → `auth.api.getSession` with forwarded cookie works; 2FA interim cookie and passkey challenge cookie survive the seam. Record outcomes in `docs/decisions.md`. Verify: `bun install && bun run ci`; `bun run dev` serves `/` and `/api/health`.

**Phase 1 — DB, Better-Auth core, Hono skeleton, session + setup facade, rate limiting.** `packages/shared` (roles, scopes + descriptions, request/response schemas, error codes), `packages/db` (drizzle config, generated `auth.ts`, `app.ts`: `audit_events`, `app_settings`, `app_installation`, `rate_limits`; `0001_init.sql`; migrations-lint), `packages/email` (interface, adapters, templates ported w/ escaping), `packages/api`: ported `env.ts`/`log.ts`/`security/*` incl. D1 rate limiter/`errors.ts`, `kv-secondary-storage.ts`, `auth.ts` factory + singleton (admin, jwt, bearer not needed, invite-only email+password), `forward.ts` seam + APIError mapping, `app.ts` (middleware order, allowlisted Better-Auth mount, `.well-known` rewrites, route-module pattern, `doc31`, Scalar), routes `health`, `setup`, `session` (sign-in password/sign-out/get), `auth/password`, `auth/email`, `account/profile` + `account/sessions`, `audit.ts`, `worker.ts` wiring, full `wrangler.jsonc`, integration infra (`setup.ts`, `helpers.ts` with `RESET_ORDER`, `signInAs` via facade). Tests: contract tests for each route, env validation, headers + asset passthrough, setup flows, sign-in/out/session cookie forwarding, rate-limit lockout, allowlist 404s, admin guard, audit, openapi validity, schema-drift, queue consumer, scheduled handler. Verify: `bun run ci`; `curl localhost:5173/api/health/ready`.

**Phase 2 — OAuth 2.1 / OIDC provider (MVP core).** Add `oauthProvider` + regenerate schema (`0002_oauth_provider.sql`), claims callbacks (role for now), `/api/oauth/consent` GET/POST facade, `/api/admin/oauth-clients` facade with policy + audit, protocol routes described in `openapi/protocol-routes.ts`, root `.well-known` tests (issuer = APP_URL), `scripts/oidc-smoke.ts` (openid-client: discovery → PKCE flow → verify id_token vs JWKS). Tests: full code flow incl. consent via facade, trusted skip, PKCE missing → error, refresh rotation, client_credentials only with configured scopes, introspect/revoke, userinfo claims, non-admin forbidden, token endpoint exempt from CSRF guard but rate-limited. Verify: `bun run test --project integration -t oauth`; smoke script against dev.

**Phase 3 — SPA foundation + MVP pages + deploy workflows.** Router/Query/Form/Table/Tailwind/Base UI setup, `api.ts` (`hc`), `sessionQuery`, guarded layouts, pages: setup, sign-in (password), oauth/consent, dashboard, account (profile, password, sessions), forgot/reset/set-password, verify-email, invite accept, admin/oauth-clients (thin). Port deploy workflows (`CLOUDFLARE_ENV=<env> bun run build`, `wrangler d1 migrations apply --env`, `wrangler deploy --env`), `docs/ci-cd-architecture.md`; create KV/queues per env (documented). Tests: client unit (forms, consent, guards with mocked session), build smoke. **MVP cut line: a relying app can log in via OIDC after Phases 0–3.**

**Phase 4 — Organizations, teams, roles, claims.** `organization({ teams, ac, roles })` + `0003_organizations.sql`; `/api/orgs/**` facade family; `orgs` claim from memberships; SPA orgs pages, org-invite accept; `/api/admin/orgs`. Tests: contract tests per route, owner/admin/member permission matrix, team membership reflected in id_token, invitation email enqueued + rendered.

**Phase 5 — Security features.** `twoFactor`, `passkey`, `socialProviders` (env-guarded) + account linking, `requireEmailVerification`, `0004_security.sql`; facade families `auth/two-factor`, `auth/passkeys`, `auth/social`, `account/connections`; SPA: 2FA challenge/enrol/backup codes, passkey register/sign-in (`@simplewebauthn/browser`), social buttons + linked accounts; admin ban/unban + revoke sessions + reset 2FA; sign-out-everywhere. Tests: TOTP enrol/verify (`otpauth` in tests), backup code single-use, passkey options/verify through the seam (synthetic attestation), social start URL + callback via `fetchMock`, cookie forwarding for each ceremony. Port mi-casa two-factor tests.

**Phase 6 — Admin console, settings, audit, stats.** `/api/admin/{users,audit,settings,stats}` facade families incl. invite + impersonation (audited), admin SPA pages with Table v9 (users, oauth-clients full, orgs, audit, settings), OpenAPI snapshot test finalized. Tests: pagination/filters, authz matrix, settings validation.

**Phase 7 — Operations.** `handleScheduled` purges (sessions/verifications/auth codes/refresh tokens/rate-limit rows) + audit retention; queue idempotency, retry/DLQ; structured log catalogue; `docs/operations.md`, `docs/runbook.md`, `docs/oidc-integration.md`, `docs/upgrading-better-auth.md`; observability config. Tests: scheduled purge, queue retry path.

**Phase 8 — E2E + hardening.** Playwright suite (setup → sign-in → create client → RP login → consent → token; 2FA; passkey virtual authenticator) against the built artifact in CI; post-deploy smoke job; Renovate config grouping Better-Auth packages; CSP report-only review; rate-limit tuning; optional DPoP/pairwise subjects; CodeQL workflow.

## Verification (end-to-end, after implementation)

1. `bun install && bun run ci` → biome, typecheck, unit + integration (real D1/KV/queue/email in miniflare, contract tests for every facade route, allowlist test), build — all green.
2. `bun run dev`: `http://localhost:5173/setup` → create admin, sign in, enrol 2FA, add a passkey (all through `/api/*` facade — network tab shows no `/api/auth/*` calls from the SPA); create an OAuth client in `/admin/oauth-clients`; `bun run scripts/oidc-smoke.ts http://localhost:5173` completes PKCE flow and verifies id_token against `/.well-known/jwks.json`; `/api/docs` renders the single spec without CSP violations.
3. `bun run test:e2e` → Playwright RP login passes against `vite preview`.
4. Preview deploy from `main` → smoke hits `/api/health/ready`, `/.well-known/openid-configuration`, JWKS; a sibling app configured with the preview issuer logs in.
5. Upgrade drill: bump Better-Auth lockstep packages on a branch → suite red/green tells exactly which facade handlers need adapting.

## Ported from mi-casa-su-casa (near-verbatim)

`src/server/runtime/env.ts`, `runtime/log.ts`, `security/origin.ts`, `security/compare.ts`, `security/rate-limit.ts`, the `secureHeaders` block + routing tail of `src/index.ts`, `http/errors.ts`, `email/sender.ts` (escaping + template style), `test/integration/{setup,helpers}.ts`, `test/migrations-lint.test.ts`, `test/wrangler-config.test.ts`, `test/fixtures/assets/*`, `.github/workflows/*.yml` (npm → bun, paths → `apps/idp`), `docs/ci-cd-architecture.md`, `wrangler.jsonc` env structure.
