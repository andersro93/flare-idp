# flare-idp Phase 1 — DB, Production Better-Auth Core, Hono Facade Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 0 spike auth with the production identity core (Drizzle/D1 schema, `better-auth/minimal` + Drizzle adapter, invite-only, KV session cache) behind an allowlisted mount, and ship the first slice of the OpenAPI facade (health, setup, session, password, email-verification, account) with per-route contract tests, D1 rate limiting, queue-based email, cron housekeeping, and Scalar docs — all green under `bun run ci`.

**Architecture:** The SPA-facing API is our own `OpenAPIHono` app (`packages/api`); every handler calls `auth.api.*` server-side and forwards `Set-Cookie` (`returnHeaders: true`). Better-Auth's own HTTP handler serves ONLY an allowlist (Phase 1: `/api/auth/jwks`, plus the root `/.well-known/jwks.json` rewrite); everything else under `/api/auth/*` is 404. Schema lives in Drizzle (`packages/db`), generated for auth tables by the Better-Auth CLI from a dedicated gen-config, migrated by drizzle-kit SQL files applied with wrangler/`applyD1Migrations`. Email is enqueued to `EMAIL_QUEUE` and delivered by the same Worker's `queue()` handler through the `EMAIL` (send_email) binding. Housekeeping runs in `scheduled()`.

**Tech Stack:** additions this phase — `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10` (dev), `@hono/zod-openapi@1.6.1`, `zod@4.4.3`, `@scalar/hono-api-reference@0.11.16` + vendored `@scalar/api-reference` browser bundle, `@better-auth/drizzle-adapter@1.7.1`, Better-Auth CLI (`bun x auth@1.7.1`). Existing: better-auth 1.7.1, hono 4.13.3, `@cloudflare/vitest-plugin` 1.0.0.

**Spec:** `docs/superpowers/specs/2026-08-21-flare-idp-design.md` (Facade seam, Facade route families, Identity core, Security posture, Testing strategy; Phase 1 paragraph). **Measured constraints:** `docs/decisions.md` — especially “Consequences for Phase 1”.

## Global Constraints

- bun runner; exact pins: `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `@hono/zod-openapi@1.6.1`, `zod@4.4.3`, `@scalar/hono-api-reference@0.11.16`, `@better-auth/drizzle-adapter@1.7.1`, everything Better-Auth stays `1.7.1` in lockstep.
- Conventional Commits (hook + CI enforce): subjects ≤100 chars; use types `feat(api|db|email)`, `test`, `chore`, `docs`, `build`. NOTE: `feat`/`fix` commits will make release-please open a 0.2.0 release PR — that is expected and wanted.
- Error envelope for every non-2xx facade response: `{ "error": { "code": string, "message": string } }`. Codes used this phase: `invalid_request`, `invalid_credentials`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `invalid_token`, `email_not_verified` (reserved), `setup_already_complete`, `invalid_setup_secret`, `misconfigured`, `internal`.
- Better-Auth invariants (decisions.md): `drizzleAdapter(db, { provider: "sqlite", schema, transaction: false })`; `session.storeSessionInDatabase: true`; `verification.storeInDatabase: true`; Better-Auth `rateLimit.enabled: false` (our D1 limiter instead); KV = session read cache only; `advanced.database.generateId: "uuid"`; `ipAddressHeaders: ["cf-connecting-ip"]`; jwt issuer knob `jwt({ jwt: { issuer: env.APP_URL }, jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } })`.
- The Better-Auth HTTP handler is mounted ONLY for allowlisted paths; the allowlist is a named exported constant and has a contract test asserting every non-listed `/api/auth/*` path returns the 404 envelope.
- Migrations: drizzle-kit manages `packages/db/migrations` (numbering starts at `0000_`, `meta/` journal committed). The old hand-written `0001_app_installation.sql` is DELETED and regenerated as part of `0000_init` — allowed because nothing is deployed (D1 ids are placeholders). `migrations-lint.test.ts` is updated accordingly (start at 0000, sequential, no BEGIN/COMMIT/PRAGMA foreign_keys, no trailing comment line; ignore the `meta/` dir).
- Integration tests run in workerd and must reset D1 state themselves (isolation is per FILE): every integration test file uses `resetDatabase()` from the shared helpers in a `beforeEach`.
- Facade contract tests: for every route — success shape, error envelope shape + code, authz (401/403 where applicable), cookie forwarding where applicable, audit side-effect where specified.
- `apps/idp/wrangler.jsonc` gains `OUTBOUND_EMAIL_FROM` in `vars`; the wrangler contract test is updated in the same task. `.dev.vars.example` and `TEST_BINDINGS` gain it too.
- Every task ends with `bun run ci` green and a conventional commit with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never commit `.dev.vars`, `dist/`, `.wrangler/`, `worker-configuration.d.ts`, `*.cpuprofile`.

---

## File structure created/changed by this plan

```
packages/db/
  package.json                      # + drizzle-orm 0.45.2 (dep), drizzle-kit 0.31.10 (dev)
  drizzle.config.ts                 # schema ./src/schema/index.ts, out ./migrations, dialect sqlite
  gen/betterauth-schema.config.ts   # schema-generation-only Better-Auth config (CLI input)
  src/schema/auth.ts                # GENERATED by `bun x auth generate` (user, session, account, verification, jwks)
  src/schema/app.ts                 # app_installation, app_settings, audit_events, rate_limit
  src/schema/index.ts               # re-exports both
  src/client.ts                     # dbFor(d1) → drizzle(d1, { schema })
  src/repositories/audit.ts         # recordAuditEvent (never throws), listAuditEvents (paged)
  src/repositories/installation.ts  # getInstallation, claimInstallation, completeInstallation
  src/repositories/settings.ts      # getSettings, putSettings (single row)
  migrations/0000_init.sql + migrations/meta/*   # drizzle-kit managed (0001_app_installation.sql DELETED)
packages/shared/src/
  index.ts  errors.ts  roles.ts  schemas.ts     # error codes, ROLES, zod DTOs (plain zod)
packages/email/
  package.json (no new deps)  src/index.ts  src/types.ts  src/render.ts
  src/senders.ts                    # queueEmailSender(queue), cloudflareEmailSender(email, from), captureEmailSender()
  src/templates/*.ts                # escapeHtml + reset-password, verify-email, invite-set-password
packages/api/
  package.json                      # + @flare-idp/db, @flare-idp/email, @flare-idp/shared (workspace:*), @hono/zod-openapi, zod, @scalar/hono-api-reference; − @better-auth/oauth-provider, @better-auth/passkey (return in Phases 2/5); + @better-auth/drizzle-adapter
  src/auth/auth.ts                  # PRODUCTION createAuth(env, deps?, opts?) + singleton (replaces spike src/auth.ts)
  src/auth/forward.ts               # callAuth(c, fn) cookie seam + mapAuthError(APIError) → envelope
  src/kv-secondary-storage.ts       # unchanged
  src/http/env.ts  src/http/log.ts  src/http/errors.ts
  src/http/security/{origin.ts,compare.ts,rate-limit.ts}
  src/http/middleware/{session.ts,require-auth.ts,require-admin.ts}
  src/http/app.ts                   # OpenAPIHono app, middleware order, allowlist mount, doc31, Scalar, AppType (replaces spike src/app.ts)
  src/routes/{health.ts,setup.ts,session.ts,password.ts,email-verification.ts,account.ts}
  src/jobs/housekeeping.ts  src/queue/email-consumer.ts
  src/handlers.ts                   # wires scheduled → housekeeping, queue → email consumer
  src/index.ts                      # exports app, AppType, auth, createAuth, handleScheduled, handleQueue
apps/idp/
  wrangler.jsonc                    # vars + OUTBOUND_EMAIL_FROM
  vitest.config.ts                  # drop test/spikes include; TEST_BINDINGS + OUTBOUND_EMAIL_FROM
  public/vendor/scalar/…            # vendored standalone.esm.js + chunks (committed)
  scripts/vendor-scalar.ts          # refresh script (bun)
  src/client/… (unchanged)  .dev.vars.example (+OUTBOUND_EMAIL_FROM)
  test/integration/helpers/{cookies.ts,db.ts,http.ts}   # CookieJar moves here; resetDatabase; setup/signIn helpers
  test/integration/*.test.ts        # per-route contract tests (see tasks)
  test/spikes/                      # DELETED (findings live in docs/decisions.md; s2 script stays in scripts/)
docs/decisions.md                   # Phase 1 addendum (issuer choice, re-measured startup numbers)
README.md                           # roadmap row Phase 1 → done
```

Deletions: `packages/api/src/auth.ts` (spike), `packages/api/src/app.ts` (spike — replaced under `src/http/app.ts`), `apps/idp/test/spikes/**` (except `helpers/cookies.ts` which MOVES to `test/integration/helpers/cookies.ts` unchanged), `packages/db/migrations/0001_app_installation.sql`.

## Core contracts (used by every task)

**AppEnv** (defined in `packages/api/src/http/app.ts`, imported by routes/middleware):
```ts
import type { Session, User } from "better-auth";
export type SessionUser = User & { role: string };
export type AppVariables = { user: SessionUser | null; session: Session | null };
export type AppEnv = { Bindings: Env; Variables: AppVariables };
```

**Error envelope + helpers** (`packages/api/src/http/errors.ts`):
```ts
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "invalid_request" | "invalid_credentials" | "unauthorized" | "forbidden"
  | "not_found" | "rate_limited" | "invalid_token" | "email_not_verified"
  | "setup_already_complete" | "invalid_setup_secret" | "misconfigured" | "internal";

export type ErrorBody = { error: { code: ErrorCode; message: string } };

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

export class AppError extends HTTPException {
  readonly code: ErrorCode;
  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(status, { message });
    this.code = code;
  }
}

/** Global onError: AppError → its envelope; anything else → 500 `internal` (message not leaked). */
export function handleApiError(err: unknown, c: Context): Response { /* full impl in Task 4 */ }
```
Zod validation failures use `@hono/zod-openapi`'s `defaultHook` (set once on every `OpenAPIHono` instance via a shared `newRouter()` factory in `app.ts`) returning 400 `errorBody("invalid_request", firstIssueMessage)`.

**Facade seam** (`packages/api/src/auth/forward.ts`):
```ts
import { APIError } from "better-auth";           // verify export; fallback: import { APIError } from "better-call"
import type { Context } from "hono";
import { AppError } from "../http/errors";

/** Run a Better-Auth server call and forward its Set-Cookie headers onto our response. */
export async function callAuth<T>(
  c: Context,
  fn: () => Promise<{ headers: Headers; response: T }>,
): Promise<T> {
  try {
    const { headers, response } = await fn();
    for (const cookie of headers.getSetCookie()) c.header("Set-Cookie", cookie, { append: true });
    return response;
  } catch (error) {
    throw mapAuthError(error);
  }
}

/** Map Better-Auth APIError statuses to our envelope codes; rethrow anything else. */
export function mapAuthError(error: unknown): unknown {
  if (!(error instanceof APIError)) return error;
  const message = error.body?.message ?? error.message ?? "Authentication error";
  switch (error.status) {
    case "UNAUTHORIZED":          return new AppError(401, "invalid_credentials", message);
    case "FORBIDDEN":             return new AppError(403, "forbidden", message);
    case "NOT_FOUND":             return new AppError(404, "not_found", message);
    case "TOO_MANY_REQUESTS":     return new AppError(429, "rate_limited", message);
    case "BAD_REQUEST":           return new AppError(400, "invalid_request", message);
    default:                      return new AppError(400, "invalid_request", message);
  }
}
```
(Token-related BAD_REQUESTs from reset/verify flows are re-mapped to `invalid_token` at the route level where the semantics are known.)

**Route module pattern** (avoids the `.use().openapi()` typing bug; identical in every `src/routes/*.ts`):
```ts
import { createRoute, z } from "@hono/zod-openapi";
import { newRouter } from "../http/app-shared";   // OpenAPIHono<AppEnv> factory with defaultHook
export const healthRoutes = newRouter();
const live = createRoute({ method: "get", path: "/live", responses: { 200: { description: "ok", content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } } } } });
healthRoutes.openapi(live, (c) => c.json({ status: "ok" as const }, 200));
```
`app.ts` chains ONLY `.route()` calls for the `AppType` export:
```ts
const routes = app
  .route("/api/health", healthRoutes)
  .route("/api/setup", setupRoutes)
  .route("/api/session", sessionRoutes)
  .route("/api/auth/password", passwordRoutes)
  .route("/api/auth/email", emailVerificationRoutes)
  .route("/api/account", accountRoutes);
export type AppType = typeof routes;
```
(`/api/auth/password/*` and `/api/auth/email/*` are OUR routes; the allowlist check for the Better-Auth handler runs on the exact-path allowlist BEFORE the generic `/api/auth/*` 404, and our routes are registered on the router, so they never collide — the Better-Auth mount is registered AFTER `.route()` calls and only matches its allowlist.)

**Auth mount + allowlist + rewrites** (in `app.ts`, after the `.route()` chain):
```ts
export const BETTER_AUTH_ALLOWLIST = ["/api/auth/jwks"] as const;   // Phase 2 adds /oauth2/* + .well-known; Phase 5 adds /callback/:provider
app.on(["GET", "POST"], "/api/auth/*", (c, next) => {
  if ((BETTER_AUTH_ALLOWLIST as readonly string[]).includes(c.req.path)) return auth.handler(c.req.raw);
  return next();                                   // falls through to the /api/* 404 envelope
});
app.get("/.well-known/jwks.json", (c) => {
  const url = new URL(c.req.url); url.pathname = "/api/auth/jwks";
  return auth.handler(new Request(url, c.req.raw));
});
app.all("/api/*", (c) => c.json(errorBody("not_found", "Not found"), 404));
app.get("*", async (c) => { const r = await c.env.ASSETS.fetch(c.req.raw); return new Response(r.body, r); });
app.onError(handleApiError);
```

**Middleware order in `app.ts`** (each `app.use(...)` a separate statement, before the `.route()` chain): `secureHeaders` (strict CSP everywhere; a second, route-scoped `secureHeaders` on `/api/docs` relaxes `styleSrc` to `'self' 'unsafe-inline'` and keeps `scriptSrc 'self'`) → `cors` on `/api/*` (origin = `corsOriginFor(env, origin)`, credentials true) → `rejectCrossSiteMutations` on `/api/*` → env validation (503 `misconfigured` envelope; `/api/health/live` exempt) → `logFailedApiRequests` → `loadSession` (sets `user`/`session` vars via `auth.api.getSession({ headers })`; never throws).

**Test helpers** (`apps/idp/test/integration/helpers/db.ts` + `http.ts`; `cookies.ts` is the Phase 0 `CookieJar`, moved verbatim):
```ts
// db.ts
import { env } from "cloudflare:test";
/** Children before parents; extend when new tables land in later phases. */
export const RESET_ORDER = ["audit_events", "rate_limit", "jwks", "verification", "account", "session", "user", "app_settings"] as const;
export async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    ...RESET_ORDER.map((t) => env.DB.prepare(`DELETE FROM "${t}"`)),
    env.DB.prepare(`UPDATE app_installation SET status = 'pending', owner_user_id = NULL, owner_email = NULL, completed_at = NULL WHERE id = 1`),
  ]);
}
// http.ts
import { SELF } from "cloudflare:test";
import { CookieJar } from "./cookies";
export const TEST_ORIGIN = "http://localhost:8787";
export async function api(path: string, init: RequestInit = {}, jar?: CookieJar): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", TEST_ORIGIN);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (jar) headers.set("cookie", jar.header());
  const res = await SELF.fetch(`${TEST_ORIGIN}${path}`, { ...init, headers });
  jar?.absorb(res.headers);
  return res;
}
export const SETUP_ADMIN = { email: "admin@example.com", password: "correct-horse-battery-staple", name: "Admin" };
/** POST /api/setup/complete with SETUP_SECRET; returns a jar holding the admin session. */
export async function completeSetup(jar = new CookieJar()): Promise<CookieJar> {
  const res = await api("/api/setup/complete", { method: "POST", body: JSON.stringify({ secret: "test-setup-secret", ...SETUP_ADMIN }) }, jar);
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  return jar;
}
export async function signIn(email: string, password: string, jar = new CookieJar()): Promise<{ jar: CookieJar; res: Response }> {
  const res = await api("/api/session/sign-in/password", { method: "POST", body: JSON.stringify({ email, password }) }, jar);
  return { jar, res };
}
```
Every integration test file: `beforeEach(resetDatabase)`.

---

### Task 1: Drizzle schema, generated auth tables, drizzle-kit migrations reset, repositories

**Files:**
- Modify: `packages/db/package.json` (deps `drizzle-orm@0.45.2`, `@flare-idp/shared workspace:*`? no — db stays dependency-free besides drizzle; devDeps `drizzle-kit@0.31.10`; scripts `"generate": "drizzle-kit generate"`, `"generate:auth": "bun x auth@1.7.1 generate --config gen/betterauth-schema.config.ts --output src/schema/auth.ts -y"`)
- Create: `packages/db/drizzle.config.ts`, `packages/db/gen/betterauth-schema.config.ts`, `packages/db/src/schema/{auth.ts (generated),app.ts,index.ts}`, `packages/db/src/client.ts`, `packages/db/src/repositories/{audit.ts,installation.ts,settings.ts}`, `packages/db/src/index.ts`
- Create: `packages/db/migrations/0000_init.sql` + `packages/db/migrations/meta/{_journal.json,0000_snapshot.json}` (via drizzle-kit)
- Delete: `packages/db/migrations/0001_app_installation.sql`
- Modify: `apps/idp/test/unit/migrations-lint.test.ts` (start at **0000**, ignore `meta/`), `apps/idp/test/integration/health.test.ts` (unchanged assertions still pass — verify)
- Test: `apps/idp/test/integration/db-repositories.test.ts`

**Interfaces:**
- Produces: `dbFor(d1: D1Database)` (drizzle instance with full schema), `schema` (namespace export), `recordAuditEvent(db, event)` (never throws), `listAuditEvents(db, { limit, cursor?, event? })`, `getInstallation(db)`, `claimInstallation(db)` → boolean, `completeInstallation(db, { userId, email })`, `getSettings(db)`, `putSettings(db, json)`. Tables: generated `user` (with admin plugin fields `role`, `banned`, `banReason`, `banExpires`), `session` (with `impersonatedBy`), `account`, `verification`, `jwks`; app tables below.
- Consumes: nothing new.

- [ ] **Step 1: deps + configs**

`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "sqlite",
  strict: true,
  verbose: true,
});
```
`packages/db/gen/betterauth-schema.config.ts` (schema depends only on plugins/options — env values are irrelevant here; KEEP IN SYNC with `packages/api/src/auth/auth.ts` plugin list, a comment in both files says so):
```ts
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { admin, jwt } from "better-auth/plugins";

/** Schema-generation-only config for `bun x auth generate`. Not imported at runtime. */
export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  session: { storeSessionInDatabase: true },
  advanced: { database: { generateId: "uuid" } },
  plugins: [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
  ],
});
```
Add `@better-auth/drizzle-adapter@1.7.1` + `better-auth@1.7.1` to `packages/db` devDependencies (needed only by the gen config + CLI). Run `bun install`.

- [ ] **Step 2: generate auth schema, write app schema**

Run `bun run --cwd packages/db generate:auth` → writes `src/schema/auth.ts` (probe-verified output: `user`, `session`, `account`, `verification`, `jwks` sqliteTables + relations, importing from `drizzle-orm/sqlite-core`). Commit the file as generated (Biome may reformat — fine). Add a header comment: `// GENERATED by \`bun run generate:auth\` — do not edit by hand; regenerate when the plugin list in gen/betterauth-schema.config.ts changes.`

`packages/db/src/schema/app.ts`:
```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** First-run state; a single row (id = 1) seeded by the init migration. */
export const appInstallation = sqliteTable("app_installation", {
  id: integer("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  ownerUserId: text("owner_user_id"),
  ownerEmail: text("owner_email"),
  completedAt: integer("completed_at"),
});

/** Single-row instance settings (id = 1), JSON blob validated by @flare-idp/shared. */
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  settings: text("settings").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull().default(0),
});

/** Security/audit events. Append-only; pruned by the housekeeping cron. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    event: text("event").notNull(),
    actorUserId: text("actor_user_id"),
    actorIp: text("actor_ip"),
    target: text("target"),
    details: text("details"),
  },
  (t) => [index("audit_events_at_idx").on(t.at), index("audit_events_event_idx").on(t.event)],
);

/** Fixed-window rate-limit counters (see packages/api http/security/rate-limit.ts). */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});
```
`src/schema/index.ts` re-exports both files. `src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
export function dbFor(d1: D1Database) { return drizzle(d1, { schema }); }
export type AppDatabase = ReturnType<typeof dbFor>;
export { schema };
```
(Type note: `D1Database` comes from the generated worker types at the app level; inside `packages/db` add `/// <reference types="@cloudflare/workers-types" />`? NO — do not add workers-types (conflicts with generated runtime types). The root tsconfig already includes the generated `worker-configuration.d.ts` globally, so `D1Database` resolves. Verify with `bun run typecheck`.)

- [ ] **Step 3: reset migrations**

Delete `packages/db/migrations/0001_app_installation.sql`. Run `bun run --cwd packages/db generate -- --name init` (drizzle-kit) → `migrations/0000_init.sql` + `meta/`. APPEND to `0000_init.sql` (drizzle-kit only emits DDL; seeds are ours — keep at end, NOT as a trailing comment line):
```sql
--> statement-breakpoint
INSERT INTO `app_installation` (`id`, `status`) VALUES (1, 'pending');
--> statement-breakpoint
INSERT INTO `app_settings` (`id`, `settings`, `updated_at`) VALUES (1, '{}', 0);
```
(If drizzle-kit's snapshot/journal make appended SQL awkward on the NEXT generate, that is fine — later generates diff against the snapshot, which knows nothing of data rows.)

- [ ] **Step 4: repositories** — implement with drizzle query API; `recordAuditEvent` wraps its insert in try/catch and `console.log`s a JSON error line instead of throwing; `claimInstallation` is the atomic claim: `UPDATE app_installation SET status = 'in_progress' WHERE id = 1 AND status = 'pending'` via `db.run(sql\`...\`)` checking `meta.changes === 1` (raw statement — drizzle `.run()` result exposes `meta`); `completeInstallation` sets status `complete`, owner fields, `completed_at = Date.now()`.

- [ ] **Step 5: update lint test + write repo tests, run, commit**

`migrations-lint.test.ts` changes: numbering starts at `0000`; `readdirSync` filter skips directories (`meta`); everything else unchanged. New `db-repositories.test.ts` (integration): resetDatabase beforeEach; audit insert + list with filter + cursor; installation claim is single-shot (second claim false); settings roundtrip. Run `bun run --cwd apps/idp test`, `bunx wrangler d1 migrations list flare-idp --local` from `apps/idp` (expect `0000_init.sql`; delete `.wrangler/state` first if the old 0001 is recorded: `rm -rf apps/idp/.wrangler/state`), then `bun run ci`.

Commit: `feat(db): drizzle schema with generated better-auth tables and drizzle-kit migrations`

---

### Task 2: Shared package (error codes, roles, DTO schemas)

**Files:** Create `packages/shared/src/{errors.ts,roles.ts,schemas.ts}`, modify `packages/shared/src/index.ts`, `packages/shared/package.json` (+ dep `zod@4.4.3`). Test: `apps/idp/test/unit/shared-schemas.test.ts` (unit project).

**Interfaces (produces):**
```ts
// errors.ts — the ErrorCode union + errorBodySchema (zod) matching the envelope
export const ERROR_CODES = ["invalid_request","invalid_credentials","unauthorized","forbidden","not_found","rate_limited","invalid_token","email_not_verified","setup_already_complete","invalid_setup_secret","misconfigured","internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const errorBodySchema = z.object({ error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }) });
// roles.ts
export const ROLES = ["admin", "user"] as const; export type Role = (typeof ROLES)[number];
// schemas.ts — plain zod v4 (no .openapi() here; routes add metadata)
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
export const passwordSchema = z.string().min(12).max(128);
export const nameSchema = z.string().trim().min(1).max(100);
export const setupCompleteSchema = z.object({ secret: z.string().min(1), email: emailSchema, password: passwordSchema, name: nameSchema });
export const signInSchema = z.object({ email: emailSchema, password: z.string().min(1) });
export const passwordForgotSchema = z.object({ email: emailSchema });
export const passwordResetSchema = z.object({ token: z.string().min(1), password: passwordSchema });
export const passwordChangeSchema = z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema, revokeOtherSessions: z.boolean().default(true) });
export const emailVerifySchema = z.object({ token: z.string().min(1) });
export const profilePatchSchema = z.object({ name: nameSchema.optional(), image: z.union([z.url(), z.null()]).optional() }).refine((v) => Object.keys(v).length > 0, "empty patch");
export const sessionUserSchema = z.object({ id: z.string(), email: z.string(), name: z.string(), image: z.string().nullable().optional(), emailVerified: z.boolean(), role: z.enum(ROLES).catch("user"), createdAt: z.coerce.date() });
export const sessionInfoSchema = z.object({ id: z.string(), createdAt: z.coerce.date(), expiresAt: z.coerce.date(), userAgent: z.string().nullable().optional(), ipAddress: z.string().nullable().optional(), current: z.boolean() });
```
`errorBodySchema` in shared and `ErrorBody` in `packages/api/src/http/errors.ts` must agree — the api package imports `ErrorCode`/`ERROR_CODES` FROM shared (single source; adjust the Task 4 file to import instead of redeclare).

Steps: write failing unit tests (schema accept/reject cases: email lowercasing, password length, empty patch refusal, error envelope parse) → implement → `bun run ci` → commit `feat(shared): error codes, roles and request/response schemas`.

---

### Task 3: Email package (types, templates, senders)

**Files:** Create `packages/email/src/{types.ts,render.ts,senders.ts,templates/reset-password.ts,templates/verify-email.ts,templates/invite-set-password.ts,templates/escape.ts}`; rewrite `packages/email/src/index.ts` (exports). Test: `apps/idp/test/unit/email-render.test.ts` (unit project).

**Interfaces (produces):**
```ts
// types.ts
export type EmailJob =
  | { kind: "reset-password"; to: string; recipientName: string; url: string }
  | { kind: "verify-email"; to: string; recipientName: string; url: string }
  | { kind: "invite-set-password"; to: string; recipientName: string; url: string; invitedBy: string };
export type RenderedEmail = { subject: string; text: string; html: string };
export interface EmailSender { send(job: EmailJob): Promise<void> }
// render.ts
export function renderEmail(job: EmailJob, appName: string): RenderedEmail;
// senders.ts
export function queueEmailSender(queue: Queue<EmailJob>): EmailSender;              // queue.send(job) — returns metrics envelope, DO NOT assert undefined
export function cloudflareEmailSender(email: SendEmail, from: string, appName: string): EmailSender;  // renders + email.send({ from, to, subject, text, html })
export function captureEmailSender(): EmailSender & { readonly jobs: EmailJob[] };  // test helper
```
Templates use `escapeHtml` (port the mi-casa implementation verbatim from `/home/anders/projects/privat/mi-casa-su-casa/src/server/email/sender.ts` — the `escapeHtml` function and the plain-text+HTML dual-body style; adapt copy to flare-idp). Every template: subject mentions the app name; text body lists the URL plainly; html links it; "if you did not request this, ignore" line on reset/verify.

Steps: failing render tests (escaping of `<script>` in names, both bodies contain URL, subjects) → implement → ci → commit `feat(email): email job types, templates and queue/cloudflare senders`.

---

### Task 4: HTTP core (env, log, errors, origin/CSRF, constant-time compare, D1 rate limiter, session middleware)

**Files:** Create `packages/api/src/http/{env.ts,log.ts,errors.ts}`, `packages/api/src/http/security/{origin.ts,compare.ts,rate-limit.ts}`, `packages/api/src/http/middleware/{session.ts,require-auth.ts,require-admin.ts}`, `packages/api/src/auth/forward.ts`. Modify `packages/api/package.json` (add `@flare-idp/db`, `@flare-idp/email`, `@flare-idp/shared` as `workspace:*`, `@hono/zod-openapi@1.6.1`, `zod@4.4.3`, `@scalar/hono-api-reference@0.11.16`, `@better-auth/drizzle-adapter@1.7.1`; REMOVE `@better-auth/oauth-provider`, `@better-auth/passkey`). Modify `apps/idp/wrangler.jsonc` (`vars.OUTBOUND_EMAIL_FROM: "noreply@example.com"`), `apps/idp/.dev.vars.example` (+`# OUTBOUND_EMAIL_FROM is a var in wrangler.jsonc for dev`… no: it IS a var, nothing to add — instead add a comment), `apps/idp/vitest.config.ts` (`TEST_BINDINGS.OUTBOUND_EMAIL_FROM: "noreply@example.com"`), `apps/idp/test/unit/wrangler-config.test.ts` (assert the new var exists in `vars`).
Tests: `apps/idp/test/unit/env-validation.test.ts`, `apps/idp/test/unit/origin-policy.test.ts`, `apps/idp/test/unit/secrets-compare.test.ts` (all `unit` project — pure functions), `apps/idp/test/integration/rate-limit.test.ts`.

**Interfaces (produces):**
- `validateEnv(env)` → `{ ok: true } | { ok: false; problems: { key, message }[] }`; `assertValidEnv(env)` throws `EnvValidationError`. Required: `APP_NAME`, `APP_URL` (absolute; https outside development/test), `AUTH_SECRET` (≥32), `OUTBOUND_EMAIL_FROM`, bindings `DB`, `KV`, `EMAIL`, `EMAIL_QUEUE`, `ASSETS`. `SETUP_SECRET` optional (setup route 503s without it). Port the mi-casa `validateEnv` structure (`/home/anders/projects/privat/mi-casa-su-casa/src/server/runtime/env.ts`), adjusted to these keys.
- `logEvent(level, event, fields)` + `logFailedApiRequests` middleware (port from mi-casa `runtime/log.ts`; JSON lines; logs non-2xx API responses with path/status/duration, never bodies).
- `corsOriginFor(env, origin)` and `rejectCrossSiteMutations` (port mi-casa `security/origin.ts`: same-origin or APP_URL; mutations with a foreign/absent Origin get 403 envelope `forbidden`; GET/HEAD/OPTIONS pass). `secretsEqual(a, b)` (port `security/compare.ts`, `crypto.subtle.timingSafeEqual`-based or constant-time loop).
- Rate limiter (port mi-casa `security/rate-limit.ts` onto the drizzle `rate_limit` table via raw `env.DB.prepare` upsert — keep the single-statement `INSERT ... ON CONFLICT ... RETURNING` shape verbatim, table/cols `rate_limit(id, key, count, last_request)`):
  `consumeRateLimit(db: D1Database, rule, clientKey)`, `rateLimit(rule, keyFn?)` Hono middleware returning 429 envelope `rate_limited` with `Retry-After`, and
  `export const RATE_LIMITS = { setup: { name: "setup", windowSeconds: 900, max: 5 }, signIn: { name: "sign-in", windowSeconds: 60, max: 5 }, passwordForgot: { name: "pw-forgot", windowSeconds: 300, max: 3 }, passwordReset: { name: "pw-reset", windowSeconds: 300, max: 5 }, emailVerify: { name: "email-verify", windowSeconds: 300, max: 10 } } as const;`
  Default key = `cf-connecting-ip` (fallback "unknown"); `signIn` uses ip+email composite via `keyFn`.
- `loadSession` middleware (sets `user`/`session` vars; role defaults `"user"`), `requireAuth` (401 envelope), `requireAdmin` (403 envelope).
- `callAuth` + `mapAuthError` per the Core contracts section (verify the `APIError` import path: `grep -rn "class APIError" node_modules/better-auth/dist | head` — likely re-exported from `better-auth/api`; use the first public path that typechecks).
- `errors.ts` per Core contracts, importing `ErrorCode`/`ERROR_CODES` from `@flare-idp/shared`; `handleApiError` full implementation: `AppError` → `c.json(errorBody(err.code, err.message), err.status)`; `HTTPException` → mapped to nearest code (401→`unauthorized`, 404→`not_found`, else `invalid_request`); unknown → `logEvent("error", "unhandled_error", …)` + 500 `internal` "Internal error".

Note: these modules are pure (no `cloudflare:workers` import) so unit tests can run in the `unit` project; only `rate-limit` needs real D1 → integration test (window rollover, composite keys, 429 + Retry-After through a probe route? No probe route exists yet — test `consumeRateLimit` directly against `env.DB`, middleware behaviour is covered in Task 6's setup tests).

Steps: failing unit tests → implement → integration rate-limit test → `bun run ci` → commit `feat(api): http core — env validation, security middleware, D1 rate limiter, error envelope`.

---

### Task 5: Production auth core + app skeleton + worker handlers (+ delete spikes)

**Files:**
- Create: `packages/api/src/auth/auth.ts`, `packages/api/src/http/app.ts`, `packages/api/src/http/app-shared.ts` (`newRouter()` factory + `AppEnv` types + `defaultHook`), `packages/api/src/jobs/housekeeping.ts`, `packages/api/src/queue/email-consumer.ts`, `packages/api/src/routes/health.ts`
- Delete: `packages/api/src/auth.ts`, `packages/api/src/app.ts` (spike files), `apps/idp/test/spikes/` (ALL — first move `helpers/cookies.ts` → `apps/idp/test/integration/helpers/cookies.ts` verbatim)
- Create: `apps/idp/test/integration/helpers/{db.ts,http.ts}` (Core contracts section, verbatim)
- Modify: `packages/api/src/handlers.ts`, `packages/api/src/index.ts`, `apps/idp/vitest.config.ts` (remove `test/spikes/**` from include), `apps/idp/test/integration/health.test.ts` (keep; assertions must still pass), `apps/idp/test/integration/worker-handlers.test.ts` (queue test now feeds an `EmailJob` batch and asserts ack; scheduled test still completes)
- Tests: `apps/idp/test/integration/{security-headers.test.ts,allowlist.test.ts,email-consumer.test.ts,housekeeping.test.ts}`

**Interfaces:**
- Produces: `createAuth(env, deps?: { emailSender?: EmailSender }, opts?: { allowSignUp?: boolean })` and singleton `auth` (module scope, `import { env } from "cloudflare:workers"`, `queueEmailSender(env.EMAIL_QUEUE)`); `app`, `AppType`, `BETTER_AUTH_ALLOWLIST`; `handleScheduled(controller, env)` (housekeeping), `handleQueue(batch: MessageBatch<EmailJob>, env)` (delivers via `cloudflareEmailSender(env.EMAIL, env.OUTBOUND_EMAIL_FROM, env.APP_NAME)`, `message.ack()` on success, `message.retry()` on error).
- Consumes: Task 1 `dbFor`/`schema`, Task 3 senders/types, Task 4 everything.

- [ ] **Step 1: production `auth.ts`** (replaces the spike file; keep the plugin list in sync with `packages/db/gen/betterauth-schema.config.ts` — cross-reference comment in both):
```ts
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { admin, jwt } from "better-auth/plugins";
import { dbFor, schema } from "@flare-idp/db";
import { type EmailSender, queueEmailSender } from "@flare-idp/email";
import { kvSecondaryStorage } from "../kv-secondary-storage";

export type CreateAuthDeps = { emailSender?: EmailSender };
export type CreateAuthOptions = { allowSignUp?: boolean };

export function createAuth(env: Env, deps: CreateAuthDeps = {}, opts: CreateAuthOptions = {}) {
  const sender = deps.emailSender ?? queueEmailSender(env.EMAIL_QUEUE);
  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(dbFor(env.DB), { provider: "sqlite", schema, transaction: false }),
    secondaryStorage: kvSecondaryStorage(env.KV),
    session: { storeSessionInDatabase: true, expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24, cookieCache: { enabled: true, maxAge: 300 } },
    verification: { storeInDatabase: true },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !opts.allowSignUp,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sender.send({ kind: "reset-password", to: user.email, recipientName: user.name ?? user.email, url });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sender.send({ kind: "verify-email", to: user.email, recipientName: user.name ?? user.email, url });
      },
    },
    rateLimit: { enabled: false },   // our D1 limiter guards the facade; Better-Auth's own only sees allowlisted routes
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test",
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      // issuer knob (decisions.md, recommended option 1): bare-origin OIDC issuer, keeps /api/auth mount.
      jwt({ jwt: { issuer: env.APP_URL }, jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;
```
If `jwt({ jwt: { issuer } })` is not a valid option shape, check `node_modules/better-auth/dist/plugins/jwt/index.d.mts` for the exact key (the option group is documented as `jwt: { issuer, audience, expirationTime, definePayload }`) and report what you found.
- [ ] **Step 2: `app-shared.ts` + `app.ts`** per the Core contracts (middleware order, allowlist mount, `.well-known/jwks.json` rewrite, `doc31` at `/api/openapi.json` with `info { title: "flare-idp", version: "0.2.0" }`… use the version from root `package.json` via a `const` import? JSON import in workerd bundle is fine: `import pkg from "../../../../package.json" with { type: "json" }` is brittle across the workspace — instead hard-code `version: "0"` plus `x-phase: 1`? NO placeholders: use `info: { title: "flare-idp", version: "0.1.0" }` and add a `// TODO release automation` NOWHERE — decision: read it from a new `packages/api/src/version.ts` exporting `export const API_VERSION = "0.1.0";` with a comment that release-please's extra-files could bump it later; keep it simple and static). Scalar at `/api/docs`: `Scalar({ url: "/api/openapi.json", cdn: "/vendor/scalar/standalone.esm.js" })` — **verify** how the helper injects the script: read `node_modules/@scalar/client-side-rendering/dist/*` for the script-tag shape; the vendored bundle is an ES module, so if the injected tag is not `type="module"`, hand-render the docs page instead:
```ts
app.get("/api/docs", (c) => c.html(`<!doctype html><html><head><title>flare-idp API</title><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="app"></div><script type="module">import { createApiReference } from "/vendor/scalar/standalone.esm.js"; createApiReference("#app", { url: "/api/openapi.json" });</script></body></html>`));
```
(One of the two MUST work; record which in the report. Acceptance: `/api/docs` returns 200 HTML referencing ONLY same-origin assets.)
- [ ] **Step 3: vendor the Scalar bundle** — `apps/idp/scripts/vendor-scalar.ts` (bun script): copies `node_modules/@scalar/api-reference/dist/browser/standalone.esm.js` AND `dist/browser/chunks/` into `apps/idp/public/vendor/scalar/`; add `@scalar/api-reference` to `apps/idp` devDependencies (same 0.x version the probe resolved — pin exactly what bun resolves); run it once and COMMIT the output (biome already ignores `public/vendor`); add script `"vendor:scalar": "bun scripts/vendor-scalar.ts"`.
- [ ] **Step 4: `health.ts` route** (`/live`, `/ready` — ready runs `SELECT 1` on D1 and a KV `get` probe, 503 `misconfigured` envelope on failure), `housekeeping.ts` (deletes: sessions `expiresAt < now`, verifications `expiresAt < now`, rate_limit `last_request < now − 86_400_000`, audit_events `at < now − 90 days`; logs one JSON line with counts), `email-consumer.ts` (parse body as `EmailJob` — zod-validate with a small inline schema; unknown kind → ack + warn log so poison messages don't loop; send via `cloudflareEmailSender`; errors → `message.retry()`), `handlers.ts` wiring, `index.ts` exports.
- [ ] **Step 5: move CookieJar, add helpers, delete spikes, update vitest config, write the new integration tests:**
  - `security-headers.test.ts`: `/` (SPA) and `/api/health/live` both carry strict CSP + HSTS + nosniff + frame-ancestors 'none'; `/api/docs` carries the relaxed style-src variant; unknown `/api/x` → 404 envelope (parse with `errorBodySchema`).
  - `allowlist.test.ts`: `GET /api/auth/jwks` → 200 with `keys` array; `GET /.well-known/jwks.json` → 200 same shape; a sample of non-allowlisted Better-Auth paths (`/api/auth/sign-in/email` POST, `/api/auth/sign-up/email` POST, `/api/auth/get-session` GET, `/api/auth/admin/list-users` GET) each → 404 envelope; assert `BETTER_AUTH_ALLOWLIST` deep-equals `["/api/auth/jwks"]` (import from `@flare-idp/api`) so growth is a conscious diff.
  - `email-consumer.test.ts`: `createMessageBatch` with one valid `EmailJob` + one garbage body → valid acked (EMAIL.send resolves in miniflare), garbage acked with warn (no retry); a batch where `EMAIL.send` would throw is impractical to force — skip, covered by unit-level sender logic.
  - `housekeeping.test.ts`: seed expired + fresh rows (session/verification/rate_limit/audit) via raw SQL, run `worker.scheduled` (`createScheduledController`), assert expired gone / fresh kept.
- [ ] **Step 6:** `bun run ci`; also from `apps/idp`: `rm -rf .wrangler/state && bunx wrangler d1 migrations apply flare-idp --local` then `timeout 60 bun run dev` smoke (`curl /api/health/ready` → ok, `curl /api/auth/jwks` → keys, `curl -X POST /api/auth/sign-up/email` → 404 envelope). Commit: `feat(api): production better-auth core behind allowlisted mount, openapi app skeleton, email queue and housekeeping`

**Contract-critical detail:** the singleton `auth` is created at module scope with the QUEUE sender. Tests that need to capture emails construct their own `createAuth(env, { emailSender: captureEmailSender() }, …)` instance INSIDE the test isolate (same D1/KV bindings) — same pattern the Phase 0 spikes proved. Both instances share the same secret/tables, so sessions and tokens are interchangeable between the instance and SELF-fetched facade routes.

---

### Task 6: Setup facade (`/api/setup`)

**Files:** Create `packages/api/src/routes/setup.ts`; register in `app.ts` route chain. Test: `apps/idp/test/integration/setup-route.test.ts`.

**Contract:**
- `GET /api/setup/status` → 200 `{ status: "pending" | "in_progress" | "complete" }` (public).
- `POST /api/setup/complete` body `setupCompleteSchema` (shared). Flow: env has `SETUP_SECRET` else 503 `misconfigured`; `secretsEqual(body.secret, env.SETUP_SECRET)` else 403 `invalid_setup_secret` (rate-limited: `RATE_LIMITS.setup` per IP, checked BEFORE the secret compare); `claimInstallation` else 409 `setup_already_complete`; on any later failure the claim is rolled back to `pending` (try/finally); create the admin: `const provisioning = createAuth(c.env, {}, { allowSignUp: true });` → `callAuth(c, () => provisioning.api.signUpEmail({ body: { email, password, name }, headers: c.req.raw.headers, returnHeaders: true }))` → set role via drizzle: `db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, userId))` → `completeInstallation` → `recordAuditEvent(db, { event: "setup.completed", actorUserId: userId, actorIp, target: email })` → 201 `{ user: sessionUserSchema }` (session cookie forwarded by `callAuth`).
- Sign-up remains disabled everywhere else (singleton has `disableSignUp: true`) — test asserts `/api/auth/sign-up/email` is 404 (allowlist) AND that a second `POST /api/setup/complete` is 409.

Tests: happy path (201, cookie names include `better-auth.session_token`, `GET /api/session` — Task 7 — not yet available, so assert via `auth.api.getSession` with the jar OR defer that assertion to Task 7's tests; assert user role admin via D1), wrong secret 403 + audit-free, missing SETUP_SECRET → 503, second run 409, rate limit: 6th wrong-secret attempt within window → 429 envelope + `Retry-After`, claim rollback: force failure by posting a password of 4 chars AFTER claim? (validation happens before claim — instead force `signUpEmail` failure with a duplicate email: pre-insert a user row with the same email, expect 4xx and status back to `pending`).

Steps: failing tests → implement → ci → commit `feat(api): first-run setup endpoint with atomic claim and admin provisioning`.

---

### Task 7: Session facade (`/api/session`)

**Files:** Create `packages/api/src/routes/session.ts`; register. Test: `apps/idp/test/integration/session-routes.test.ts`.

**Contract:**
- `GET /api/session` → 200 `{ user: SessionUser, session: { id, expiresAt } } | { user: null, session: null }` (from the `loadSession` vars; no extra auth.api call).
- `POST /api/session/sign-in/password` body `signInSchema`; rate-limited `RATE_LIMITS.signIn` keyed `ip:email`; `callAuth(c, () => auth.api.signInEmail({ body, headers, returnHeaders: true }))`; UNAUTHORIZED → 401 `invalid_credentials` (via `mapAuthError`); success → 200 `{ user }` + cookies; audit `session.sign_in` (success only; failures are audited as `session.sign_in_failed` WITHOUT the password, with ip + email).
- `POST /api/session/sign-out` (requireAuth) → `callAuth(… auth.api.signOut …)` → 204; audit `session.sign_out`.
- `POST /api/session/sign-out-all` (requireAuth) → `auth.api.revokeSessions({ headers })` then `auth.api.signOut({ headers, returnHeaders: true })` via `callAuth` → 204; audit `session.sign_out_all`.

Tests: setup → sign-in wrong password (401 envelope + audit row `session.sign_in_failed`), right password (200, jar authenticates `GET /api/session`), sign-out (204; `GET /api/session` → nulls), sign-out-all revokes a second jar's session too, rate limit 429 on 6th attempt (window 60s, max 5) and that DIFFERENT emails from the same IP don't share the counter (composite key), CSRF: sign-in with `Origin: https://evil.example` → 403 `forbidden`.

Commit: `feat(api): session endpoints (sign-in, sign-out, current session)`.

---

### Task 8: Password + email-verification facades (`/api/auth/password`, `/api/auth/email`)

**Files:** Create `packages/api/src/routes/{password.ts,email-verification.ts}`; register. Tests: `apps/idp/test/integration/{password-routes.test.ts,email-verification-routes.test.ts}`.

**Contract (password.ts):**
- `POST /api/auth/password/forgot` body `passwordForgotSchema`; rate-limited `passwordForgot` per IP; calls `auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" }, headers })`; ALWAYS 200 `{ ok: true }` (no user enumeration — Better-Auth already no-ops silently for unknown emails; do not await-fail); do not audit the email existence.
- `POST /api/auth/password/reset` body `passwordResetSchema`; rate-limited `passwordReset`; `callAuth(… auth.api.resetPassword({ body: { token, newPassword: password }, … }))`; BAD_REQUEST/invalid → 400 **`invalid_token`** (route-level re-map); success 200 `{ ok: true }`; audit `password.reset`.
- `POST /api/auth/password/change` (requireAuth) body `passwordChangeSchema`; `callAuth(… auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions }, … }))`; wrong current → 400 `invalid_credentials` (re-map BAD_REQUEST when message mentions password — simpler: try/catch APIError and always map to `invalid_credentials` for this route); success 200 `{ ok: true }`; audit `password.changed`.

**Contract (email-verification.ts):**
- `POST /api/auth/email/verify` body `emailVerifySchema`; rate-limited `emailVerify`; `callAuth(… auth.api.verifyEmail({ query: { token }, headers, returnHeaders: true }))`; invalid → 400 `invalid_token`; success 200 `{ ok: true }`; audit `email.verified`.
- `POST /api/auth/email/resend` (requireAuth); calls `auth.api.sendVerificationEmail({ body: { email: user.email, callbackURL: "/verify-email" }, headers })`; 200 `{ ok: true }`.

**Token-retrieval test pattern (from the Phase 0 spike experience):** construct `const capture = captureEmailSender(); const testAuth = createAuth(env, { emailSender: capture });` in the test; call `testAuth.api.requestPasswordReset(...)` directly to obtain the emailed `url` from `capture.jobs[0]`; extract the `token` query/path param from the url; then exercise the FACADE reset route via `SELF` with that token. Same for verify-email (trigger via `testAuth.api.sendVerificationEmail`). Also assert the forgot FACADE route: 200 + a `verification` row appears in D1 (`SELECT count(*)`), proving the enqueue path ran without needing to read the queue.

Tests additionally: reset with garbage token → 400 `invalid_token`; after reset, old password fails + other sessions revoked (`revokeSessionsOnPasswordReset: true`); change password happy + wrong-current; rate limits (forgot: 4th request in 5 min → 429); verify flips `user.emailVerified` in D1.

Commit: `feat(api): password reset/change and email verification endpoints`.

---

### Task 9: Account facade (`/api/account`)

**Files:** Create `packages/api/src/routes/account.ts`; register. Test: `apps/idp/test/integration/account-routes.test.ts`.

**Contract (all requireAuth):**
- `GET /api/account/profile` → 200 `{ user: SessionUser }` (from vars).
- `PATCH /api/account/profile` body `profilePatchSchema` → `callAuth(… auth.api.updateUser({ body: { name?, image? }, headers, returnHeaders: true }))` → 200 `{ user }` (fresh via `auth.api.getSession` after update, or map the response); audit `account.profile_updated`.
- `GET /api/account/sessions` → `auth.api.listSessions({ headers })`, map each to `sessionInfoSchema` DTO with `current` = matches the current session id; NEVER expose `token`.
- `DELETE /api/account/sessions/:id` → look up the session row by id via drizzle (must belong to `user.id`, else 404 `not_found`); `auth.api.revokeSession({ body: { token: row.token }, headers })` → 204; audit `account.session_revoked`.

Tests: profile get/patch (name change visible in `GET /api/session`), empty patch → 400 `invalid_request`, sessions list has `current: true` exactly once and no `token` key (assert `JSON.stringify` lacks the raw token value), revoking the OTHER jar's session id kills it (its `GET /api/session` → nulls), revoking a foreign user's session id → 404, unauthenticated → 401 envelope.

Commit: `feat(api): account profile and session management endpoints`.

---

### Task 10: OpenAPI document tests, hc client smoke, startup re-measure

**Files:** Create `apps/idp/test/integration/openapi.test.ts`, `apps/idp/test/unit/hc-client.test.ts`. Modify `docs/decisions.md` (Phase 1 addendum), `README.md` (roadmap Phase 1 → ✅ done, Phase 2 → 🔜 next).

- `openapi.test.ts`: `GET /api/openapi.json` → 200; `openapi` field is `"3.1.0"` (or `3.1.x` — pin what `doc31` actually emits); every facade path present — assert the sorted path list deep-equals the expected literal array (this is the API-surface snapshot; updating it is a conscious diff); every operation has at least one non-2xx response documented; `GET /api/docs` → 200 HTML that references only same-origin URLs (regex: no `http(s)://` script/link src other than none).
- `hc-client.test.ts` (unit, node — TYPE-level smoke): `import { hc } from "hono/client"; import type { AppType } from "@flare-idp/api"; const client = hc<AppType>("http://x"); const res: Promise<Response> = client.api.health.live.$get();` — plus `@ts-expect-error` on a nonexistent route. Runtime assertion: none needed (typecheck is the test — keep one trivial `expect(typeof client).toBe("function"|"object")`).
- Re-measure startup: `bun run --cwd apps/idp check:startup`; append the new numbers to `docs/decisions.md` under “Phase 1 re-measure” with the Phase 0 baselines for comparison (Phase 0: 2,630,348 raw / 551,408 gzip / 85 ms). Acceptance unchanged (<3 MB gzip, no violation, target <200 ms); if breached, report DONE_WITH_CONCERNS with numbers — do not optimize in this task.
- decisions.md addendum also RECORDS the issuer decision taken (option 1: `jwt.issuer = APP_URL`) and the allowlist as shipped.

Commit: `test(api): openapi surface snapshot, typed client smoke; docs: phase 1 measurements`.

---

### Task 11: Close out Phase 1

- Full `bun run ci`; `bun run --cwd apps/idp db:apply:local` + dev-server smoke (`/api/health/ready`, `/api/docs`, `/.well-known/jwks.json`, sign-in flow via curl with cookies).
- Verify no spike remnants: `git grep -l "SPIKE CONFIGURATION" packages apps` → empty; `test/spikes` gone; `@better-auth/oauth-provider`/`passkey` absent from `packages/api/package.json` (they return in Phases 2/5).
- README roadmap + CONTRIBUTING untouched elsewhere; commit `docs: mark phase 1 complete in roadmap` if not already covered by Task 10.

## Self-review notes

- Spec coverage: Phase 1 spec paragraph — shared ✔(T2) db ✔(T1) email ✔(T3) api core ✔(T4) auth.ts+seam ✔(T4/T5) app.ts+allowlist+rewrites+doc31+Scalar ✔(T5) routes health/setup/session/password/email/account ✔(T5–T9) audit ✔(T1, used T6–T9) worker wiring ✔(T5) wrangler vars ✔(T4) integration infra ✔(T5) contract tests per route ✔ env-guard ✔(T4) headers ✔(T5) allowlist 404 ✔(T5) openapi validity+snapshot ✔(T10) queue consumer ✔(T5) scheduled ✔(T5). Deferred BY SPEC to later phases: `.well-known/openid-configuration` + `oauth-authorization-server` rewrites (Phase 2 with oauthProvider — only `jwks.json` exists now), schema-drift test (superseded: schema and migrations now share one source via drizzle-kit + journal), org/2FA/passkey/social/admin-console routes, `/api/me/audit`, settings/stats routes (Phase 6).
- Type consistency: `createAuth(env, deps?, opts?)` used identically in T5 (singleton), T6 (provisioning `{ allowSignUp: true }`), T8 (capture sender); `callAuth(c, fn)` signature identical T4–T9; helper names `api/completeSetup/signIn/resetDatabase/CookieJar` consistent T5–T9; `RATE_LIMITS` keys referenced by T6 (`setup`), T7 (`signIn`), T8 (`passwordForgot`, `passwordReset`, `emailVerify`).
- Known judgment points delegated with explicit fallbacks: `APIError` import path (T4), `jwt.issuer` option shape (T5), Scalar injection mechanism (T5 — two concrete alternatives, acceptance defined), drizzle `.run()` changes metadata (T1).
