# Decisions and verified facts

Facts verified by the Phase 0 spikes (date: 2026-08-21, better-auth 1.7.1, wrangler 4.125.0,
`@cloudflare/vite-plugin` 1.53.1, `@cloudflare/vitest-plugin` 1.0.0, jose 6.2.9, otpauth 9.5.1).

Source of record: the Task 4–10 implementer reports in
`.superpowers/sdd/2026-08-21-phase-0-scaffold-and-spikes/`. Every fact below is a measured result
from those spikes, not a projection.

## S1 — workspace paths

- `main: src/worker.ts` importing `@flare-idp/api` source: **works** in the vitest plugin
  (`integration` project bundled `@flare-idp/api` through the Worker entry and served
  `/api/health/live`) and in `vite build`/`vite dev`. No fallback needed.
- `migrations_dir: ../../packages/db/migrations` resolved by the wrangler CLI: **yes**, no
  fallback used. Both `wrangler d1 migrations list` and `wrangler d1 migrations apply` (against
  the local D1 in `.wrangler/state/v3/d1`) resolved the relative path directly and found/applied
  `0001_app_installation.sql`. The vitest integration fixture resolved the same relative path via
  `readD1Migrations("../../packages/db/migrations")`.
- No symlink fallback was required anywhere.
- Build output worker dir: **`dist/flare_idp`** (underscore, not hyphen) — the Cloudflare Vite
  plugin normalizes the wrangler `name` (`"flare-idp"`) into a valid JS identifier for the
  environment/output directory name. Any tooling that globs or references this path must use the
  underscore form.

## S2 — bundle + cold start

- Worker dist dir ships as multiple files: `dist/flare_idp/index.js` plus sibling chunks under
  `dist/flare_idp/assets/*.js` (the Vite Cloudflare plugin builds with `no_bundle: true`, so the
  Better-Auth/Kysely/D1 dependency graph is not concatenated into one file). Any size measurement
  must sum **all** `.js` files under the worker dir, not just the entry file.
- Entry JS raw bytes (sum of all `.js` under `dist/flare_idp/`): **2,630,348 bytes (~2.51 MiB)**.
- Entry JS gzip bytes (sum of all `.js` under `dist/flare_idp/`): **551,408 bytes (~538.5 KiB)**.
  Cross-checked against wrangler's own bundle report: `Bundle: 2568.70 KiB / gzip: 538.93 KiB`
  (matches within rounding).
- `wrangler check startup` (command used: `bunx wrangler check startup --config
  dist/flare_idp/wrangler.json --outfile "../../.startup-profile.cpuprofile"`, run against the
  Vite-built `dist/flare_idp/wrangler.json`, not the source `wrangler.jsonc`):
  - Profile window: 160.0 ms; sampled time: 148.1 ms.
  - **Active: 85.0 ms, including 4.3 ms garbage collection.**
  - Idle: 63.1 ms; samples: 77.
- Within budget: **yes**. Gzip size (~538.5–551.4 KB) is well under the 3 MB target (~5.6x
  headroom); startup CPU (85.0 ms) is well under both the 200 ms target and the platform's 400 ms
  hard limit. `check startup` emitted no violation/warning.
- Mitigation chosen: **none needed** — no bundle-size or CPU mitigation from the brief's
  candidate list (route splitting, `nodejs_compat` trimming, lazy key generation, etc.) was
  required. Confirmed as a bonus check that `jose`'s `generateKeyPair` (Better-Auth's JWT plugin,
  `createJwk`) runs lazily at first-sign time, not at module-eval/init time, so it does not
  inflate the measured startup cost even though it wasn't needed as a mitigation.

## S3 — passkey on workerd

- Registration options generate: **yes**. Response includes `challenge` (string), `rp: { name,
  id }` with `rp.id === "localhost"` (from `APP_URL`'s hostname), `user`, `pubKeyCredParams`,
  `timeout: 60000`, `attestation: "none"`, `excludeCredentials: []`,
  `authenticatorSelection`, `extensions: { credProps: true }`, `hints: []`.
- Authentication options generate **without a session** (discoverable-credential flow; only an
  `origin` header is required): **yes**. Response shape differs from registration —
  `{ rpId, challenge, timeout: 60000, userVerification: "preferred" }` (flat `rpId` string, no
  `rp`/`user`/`pubKeyCredParams`).
- Challenge cookie name (both flows): **`better-auth.better-auth-passkey`**
  (`Max-Age=300; Path=/; HttpOnly; SameSite=Lax`).
- Bogus/garbage attestation rejected with a clean `APIError` (not a raw crash): **yes**, exact
  observed values —
  - `.status`: `"INTERNAL_SERVER_ERROR"` (HTTP 500), the most generic of the candidate statuses.
  - `.body`: `{ "message": "Failed to verify registration", "code":
    "FAILED_TO_VERIFY_REGISTRATION" }`.
  - `listPasskeys` after the failed verification: `[]` (nothing persisted).
- **500-vs-4xx note**: malformed client-supplied attestation input surfaces as a 500
  (`INTERNAL_SERVER_ERROR`) from Better-Auth's passkey plugin, not a 4xx, even though the failure
  is entirely client-caused. Phase 1's facade must map this to a 400 for the SPA.
- No workerd-specific incompatibility found: SimpleWebAuthn's CBOR/COSE-key parsing and WebCrypto
  usage ran fine on workerd for the malformed-input path. A real (spec-valid) attestation from an
  actual/virtual authenticator was out of scope and not exercised.

## S4 — OAuth2/OIDC on D1

- Discovery issuer: **`baseURL + basePath`**, i.e. `http://localhost:8787/api/auth` — **not**
  bare `baseURL`. Better-Auth appends its default `basePath` (`/api/auth`) when deriving the OIDC
  issuer even though `baseURL` in `packages/api/src/auth.ts` is set to just the origin. The
  id_token's `iss` claim matches.
- Authorize/token/userinfo/refresh/replay results, all confirmed working end-to-end on D1:
  - Authorize (trusted client, `skip_consent: true`): `302` redirect to
    `<redirect_uri>?code=...&state=...&iss=<url-encoded issuer>` (RFC 9207 `iss` param appended).
  - Authorize (non-trusted client): `302` redirect to `/oauth/consent?...&sig=<hmac>` — the
    entire original authorize query is re-serialized, HMAC-signed, and appended as the consent
    page's own query string (not wrapped in an `oauth_query=` key).
  - Token (`POST /api/auth/oauth2/token`, `200`): keys `access_token, expires_in, expires_at,
    token_type ("Bearer"), refresh_token, scope, id_token`.
  - Userinfo (`GET /api/auth/oauth2/userinfo`, `200`, Bearer token): keys `sub, name, email,
    email_verified` (scope-dependent; `picture`/`given_name`/`family_name` present only if the
    user has values).
  - Refresh (`grant_type=refresh_token`): `200`, new `access_token`, and **rotated**
    `refresh_token` (confirmed `refreshed.refresh_token !== tokens.refresh_token`) — rotation is
    on by default.
  - Replay (reusing a consumed authorization code): `400 { "error": "invalid_grant",
    "error_description": "invalid code" }`. Verified for sequential redemption only; concurrent
    (racing) redemption was not tested.
  - id_token verified cryptographically against the live JWKS endpoint via `jose`; JWKS returns
    one EdDSA/Ed25519 (OKP) key (`{ keys: [{ alg: "EdDSA", crv: "Ed25519", kty: "OKP", x, kid
    }] }`), matching the `jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } })`
    config.
  - No D1 "no transactions" anomalies observed anywhere in this flow (client creation, authorize,
    consent, code issuance, token exchange, refresh, replay-rejection all completed correctly).
- `adminCreateOAuthClient` body shape that worked:
  ```json
  {
    "client_name": "first-party" | "third-party",
    "redirect_uris": ["http://localhost:3000/callback"],
    "token_endpoint_auth_method": "client_secret_basic",
    "application_type": "native",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "scope": "openid profile email offline_access",
    "skip_consent": true
  }
  ```
  `application_type: "native"` is **required** for loopback redirect URIs
  (`http://localhost:3000/callback`) — the default `application_type` is `"web"`, and web clients
  unconditionally reject loopback redirect URIs (even over https) per
  `validateClientRedirectUri` in `@better-auth/oauth-provider` (RFC 8252 §7.3 loopback interchange
  is reserved for native clients).
- Consent response shape (`POST /api/auth/oauth2/consent` via `auth.handler`, not the direct
  `auth.api.oauth2Consent(...)` call — see below):
  - Request: `{ "accept": true, "scope": "...", "oauth_query": "<the consent redirect's raw
    location.search, minus the leading '?'>" }`. `oauth_query` is required in practice (the
    endpoint's `before` hook throws `400 invalid_request: "missing oauth query"` without it) — it
    restores server-side pending-authorization state, not recoverable from the session/cookie
    alone.
  - Response (`200`): `{ "redirect": true, "url": "<redirect_uri>?code=...&state=...&iss=..." }`
    — matches the library's `OAuthRedirectResult` type, not the OpenAPI doc's `redirect_uri` key.
  - Consent redirect path observed: `/oauth/consent` (with the signed query string described
    above under discovery/authorize).
  - Calling `auth.api.oauth2Consent(...)` directly does not work in this spike environment
    (`consentEndpoint` re-invokes the authorize endpoint on the same `ctx`, which requires
    `ctx.request`, and content-negotiation for the re-entrant call didn't resolve to JSON); the
    spike routes the consent step through `auth.handler(new Request(...))` instead, which is also
    representative of how a real SPA facade would call it.
- `jose` version resolved: `6.2.9`.

## S5 — Email Service + Queue in miniflare

- `env.EMAIL.send(...)` result: **`{ messageId: "<...@example.com>" }`** — never `undefined`.
- `env.EMAIL_QUEUE.send(...)` result: **not** `undefined` — resolves a backlog-metrics envelope:
  `{ metadata: { metrics: { backlogBytes: 0, backlogCount: 0, oldestMessageTimestamp: undefined
  } } }`. Any production code calling `.send()` must not assume a void/undefined result.
- `getQueueResult(batch, ctx)` shape: `{ explicitAcks: string[], retryMessages: [] }`, as
  expected.
- Scheduled handler (`handleScheduled`) ran to completion without throwing (logs `{ event:
  "scheduled", cron, at }`).
- Extra miniflare config needed: **none**. Both `EMAIL` and `EMAIL_QUEUE` bindings worked on the
  first run, resolved automatically by `@cloudflare/vitest-plugin` from `apps/idp/wrangler.jsonc`'s
  existing `send_email: [{ name: "EMAIL" }]` and `queues.producers [{ binding: "EMAIL_QUEUE",
  queue: "flare-idp-email" }]` entries. No `miniflare.email`, `queueProducers`, or
  `queueConsumers` override was required.

## S6 — KV secondary storage

- Session cached in KV under the raw token: **yes**.
- D1 `session` row present with `storeSessionInDatabase: true`: **yes**.
- **Critical finding — Better-Auth's runtime Kysely migrator is broken against D1 out of the
  box.** `getMigrations()`'s `getDatabaseIndexes` unconditionally runs a `SELECT ... FROM
  sqlite_master JOIN pragma_index_list(...) JOIN pragma_index_info(...)` — D1's SQL authorizer
  rejects table-valued-function use of `pragma_index_list`/`pragma_index_info` inside a
  `SELECT...FROM...JOIN` with `D1_ERROR: not authorized: SQLITE_AUTH`, on every call. Confirmed
  workaround (spike-only, in the test helper `migrateSpikeDb`): drive the equivalent **statement**
  forms (`PRAGMA index_list("table")` / `PRAGMA index_info("index")`) directly via a `Proxy`
  around the D1 binding that intercepts only the blocked query and reconstructs the expected row
  shape; every other query passes through unmodified (with proxied methods explicitly `.bind()`-ed
  to the real D1 binding, since D1 rejects a foreign `this`). A second, related D1 restriction:
  PRAGMA introspection is also rejected against D1's own internal `_cf_%` tables, so the
  table-listing query must exclude `sqlite_%` and `_cf_%` prefixes.
- **Per-test isolation, corrected finding**: `@cloudflare/vitest-plugin`'s "isolated per-test
  storage" isolates storage **per test file**, not per `it()` block — there is no per-`it()`
  isolation for any binding (D1 or KV). A row written in one `it()` is visible to a later `it()`
  in the same file. The spike's helper (`migrateSpikeDb` → `dropExistingAuthTables`) is now
  self-cleaning: before each migration it drops every Better-Auth-managed table (the set derived
  from `getAuthTables(auth.options)`, imported from `better-auth/db` — not a hardcoded name list,
  so non-auth application tables are never touched) in reverse creation order (FK-referencing
  tables dropped before the tables they reference; `PRAGMA foreign_keys = OFF` does not persist
  across separate D1 `.prepare()` calls, so it does not help). Integration tests that assume a
  blank D1 across multiple `it()` blocks in one file must reset state themselves — the harness
  will not do it for them.

## S7 — cookie seam

- Cookie names observed:
  - Session: **`better-auth.session_token`**.
  - 2FA interim: **`better-auth.two_factor`** (value `2fa-<sessionId>.<hmac>`, URL-encoded,
    `Max-Age=600`, `HttpOnly`, `SameSite=Lax`, `Path=/`).
  - Passkey challenge: **`better-auth.better-auth-passkey`** (see S3).
  - Also observed (not asserted on by name in the spike tests, but present in the same
    `Set-Cookie` sequence): `better-auth.session_data`.
- When `signInEmail` returns `twoFactorRedirect: true`, the response **also clears**
  `better-auth.session_token` and `better-auth.session_data` (`Max-Age=0`) in the same response,
  in addition to setting `better-auth.two_factor`.
- `returnHeaders: true` forwards Set-Cookie for sign-in/2FA/sign-out: **yes** — all Set-Cookie
  headers (including the clearing ones above) were forwarded correctly via
  `response.headers.getSetCookie()`; none dropped or truncated.
- Real table names (via `sqlite_master`): `user`, `session`, `account`, `verification`, `jwks`,
  `twoFactor` (camelCase, not `two_factor`), `passkey`, `oauthClient`, `oauthResource`,
  `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`,
  `oauthClientAssertion`.
- `enableTwoFactor` response shape: `{ "method": "totp", "totpURI": "otpauth://totp/...",
  "backupCodes": [ /* 10 codes */ ] }`.
- `signInEmail`-with-2FA response shape: `{ "twoFactorRedirect": true, "twoFactorMethods":
  ["totp"] }` — the `twoFactorMethods` array tells the client which method(s) to prompt for.

## Controller-level facts (scaffold, tooling)

- `apps/idp/worker-configuration.d.ts` (generated by `wrangler types`) is **git-ignored**, not
  committed. Its content depends on machine-local state (whether `.dev.vars` exists locally), so
  it is not reproducible across machines/CI if tracked. `bun run typecheck` regenerates it before
  `tsc` runs (via `bun run --cwd apps/idp types`), so fresh clones and CI always get a correct
  copy without needing `.dev.vars`. Secrets (`AUTH_SECRET`, `SETUP_SECRET`) are typed
  independently via `apps/idp/src/env-secrets.d.ts` (a global `Cloudflare.Env` augmentation),
  so editor typechecking works regardless of local `.dev.vars` state; `SETUP_SECRET` is declared
  required (`string`), not optional, to avoid a TypeScript declaration-merging conflict with the
  `.dev.vars`-present generated shape.
- `bunfig.toml` uses `linker = "hoisted"` — bun 1.4's isolated-linker default broke the root
  single-`tsc` typecheck (packages resolving via the isolated linker's per-package `node_modules`
  are not visible to a single root-level `tsc` invocation across workspace packages).
- vitest has **three** projects in `apps/idp/vitest.config.ts`:
  - `unit` (jsdom) — DOM-based component tests.
  - `unit-fs` (node) — filesystem-reading config/migration-lint tests; needed because jsdom's
    `import.meta.url` is not a `file://` URL, so `readFileSync`-based tests must run under node.
  - `integration` (workerd, via `@cloudflare/vitest-plugin`) — spikes and worker-handler tests.
- `@cloudflare/vitest-plugin`'s `env`/`SELF` imports from `cloudflare:test` are `@deprecated` in
  favour of `cloudflare:workers` (`import { env } from "cloudflare:workers"`). Phase 0 still uses
  `cloudflare:workers` directly for the module-level `auth` singleton in `packages/api/src/app.ts`
  (`import { env } from "cloudflare:workers"; export const auth = createAuth(env as Env);`) — this
  worked on the first try, no lazy-singleton fallback was needed. `apps/idp/src/cloudflare-workers.d.ts`
  is a hand-written shim declaring the `cloudflare:workers` module, since wrangler 4.125's
  generated types do not include it.
- The `SecondaryStorage` type used by `kvSecondaryStorage` is not exported from `better-auth`'s
  public entry points; it lives at `@better-auth/core/db` (re-exported from
  `@better-auth/core/dist/db/index.d.mts`) and is declared as an explicit direct dependency of
  `packages/api` (not left as an implicit transitive/hoisted resolution).

## Consequences for Phase 1

- Phase 1 uses the **Drizzle adapter + drizzle-kit SQL migrations**, not Better-Auth's runtime
  Kysely migrator — S6's finding that the live differ is fundamentally incompatible with D1's
  PRAGMA authorizer (`SQLITE_AUTH` on `pragma_index_list`/`pragma_index_info` table-valued-function
  use) confirms this was the right call; the Proxy-based workaround in `migrateSpikeDb` is
  spike-only and must not be carried into production code.
- Keep `session.storeSessionInDatabase: true` and `verification.storeInDatabase: true` (S6
  confirmed both the KV cache and the D1 row are present and consistent); `rateLimit.storage`
  should **not** use the secondary storage (KV) — keep it on its own path, per the design's
  existing separation.
- Secrets (`AUTH_SECRET`, `SETUP_SECRET`) continue to be typed via `env-secrets.d.ts`, independent
  of `worker-configuration.d.ts`/`.dev.vars` presence.
- OIDC issuer will be `${APP_URL}/api/auth` by default (S4), not bare `${APP_URL}`. Phase 1 must
  decide between two options and document the choice before wiring root `.well-known` discovery:
  1. Accept the issuer with the `/api/auth` basePath, and add a root-level rewrite from
     `/.well-known/*` to Better-Auth's `/api/auth/.well-known/*` paths so OIDC clients resolving
     discovery from the bare origin still work.
  2. Configure Better-Auth's `basePath`/issuer so the mounted path and the issuer align without a
     root rewrite (e.g. mount at `/` or set an explicit issuer override), accepting whatever
     trade-off that has for the rest of the `/api/auth/*` route surface.
- The facade (Phase 5 API surface over Better-Auth) must map passkey verification failures from
  the raw `500 INTERNAL_SERVER_ERROR`/`FAILED_TO_VERIFY_REGISTRATION` Better-Auth returns (S3) to
  a client-appropriate `400` — the failure is entirely client-input-caused, not a server error.
- Integration tests must reset D1 state per test explicitly — `@cloudflare/vitest-plugin` isolates
  storage per **file**, not per `it()` block (S6, corrected finding); any test suite with multiple
  `it()` blocks sharing D1 state (e.g. a fixed test-user email) needs its own cleanup, matching
  the pattern now built into `migrateSpikeDb`/`dropExistingAuthTables`.
- `EMAIL_QUEUE.send()` returns a backlog-metrics envelope (`{ metadata: { metrics: { backlogBytes,
  backlogCount, oldestMessageTimestamp } } }`), not `undefined` (S5) — production code must not
  assert or rely on an undefined/void result.
- The consent flow needs the SPA to read `location.search` from the `/oauth/consent` redirect and
  forward it back verbatim as `oauth_query` in the consent POST body (S4) — it is not recoverable
  from the session/cookie alone, and the endpoint's `before` hook rejects the request without it.
- Loopback redirect URIs (`http://localhost:.../callback`, used by native/CLI-style clients)
  require `application_type: "native"` on the OAuth client at creation time (S4) — the default
  `application_type: "web"` unconditionally rejects loopback redirect URIs.
- Real cookie names (`better-auth.session_token`, `better-auth.session_data`,
  `better-auth.two_factor`, `better-auth.better-auth-passkey`) and real table names (S7, listed
  above) should be treated as the concrete contract for anything Phase 1 builds against the
  cookie/session seam (e.g. reverse-proxy cookie forwarding rules, admin table inspection tooling).
- Bundle size (~551 KB gzip) and cold-start CPU (85.0 ms) have comfortable headroom against the
  3 MB / 400 ms limits (S2); no mitigation is required going into Phase 1, but Phase 1 adds
  meaningfully more code (Drizzle schema, env validation, secure headers, rate limiter, OpenAPI/
  Scalar) and should re-measure with `apps/idp/scripts/check-startup.sh` before assuming the
  budget still holds.
