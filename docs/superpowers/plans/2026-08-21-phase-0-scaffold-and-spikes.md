# flare-idp Phase 0 — Scaffold, Tooling, CI and Risk Spikes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A green, runnable bun-workspace monorepo with one Cloudflare Worker (Hono + placeholder SPA), real D1/KV/Queue/Email bindings in dev and in workerd-based tests, CI, and seven spike tests that prove (or disprove) every known-risk assumption in the design before Phase 1 writes real features.

**Architecture:** `apps/idp` is the single deployable Worker (Vite + `@cloudflare/vite-plugin`, `wrangler.jsonc`, `src/worker.ts` exporting `fetch`/`scheduled`/`queue`). It imports the Hono app from `@flare-idp/api` (workspace package, TypeScript source exports, no build step). Tests run in workerd via `@cloudflare/vitest-plugin` with D1 migrations applied from `packages/db/migrations`. Spikes live in `apps/idp/test/spikes/` and use a Better-Auth instance backed by the **native D1 binding** (`database: env.DB`) with runtime migrations (`getMigrations`) — adapter-independent risks only; Phase 1 switches to the Drizzle adapter + generated schema.

**Tech Stack:** bun 1.4 (installer/runner), TypeScript 7.0.2 (`tsc --noEmit`), Biome 2.5.9, Hono 4.13.3, Vite 8.2.2 + `@cloudflare/vite-plugin` 1.53.1, Vitest 4.1.11 + `@cloudflare/vitest-plugin` 1.0.0, wrangler 4.125.0, React 19.2.8, better-auth 1.7.1 + `@better-auth/oauth-provider` 1.7.1 + `@better-auth/passkey` 1.7.1, `jose` and `otpauth` (test-only).

**Spec:** `docs/superpowers/specs/2026-08-21-flare-idp-design.md` (sections "Architecture → Repo layout", "Research facts", "Implementation phases → Phase 0").

## Global Constraints

- Package manager/runner is **bun** (`bun install --frozen-lockfile` in CI, `bun run`, `bunx wrangler …`). No npm/pnpm lockfiles.
- Exact version pins for the Cloudflare + Better-Auth lockstep packages: `better-auth@1.7.1`, `@better-auth/oauth-provider@1.7.1`, `@better-auth/passkey@1.7.1`, `wrangler@4.125.0`, `@cloudflare/vite-plugin@1.53.1`, `@cloudflare/vitest-plugin@1.0.0`, `hono@4.13.3`, `vite@8.2.2`, `vitest@4.1.11`.
- `compatibility_date: "2026-08-17"`, `compatibility_flags: ["nodejs_compat"]` (Better-Auth requires `nodejs_compat`).
- Worker name `flare-idp`; workspace package names `@flare-idp/app`, `@flare-idp/api`, `@flare-idp/db`, `@flare-idp/shared`, `@flare-idp/email`.
- Migrations dir is `packages/db/migrations`, referenced from `apps/idp/wrangler.jsonc` as `"migrations_dir": "../../packages/db/migrations"`; files named `NNNN_name.sql`, sequential from `0001`, no `BEGIN/COMMIT`, no `PRAGMA foreign_keys`.
- Biome: double quotes, 2-space indent, `recommended` rules; generated files (`routeTree.gen.ts`, `worker-configuration.d.ts`) excluded.
- Every task ends with `bun run ci` green (`check` + `typecheck` + `test` + `build`) unless the task says otherwise, and a commit.
- Commit messages: conventional (`chore:`, `feat:`, `test:`, `docs:`), trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Never commit `.dev.vars`, `dist/`, `.wrangler/`, `node_modules/`.

---

## File structure created by this plan

```
flare-idp/
  package.json                      # workspaces + root scripts (check/typecheck/test/build/dev/ci)
  bun.lock                          # generated
  bunfig.toml
  biome.json
  tsconfig.base.json                # shared compilerOptions
  tsconfig.json                     # root typecheck project (includes apps/** and packages/**)
  .gitignore  .editorconfig  README.md
  .github/workflows/ci.yml
  docs/decisions.md                 # spike outcomes (written by the last task)
  apps/idp/
    package.json                    # @flare-idp/app: vite, wrangler, vitest, react, test deps
    wrangler.jsonc                  # dev shape; envs added in Phase 3
    vite.config.ts                  # cloudflare() + react()
    vitest.config.ts                # projects: unit (jsdom), integration (cloudflareTest)
    index.html                      # SPA shell
    worker-configuration.d.ts       # `wrangler types` output (committed, regenerated on change)
    .dev.vars.example
    public/.gitkeep
    src/worker.ts                   # export default { fetch, scheduled, queue }
    src/client/main.tsx             # placeholder SPA
    src/client/app.tsx
    test/fixtures/assets/index.html # stand-in SPA for miniflare assets
    test/fixtures/assets/assets/app.js
    test/unit/setup.ts
    test/unit/app.test.tsx
    test/unit/wrangler-config.test.ts
    test/unit/migrations-lint.test.ts
    test/integration/setup.ts       # applyD1Migrations
    test/integration/health.test.ts
    test/integration/worker-handlers.test.ts   # scheduled + queue handlers
    test/spikes/helpers/auth-fixture.ts        # createSpikeAuth + migrateSpikeDb + cookie jar
    test/spikes/helpers/cookies.ts
    test/spikes/s1-workspace-paths.test.ts
    test/spikes/s4-oauth-flow.test.ts
    test/spikes/s6-kv-secondary-storage.test.ts
    test/spikes/s7-cookie-seam.test.ts
    test/spikes/s3-passkey.test.ts
    test/spikes/s5-email-queue.test.ts
    scripts/check-startup.sh        # S2 cold-start/bundle check
  packages/api/
    package.json                    # @flare-idp/api: hono, better-auth, plugins
    src/index.ts                    # exports app, auth, createAuth, handleScheduled, handleQueue
    src/auth.ts                     # createAuth(env) — spike config (native D1); Phase 1 replaces
    src/kv-secondary-storage.ts
    src/app.ts                      # Hono app: /api/health/live, Better-Auth mount, 404
    src/handlers.ts                 # handleScheduled, handleQueue (no-op/ack)
  packages/db/
    package.json                    # @flare-idp/db
    src/index.ts
    migrations/0001_app_installation.sql
  packages/shared/
    package.json  src/index.ts      # placeholder exports (constants come in Phase 1)
  packages/email/
    package.json  src/index.ts      # placeholder EmailSender interface
```

---

### Task 1: Root workspace, tooling, and the smallest green Worker

**Files:**
- Create: `package.json`, `bunfig.toml`, `biome.json`, `tsconfig.base.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`, `README.md`
- Create: `packages/shared/package.json`, `packages/shared/src/index.ts`, `packages/db/package.json`, `packages/db/src/index.ts`, `packages/email/package.json`, `packages/email/src/index.ts`
- Create: `packages/api/package.json`, `packages/api/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/handlers.ts`
- Create: `apps/idp/package.json`, `apps/idp/wrangler.jsonc`, `apps/idp/vitest.config.ts`, `apps/idp/src/worker.ts`, `apps/idp/.dev.vars.example`, `apps/idp/test/fixtures/assets/index.html`, `apps/idp/test/fixtures/assets/assets/app.js`, `apps/idp/test/integration/setup.ts`, `apps/idp/test/integration/health.test.ts`
- Create: `packages/db/migrations/0001_app_installation.sql`

**Interfaces:**
- Produces: `@flare-idp/api` exports `app: Hono<{ Bindings: Env }>`, `handleScheduled(controller: ScheduledController, env: Env): Promise<void>`, `handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void>`. Worker entry `apps/idp/src/worker.ts` default-exports `{ fetch, scheduled, queue }`. Test helpers: `cloudflare:test` `env`, `SELF`.
- `Env` interface is generated by `wrangler types` into `apps/idp/worker-configuration.d.ts` (global `Env`, `Cloudflare.Env`).

- [ ] **Step 1: Create root files**

`package.json`:
```json
{
  "name": "flare-idp",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=22.12.0", "bun": ">=1.4.0" },
  "packageManager": "bun@1.4.0",
  "scripts": {
    "check": "biome check .",
    "format": "biome format --write .",
    "typecheck": "bun run --cwd apps/idp types && tsc --noEmit -p tsconfig.json",
    "test": "bun run --cwd apps/idp test",
    "test:watch": "bun run --cwd apps/idp test:watch",
    "build": "bun run --cwd apps/idp build",
    "dev": "bun run --cwd apps/idp dev",
    "ci": "bun run check && bun run typecheck && bun run test && bun run build"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.9",
    "typescript": "7.0.2"
  }
}
```

`bunfig.toml`:
```toml
[install]
exact = true
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.9/schema.json",
  "files": {
    "includes": [
      "**",
      "!**/dist",
      "!**/.wrangler",
      "!**/node_modules",
      "!**/routeTree.gen.ts",
      "!**/worker-configuration.d.ts",
      "!**/public/vendor"
    ]
  },
  "formatter": { "enabled": true, "indentStyle": "space" },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double" } }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "jsx": "react-jsx",
    "allowJs": false,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "ignoreDeprecations": "6.0"
  }
}
```

`tsconfig.json` (root typecheck project — one `tsc` run covers every workspace):
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals", "@cloudflare/vitest-plugin/types"],
    "paths": {
      "@flare-idp/api": ["./packages/api/src/index.ts"],
      "@flare-idp/db": ["./packages/db/src/index.ts"],
      "@flare-idp/shared": ["./packages/shared/src/index.ts"],
      "@flare-idp/email": ["./packages/email/src/index.ts"]
    }
  },
  "include": [
    "apps/idp/worker-configuration.d.ts",
    "apps/idp/src/**/*",
    "apps/idp/test/**/*",
    "apps/idp/*.ts",
    "packages/*/src/**/*"
  ],
  "exclude": ["**/node_modules", "**/dist", "**/.wrangler"]
}
```

`.gitignore`:
```
node_modules/
dist/
.wrangler/
coverage/
.dev.vars
.env
.DS_Store
*.log
```

`.editorconfig`:
```
root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true
```

`README.md` (write exactly this; the inner fence is part of the file):
~~~markdown
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
~~~

- [ ] **Step 2: Create the placeholder workspace packages**

`packages/shared/package.json`:
```json
{ "name": "@flare-idp/shared", "version": "0.0.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" } }
```
`packages/shared/src/index.ts`:
```ts
/** Shared constants and schemas are added in Phase 1. */
export const APP_ID = "flare-idp" as const;
```

`packages/db/package.json`:
```json
{ "name": "@flare-idp/db", "version": "0.0.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" } }
```
`packages/db/src/index.ts`:
```ts
/** Drizzle schema, client and repositories are added in Phase 1. */
export const MIGRATIONS_DIR = "packages/db/migrations" as const;
```

`packages/email/package.json`:
```json
{ "name": "@flare-idp/email", "version": "0.0.0", "private": true, "type": "module", "exports": { ".": "./src/index.ts" } }
```
`packages/email/src/index.ts`:
```ts
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
```

`packages/api/package.json`:
```json
{
  "name": "@flare-idp/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "hono": "4.13.3"
  }
}
```

`packages/api/src/app.ts`:
```ts
import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health/live", (c) => c.json({ status: "ok" }));

// Unknown API paths must never fall through to the SPA/asset handler.
app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

app.get("*", async (c) => {
  // Responses from a binding fetch() carry immutable headers; re-wrap so
  // middleware added in Phase 1 can decorate SPA responses.
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, response);
});
```

`packages/api/src/handlers.ts`:
```ts
export async function handleScheduled(controller: ScheduledController, _env: Env): Promise<void> {
  console.log(JSON.stringify({ event: "scheduled", cron: controller.cron, at: controller.scheduledTime }));
}

export async function handleQueue(batch: MessageBatch<unknown>, _env: Env): Promise<void> {
  for (const message of batch.messages) {
    console.log(JSON.stringify({ event: "queue_message", id: message.id }));
    message.ack();
  }
}
```

`packages/api/src/index.ts`:
```ts
export { app } from "./app";
export { handleQueue, handleScheduled } from "./handlers";
```

- [ ] **Step 3: Create apps/idp (worker, wrangler, vitest) without Vite yet**

`apps/idp/package.json`:
```json
{
  "name": "@flare-idp/app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "vite build && wrangler deploy",
    "types": "wrangler types",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:apply:local": "wrangler d1 migrations apply flare-idp --local"
  },
  "dependencies": {
    "@flare-idp/api": "workspace:*",
    "@flare-idp/db": "workspace:*",
    "@flare-idp/email": "workspace:*",
    "@flare-idp/shared": "workspace:*"
  },
  "devDependencies": {
    "@cloudflare/vitest-plugin": "1.0.0",
    "@types/node": "26.2.0",
    "vitest": "4.1.11",
    "wrangler": "4.125.0"
  }
}
```

`apps/idp/wrangler.jsonc`:
```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "flare-idp",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-17",
  "compatibility_flags": ["nodejs_compat"],
  // Wrangler treats this file as the source of truth and would delete
  // dashboard-set vars on deploy; keep_vars preserves them.
  "keep_vars": true,
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // Every request goes through the Worker so one secureHeaders block
    // governs the SPA and the API.
    "run_worker_first": true
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "flare-idp",
      "database_id": "local-dev-unused",
      "migrations_dir": "../../packages/db/migrations"
    }
  ],
  "kv_namespaces": [{ "binding": "KV", "id": "local-dev-unused" }],
  "queues": {
    "producers": [{ "binding": "EMAIL_QUEUE", "queue": "flare-idp-email" }],
    "consumers": [
      {
        "queue": "flare-idp-email",
        "max_batch_size": 10,
        "max_retries": 3,
        "dead_letter_queue": "flare-idp-email-dlq"
      }
    ]
  },
  "send_email": [{ "name": "EMAIL" }],
  "triggers": { "crons": ["0 3 * * *"] },
  "vars": {
    "APP_NAME": "flare-idp",
    "APP_URL": "http://localhost:5173",
    "ENVIRONMENT": "development"
  },
  "observability": {
    "logs": {
      "enabled": true,
      // Invocation logs record full URLs; auth links carry tokens.
      "invocation_logs": false
    }
  }
}
```

`apps/idp/.dev.vars.example`:
```
# Copy to .dev.vars (git-ignored). Generate with: openssl rand -hex 32
AUTH_SECRET=replace-with-64-hex-chars
SETUP_SECRET=replace-with-a-long-passphrase
```

`apps/idp/src/worker.ts`:
```ts
import { app, handleQueue, handleScheduled } from "@flare-idp/api";

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(handleScheduled(controller, env));
  },
  queue: (batch, env) => handleQueue(batch, env),
} satisfies ExportedHandler<Env>;
```

`apps/idp/test/fixtures/assets/index.html`:
```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>flare-idp test shell</title></head>
<body><div id="root"></div><script src="/assets/app.js"></script></body></html>
```
`apps/idp/test/fixtures/assets/assets/app.js`:
```js
console.log("test asset");
```

`apps/idp/vitest.config.ts` (integration project only for now; the unit project is added in Task 2):
```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export const TEST_BINDINGS = {
  APP_NAME: "flare-idp (test)",
  APP_URL: "http://localhost:8787",
  ENVIRONMENT: "test",
  AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef0123456789",
  SETUP_SECRET: "test-setup-secret",
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations("../../packages/db/migrations");
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Assets: a tiny stand-in for dist/client so the SPA passthrough
                // is exercised without a Vite build.
                assets: {
                  directory: "./test/fixtures/assets",
                  binding: "ASSETS",
                  routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
                  assetConfig: { not_found_handling: "single-page-application" },
                },
                bindings: { ...TEST_BINDINGS, TEST_MIGRATIONS: migrations },
              },
            };
          }),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts", "test/spikes/**/*.test.ts"],
          setupFiles: ["./test/integration/setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
```

`apps/idp/test/integration/setup.ts`:
```ts
import { applyD1Migrations, env } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

// Every checked-in D1 migration is applied before each test file so tests
// run against the real schema. applyD1Migrations only applies new ones.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`packages/db/migrations/0001_app_installation.sql`:
```sql
-- First-run state for the instance. A single row (id = 1) records whether the
-- initial admin has been created. Written by /api/setup in Phase 1.
CREATE TABLE app_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete')),
  owner_user_id TEXT,
  owner_email TEXT,
  completed_at INTEGER
);
INSERT INTO app_installation (id, status) VALUES (1, 'pending');
```

- [ ] **Step 4: Write the failing integration test**

`apps/idp/test/integration/health.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker skeleton", () => {
  it("serves /api/health/live", async () => {
    const res = await SELF.fetch("http://localhost/api/health/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for unknown API paths instead of the SPA", async () => {
    const res = await SELF.fetch("http://localhost/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("falls through to static assets with SPA fallback", async () => {
    const res = await SELF.fetch("http://localhost/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("flare-idp test shell");
  });

  it("applied the D1 migrations", async () => {
    const row = await env.DB.prepare("SELECT status FROM app_installation WHERE id = 1").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});
```

- [ ] **Step 5: Install and generate types, run the test, verify it fails for the right reason**

Run:
```sh
bun install
bun run --cwd apps/idp types
bun run --cwd apps/idp test
```
Expected: `bun install` succeeds and creates `bun.lock`; `wrangler types` writes `apps/idp/worker-configuration.d.ts` containing `interface Env` with `ASSETS: Fetcher; DB: D1Database; KV: KVNamespace; EMAIL_QUEUE: Queue; EMAIL: SendEmail; APP_NAME: string; ...`. The first test run should PASS if Step 3 was done fully — if it fails, the expected failures are (a) `Cannot find module '@flare-idp/api'` → check `apps/idp/package.json` dependencies + `bun install`, (b) miniflare assets directory error → check fixture paths, (c) migrations path → see S1 (Task 4). Fix until green.

- [ ] **Step 6: Run lint and typecheck**

Run: `bun run check && bun run typecheck`
Expected: both pass. If Biome complains about `worker-configuration.d.ts`, confirm the `files.includes` negation in `biome.json`. If `tsc` can't find `cloudflare:test`, confirm `"@cloudflare/vitest-plugin/types"` is in root `tsconfig.json` `types`.

- [ ] **Step 7: Commit**

```sh
git add -A
git commit -m "chore: bootstrap bun workspace with single Worker skeleton and workerd tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Vite SPA shell + `@cloudflare/vite-plugin` dev loop + unit test project

**Files:**
- Create: `apps/idp/vite.config.ts`, `apps/idp/index.html`, `apps/idp/src/client/main.tsx`, `apps/idp/src/client/app.tsx`, `apps/idp/public/.gitkeep`, `apps/idp/test/unit/setup.ts`, `apps/idp/test/unit/app.test.tsx`
- Modify: `apps/idp/package.json` (deps), `apps/idp/vitest.config.ts` (add unit project)

**Interfaces:**
- Produces: `bun run dev` serves SPA + Worker on `http://localhost:5173`; `bun run build` emits `apps/idp/dist/client/**` and `apps/idp/dist/flare_idp/wrangler.json` (the plugin normalises the worker name; assert with a glob).

- [ ] **Step 1: Add dependencies**

Add to `apps/idp/package.json`:
```json
"dependencies": {
  "@flare-idp/api": "workspace:*",
  "@flare-idp/db": "workspace:*",
  "@flare-idp/email": "workspace:*",
  "@flare-idp/shared": "workspace:*",
  "react": "19.2.8",
  "react-dom": "19.2.8"
},
"devDependencies": {
  "@cloudflare/vite-plugin": "1.53.1",
  "@cloudflare/vitest-plugin": "1.0.0",
  "@testing-library/jest-dom": "7.0.1",
  "@testing-library/react": "16.3.2",
  "@types/node": "26.2.0",
  "@types/react": "19.2.18",
  "@types/react-dom": "19.2.4",
  "@vitejs/plugin-react": "6.1.0",
  "jsdom": "30.0.1",
  "vite": "8.2.2",
  "vitest": "4.1.11",
  "wrangler": "4.125.0"
}
```
Run `bun install`.

- [ ] **Step 2: Write the failing unit test**

`apps/idp/test/unit/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`apps/idp/test/unit/app.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/client/app";

describe("<App />", () => {
  it("renders the product name", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "flare-idp" })).toBeInTheDocument();
  });
});
```

Add the unit project to `apps/idp/vitest.config.ts` `projects` array (before the integration project):
```ts
{
  test: {
    name: "unit",
    environment: "jsdom",
    include: ["test/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/unit/setup.ts"],
  },
},
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run --cwd apps/idp test -- --project unit`
Expected: FAIL — `Cannot find module '../../src/client/app'`.

- [ ] **Step 4: Create the SPA shell and Vite config**

`apps/idp/src/client/app.tsx`:
```tsx
export function App() {
  return (
    <main>
      <h1>flare-idp</h1>
      <p>Identity provider — UI arrives in Phase 3.</p>
    </main>
  );
}
```

`apps/idp/src/client/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/idp/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>flare-idp</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/client/main.tsx"></script>
  </body>
</html>
```

`apps/idp/vite.config.ts`:
```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare()],
  server: { port: 5173, strictPort: true },
});
```

Create empty `apps/idp/public/.gitkeep`.

- [ ] **Step 5: Run unit + integration tests, then build**

Run: `bun run --cwd apps/idp test`
Expected: unit PASS (1 test) and integration PASS (4 tests).

Run: `bun run build && ls apps/idp/dist/client/index.html && ls apps/idp/dist/*/wrangler.json`
Expected: both files listed (the worker dir is `dist/flare_idp` or `dist/flare-idp` — note which in `docs/decisions.md` later).

- [ ] **Step 6: Smoke the dev server**

Run (background, then curl, then stop):
```sh
cp apps/idp/.dev.vars.example apps/idp/.dev.vars
(cd apps/idp && timeout 60 bun run dev > /tmp/claude-1000/-home-anders-projects-privat-flare-idp/a07f9182-b413-4ee8-8945-5a832ddea4a5/scratchpad/dev.log 2>&1 &) ; sleep 12
curl -s http://localhost:5173/api/health/live
curl -s http://localhost:5173/ | head -5
```
Expected: `{"status":"ok"}` and the SPA HTML. (Kill the dev server afterwards: `pkill -f "vite dev" || true`.)

- [ ] **Step 7: Lint/typecheck and commit**

Run: `bun run ci`
Expected: green.

```sh
git add -A
git commit -m "feat: add Vite SPA shell with Cloudflare vite plugin and unit test project

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Config guard tests (wrangler contract + migrations lint) and CI workflow

**Files:**
- Create: `apps/idp/test/unit/wrangler-config.test.ts`, `apps/idp/test/unit/migrations-lint.test.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI job `validate` running `bun run ci` + migration numbering check against `main`.

- [ ] **Step 1: Write the wrangler contract test (fails until assertions match config)**

`apps/idp/test/unit/wrangler-config.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type WranglerConfig = {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  keep_vars?: boolean;
  assets?: { binding?: string; not_found_handling?: string; run_worker_first?: boolean | string[] };
  d1_databases?: Array<{ binding: string; database_name: string; migrations_dir?: string }>;
  kv_namespaces?: Array<{ binding: string }>;
  queues?: { producers?: Array<{ binding: string; queue: string }>; consumers?: Array<{ queue: string }> };
  send_email?: Array<{ name: string }>;
  observability?: { logs?: { invocation_logs?: boolean } };
};

function loadWranglerConfig(): WranglerConfig {
  const raw = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  // Strip // line comments (the file has no block comments or URLs in strings).
  const json = raw
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  return JSON.parse(json) as WranglerConfig;
}

describe("wrangler.jsonc deployment contract", () => {
  const config = loadWranglerConfig();

  it("targets the single flare-idp Worker with nodejs_compat", () => {
    expect(config.name).toBe("flare-idp");
    expect(config.main).toBe("src/worker.ts");
    expect(config.compatibility_flags).toContain("nodejs_compat");
  });

  it("routes every request through the Worker and keeps SPA fallback", () => {
    expect(config.assets?.binding).toBe("ASSETS");
    expect(config.assets?.run_worker_first).toBe(true);
    expect(config.assets?.not_found_handling).toBe("single-page-application");
  });

  it("declares D1 (with shared migrations dir), KV, email queue and send_email bindings", () => {
    expect(config.d1_databases?.[0]).toMatchObject({
      binding: "DB",
      database_name: "flare-idp",
      migrations_dir: "../../packages/db/migrations",
    });
    expect(config.kv_namespaces?.[0]?.binding).toBe("KV");
    expect(config.queues?.producers?.[0]).toMatchObject({ binding: "EMAIL_QUEUE", queue: "flare-idp-email" });
    expect(config.queues?.consumers?.[0]?.queue).toBe("flare-idp-email");
    expect(config.send_email?.[0]?.name).toBe("EMAIL");
  });

  it("preserves dashboard vars and disables invocation logs (URLs carry tokens)", () => {
    expect(config.keep_vars).toBe(true);
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });
});
```

- [ ] **Step 2: Write the migrations lint test**

`apps/idp/test/unit/migrations-lint.test.ts`:
```ts
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsDir = new URL("../../../../packages/db/migrations/", import.meta.url);

describe("D1 migration files", () => {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

  it("exist and follow NNNN_name.sql", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("are numbered sequentially from 0001 without gaps or duplicates", () => {
    const numbers = files.map((name) => Number(name.slice(0, 4)));
    expect(numbers[0]).toBe(1);
    for (let i = 1; i < numbers.length; i += 1) {
      expect(numbers[i], `after ${numbers[i - 1]}`).toBe((numbers[i - 1] ?? 0) + 1);
    }
  });

  it("never use PRAGMA foreign_keys or explicit transactions (D1 rejects them)", () => {
    for (const name of files) {
      const sql = readFileSync(new URL(name, migrationsDir), "utf8");
      expect(sql, name).not.toMatch(/PRAGMA\s+foreign_keys/i);
      expect(sql, name).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
    }
  });

  it("do not end with a SQL comment line (applyD1Migrations bug, workers-sdk#7739)", () => {
    for (const name of files) {
      const lines = readFileSync(new URL(name, migrationsDir), "utf8").trimEnd().split("\n");
      expect(lines.at(-1)?.trim().startsWith("--"), name).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run unit tests**

Run: `bun run --cwd apps/idp test -- --project unit`
Expected: PASS (both new files; if `wrangler-config` fails, the config drifted from Task 1 — fix the config, not the test).

- [ ] **Step 4: Create the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0

      - name: Install dependencies
        run: bun install --frozen-lockfile

      # All PRs share one preview D1. Refuse migration numbers that already
      # exist on main under another name and require the branch to contain
      # every migration main has.
      - name: Check migration numbering against main
        if: github.event_name == 'pull_request'
        run: |
          set -euo pipefail
          git fetch --no-tags --depth=1 origin main
          mapfile -t main_files < <(git ls-tree --name-only origin/main packages/db/migrations/ | xargs -n1 basename | grep -E '^[0-9]{4}_.*\.sql$' | sort || true)
          mapfile -t branch_files < <(ls packages/db/migrations | grep -E '^[0-9]{4}_.*\.sql$' | sort)
          declare -A main_by_number
          for f in "${main_files[@]}"; do main_by_number["${f:0:4}"]="$f"; done
          status=0
          for f in "${branch_files[@]}"; do
            n="${f:0:4}"
            if [[ -n "${main_by_number[$n]:-}" && "${main_by_number[$n]}" != "$f" ]]; then
              echo "::error::packages/db/migrations/$f reuses number $n which main already has as ${main_by_number[$n]}; renumber it"
              status=1
            fi
          done
          for f in "${main_files[@]}"; do
            if [[ ! -f "packages/db/migrations/$f" ]]; then
              echo "::error::packages/db/migrations/$f exists on main but not on this branch; rebase onto main"
              status=1
            fi
          done
          exit $status

      - name: Lint and format check
        run: bun run check

      - name: Typecheck
        run: bun run typecheck

      - name: Test
        run: bun run test

      - name: Build
        run: bun run build
```

- [ ] **Step 5: Validate the workflow YAML locally and run ci**

Run: `bun x --bun yaml@latest --help >/dev/null 2>&1 || true; node -e "const fs=require('fs');const y=fs.readFileSync('.github/workflows/ci.yml','utf8');if(!/jobs:\n\s+validate:/.test(y))process.exit(1)"` and `bun run ci`
Expected: exit 0 and `bun run ci` green.

- [ ] **Step 6: Commit**

```sh
git add -A
git commit -m "test: add wrangler contract and migrations lint tests; add CI workflow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Spike S1 — workspace `main` + `migrations_dir` resolution under vite plugin, vitest plugin and wrangler CLI

**Files:**
- Create: `apps/idp/test/spikes/s1-workspace-paths.test.ts`

**Interfaces:**
- Consumes: `env.DB`, `env.TEST_MIGRATIONS` from `cloudflare:test`.

- [ ] **Step 1: Write the spike test**

`apps/idp/test/spikes/s1-workspace-paths.test.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * S1: the vitest plugin resolves `main: src/worker.ts` → `@flare-idp/api`
 * workspace source, and `readD1Migrations("../../packages/db/migrations")`
 * found the shared migrations dir.
 */
describe("S1 workspace path resolution", () => {
  it("bundles @flare-idp/api through the Worker entry", async () => {
    const res = await SELF.fetch("http://localhost/api/health/live");
    expect(res.status).toBe(200);
  });

  it("loaded migrations from packages/db/migrations", async () => {
    expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual(["0001_app_installation.sql"]);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_installation'").all();
    expect(tables.results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun run --cwd apps/idp test -- --project integration -t "S1"`
Expected: PASS.

- [ ] **Step 3: Verify wrangler CLI resolves the relative `migrations_dir`**

Run (from `apps/idp`): `bunx wrangler d1 migrations list flare-idp --local && bunx wrangler d1 migrations apply flare-idp --local`
Expected: lists `0001_app_installation.sql` and applies it to `.wrangler/state`. If wrangler errors with "migrations directory not found", create a relative symlink `apps/idp/migrations -> ../../packages/db/migrations`, set `"migrations_dir": "migrations"`, update `wrangler-config.test.ts` accordingly, and record the fallback in `docs/decisions.md` (Task 11).

- [ ] **Step 4: Commit**

```sh
git add -A
git commit -m "test(spike): S1 workspace main and migrations_dir resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Better-Auth spike instance (native D1) + KV secondary storage + cookie helpers

**Files:**
- Create: `packages/api/src/auth.ts`, `packages/api/src/kv-secondary-storage.ts`
- Create: `apps/idp/test/spikes/helpers/auth-fixture.ts`, `apps/idp/test/spikes/helpers/cookies.ts`
- Modify: `packages/api/package.json` (deps), `packages/api/src/app.ts` (mount `/api/auth/*`), `packages/api/src/index.ts` (exports)

**Interfaces:**
- Produces: `createAuth(env: Env)` → Better-Auth instance (spike config: native D1, optional KV), `auth` module singleton (via `cloudflare:workers` env), `kvSecondaryStorage(kv: KVNamespace): SecondaryStorage`, `migrateSpikeDb(auth)`, `CookieJar` with `absorb(headers: Headers)`, `header(): string`, `get(name): string | undefined`.
- Consumes: `better-auth`, `better-auth/plugins` (`admin`, `jwt`, `twoFactor`), `@better-auth/oauth-provider`, `@better-auth/passkey`, `better-auth/db/migration` (`getMigrations`).

- [ ] **Step 1: Add dependencies**

`packages/api/package.json` dependencies:
```json
"dependencies": {
  "@better-auth/oauth-provider": "1.7.1",
  "@better-auth/passkey": "1.7.1",
  "better-auth": "1.7.1",
  "hono": "4.13.3"
}
```
Run `bun install`.

- [ ] **Step 2: Write the failing test for the KV storage adapter**

`apps/idp/test/spikes/s6-kv-secondary-storage.test.ts` (first test only; more added in Task 6):
```ts
import { env } from "cloudflare:test";
import { kvSecondaryStorage } from "@flare-idp/api";
import { describe, expect, it } from "vitest";

describe("S6 kvSecondaryStorage adapter", () => {
  it("implements get/set/delete and clamps TTL to KV's 60s minimum", async () => {
    const storage = kvSecondaryStorage(env.KV);
    await storage.set("k1", "v1", 10); // below KV minimum — must not throw
    expect(await storage.get("k1")).toBe("v1");
    await storage.delete("k1");
    expect(await storage.get("k1")).toBeNull();
  });

  it("getAndDelete returns the value once", async () => {
    const storage = kvSecondaryStorage(env.KV);
    await storage.set("once", "x");
    expect(await storage.getAndDelete("once")).toBe("x");
    expect(await storage.getAndDelete("once")).toBeNull();
  });

  it("increment counts up (non-atomic; documented as unused in production config)", async () => {
    const storage = kvSecondaryStorage(env.KV);
    expect(await storage.increment("ctr", 60)).toBe(1);
    expect(await storage.increment("ctr", 60)).toBe(2);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run --cwd apps/idp test -- --project integration -t "S6"`
Expected: FAIL — `kvSecondaryStorage` is not exported from `@flare-idp/api`.

- [ ] **Step 4: Implement the KV storage, the spike auth config, mount it, export it**

`packages/api/src/kv-secondary-storage.ts`:
```ts
import type { SecondaryStorage } from "better-auth";

const KV_MIN_TTL_SECONDS = 60;

function ttlOptions(ttl?: number): KVNamespacePutOptions | undefined {
  if (ttl === undefined) return undefined;
  return { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttl)) };
}

/**
 * Better-Auth secondary storage on Workers KV. Used as a session read cache
 * only: `rateLimit.storage` is never "secondary-storage" and
 * `verification.storeInDatabase` is true, so the non-atomic `increment` and
 * `getAndDelete` below are never on a security-critical path.
 */
export function kvSecondaryStorage(kv: KVNamespace): SecondaryStorage {
  return {
    get: (key) => kv.get(key),
    set: (key, value, ttl) => kv.put(key, value, ttlOptions(ttl)),
    delete: (key) => kv.delete(key),
    getAndDelete: async (key) => {
      const value = await kv.get(key);
      if (value !== null) await kv.delete(key);
      return value;
    },
    increment: async (key, ttl) => {
      const next = Number((await kv.get(key)) ?? 0) + 1;
      await kv.put(key, String(next), ttlOptions(ttl));
      return next;
    },
  };
}
```

`packages/api/src/auth.ts` (spike config — Phase 1 replaces this file with the Drizzle-adapter production config):
```ts
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { admin, jwt, twoFactor } from "better-auth/plugins";
import { kvSecondaryStorage } from "./kv-secondary-storage";

export type CreateAuthOptions = {
  /** Use KV as Better-Auth secondaryStorage (session cache). */
  useKv?: boolean;
};

export function createAuth(env: Env, options: CreateAuthOptions = {}) {
  const origin = new URL(env.APP_URL);
  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    // Spike: native D1 dialect (auto-detected). Phase 1 switches to the
    // Drizzle adapter + generated schema.
    database: env.DB,
    secondaryStorage: options.useKv ? kvSecondaryStorage(env.KV) : undefined,
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: false,
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
      twoFactor({ issuer: env.APP_NAME }),
      passkey({ rpID: origin.hostname, rpName: env.APP_NAME, origin: env.APP_URL }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

Add to `packages/api/src/app.ts` (before the `/api/*` 404):
```ts
import { env } from "cloudflare:workers";
import { createAuth } from "./auth";

// Module-level singleton: one init per isolate. Spike S2 measures its cost.
export const auth = createAuth(env as Env);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
```
(Keep the existing `/api/health/live` route above it; ordering: health → auth mount → 404 → assets.)

If `cloudflare:workers` has no type declaration in `worker-configuration.d.ts`, add to `apps/idp/src/cloudflare-workers.d.ts`:
```ts
declare module "cloudflare:workers" {
  export const env: Env;
}
```
and include it in the root `tsconfig.json` `include` (`apps/idp/src/**/*` already covers it).

`packages/api/src/index.ts`:
```ts
export { app, auth } from "./app";
export { type Auth, createAuth } from "./auth";
export { handleQueue, handleScheduled } from "./handlers";
export { kvSecondaryStorage } from "./kv-secondary-storage";
```

`apps/idp/test/spikes/helpers/cookies.ts`:
```ts
/** Minimal cookie jar: absorbs Set-Cookie headers, emits a Cookie header. */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(headers: Headers): this {
    for (const raw of headers.getSetCookie()) {
      const [pair] = raw.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  names(): string[] {
    return [...this.jar.keys()];
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  headers(extra: Record<string, string> = {}): Headers {
    return new Headers({ cookie: this.header(), origin: "http://localhost:8787", ...extra });
  }
}
```

`apps/idp/test/spikes/helpers/auth-fixture.ts`:
```ts
import { env } from "cloudflare:test";
import { type Auth, createAuth } from "@flare-idp/api";
import { getMigrations } from "better-auth/db/migration";
import { CookieJar } from "./cookies";

export const SPIKE_USER = { email: "spike@example.com", password: "correct-horse-battery-staple", name: "Spike" };

/** Create a Better-Auth instance for spikes (native D1; optional KV). */
export function createSpikeAuth(options: { useKv?: boolean } = {}): Auth {
  return createAuth(env, options);
}

/** Create Better-Auth tables in the (isolated, per-test) D1 via the Kysely migrator. */
export async function migrateSpikeDb(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** Sign up SPIKE_USER and return a jar holding the session cookie. */
export async function signUpSpikeUser(auth: Auth, jar = new CookieJar()): Promise<{ jar: CookieJar; userId: string }> {
  const { headers, response } = await auth.api.signUpEmail({
    body: SPIKE_USER,
    headers: jar.headers(),
    returnHeaders: true,
  });
  jar.absorb(headers);
  return { jar, userId: response.user.id };
}

/** Promote a user to admin directly in D1 (spikes only). */
export async function promoteToAdmin(userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?1`).bind(userId).run();
}
```

Add `better-auth` to `apps/idp/package.json` devDependencies? No — tests import `better-auth/db/migration` which resolves through the workspace hoist; if vitest fails to resolve it, add `"better-auth": "1.7.1"` to `apps/idp` devDependencies and re-run `bun install`.

- [ ] **Step 5: Run the KV tests and the whole suite**

Run: `bun run --cwd apps/idp test`
Expected: S6 PASS; all earlier tests still PASS. If the Worker fails to start with an error mentioning `AUTH_SECRET`/`APP_URL`, the `miniflare.bindings` in `vitest.config.ts` were not applied — check `TEST_BINDINGS`. If `cloudflare:workers` `env` is undefined at module scope in tests, switch `app.ts` to lazily create the singleton on first request (`let cached: Auth | undefined; const getAuth = (env: Env) => (cached ??= createAuth(env));`) and record that in `docs/decisions.md`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `bun run check && bun run typecheck`
Expected: green (the `SecondaryStorage` type import from `better-auth` must resolve; if it lives at `better-auth/types`, import from there).

```sh
git add -A
git commit -m "feat(spike): Better-Auth instance on native D1 with KV secondary storage and cookie helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Spike S6 (KV sessions) and S7 (cookie seam: sign-in → 2FA → session through `auth.api.*`)

**Files:**
- Modify: `apps/idp/test/spikes/s6-kv-secondary-storage.test.ts`
- Create: `apps/idp/test/spikes/s7-cookie-seam.test.ts`
- Modify: `apps/idp/package.json` (devDependency `otpauth`)

**Interfaces:**
- Consumes: `createSpikeAuth`, `migrateSpikeDb`, `signUpSpikeUser`, `CookieJar`; `auth.api.signInEmail`, `auth.api.getSession`, `auth.api.listSessions`, `auth.api.enableTwoFactor`, `auth.api.verifyTOTP`, `auth.api.signOut` (all with `returnHeaders: true`).

- [ ] **Step 1: Add `otpauth` for computing TOTP codes in tests**

`apps/idp/package.json` devDependencies: `"otpauth": "9.4.0"` (any 9.x works; pin what `bun add -d otpauth` resolves). Run `bun install`.

- [ ] **Step 2: Extend S6 with session-on-KV assertions**

Append to `apps/idp/test/spikes/s6-kv-secondary-storage.test.ts`:
```ts
import { createSpikeAuth, migrateSpikeDb, signUpSpikeUser } from "./helpers/auth-fixture";

describe("S6 sessions with KV secondaryStorage + storeSessionInDatabase", () => {
  it("writes the session row to D1 and caches it in KV; listSessions works", async () => {
    const auth = createSpikeAuth({ useKv: true });
    await migrateSpikeDb(auth);
    const { jar } = await signUpSpikeUser(auth);

    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.user.email).toBe("spike@example.com");

    const rows = await env.DB.prepare(`SELECT token FROM "session"`).all<{ token: string }>();
    expect(rows.results).toHaveLength(1);

    // Better-Auth stores sessions in secondary storage keyed by the raw token.
    const cached = await env.KV.get(rows.results[0]?.token ?? "");
    expect(cached).not.toBeNull();

    const sessions = await auth.api.listSessions({ headers: jar.headers() });
    expect(sessions).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Write S7 — cookie seam through `auth.api.*`**

`apps/idp/test/spikes/s7-cookie-seam.test.ts`:
```ts
import { env } from "cloudflare:test";
import * as OTPAuth from "otpauth";
import { describe, expect, it } from "vitest";
import { createSpikeAuth, migrateSpikeDb, SPIKE_USER, signUpSpikeUser } from "./helpers/auth-fixture";
import { CookieJar } from "./helpers/cookies";

/**
 * S7: every SPA-facing flow goes through our facade, which calls auth.api.*
 * and forwards Set-Cookie. These tests prove the cookie chain survives:
 * sign-in → (2FA interim cookie) → verify TOTP → session cookie → sign-out.
 */
describe("S7 cookie seam", () => {
  it("sign-in via auth.api returns Set-Cookie that authenticates getSession", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    await signUpSpikeUser(auth);

    const jar = new CookieJar();
    const { headers, response } = await auth.api.signInEmail({
      body: { email: SPIKE_USER.email, password: SPIKE_USER.password },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(headers);
    expect(response.user.email).toBe(SPIKE_USER.email);
    expect(jar.names().some((n) => n.includes("session_token"))).toBe(true);

    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.session.userId).toBe(response.user.id);

    const out = await auth.api.signOut({ headers: jar.headers(), returnHeaders: true });
    jar.absorb(out.headers);
    expect(await auth.api.getSession({ headers: jar.headers() })).toBeNull();
  });

  it("2FA: enable → verify setup → sign-in yields twoFactorRedirect + interim cookie → verifyTOTP yields session", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar } = await signUpSpikeUser(auth);

    const enable = await auth.api.enableTwoFactor({
      body: { password: SPIKE_USER.password },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(enable.headers);
    const totpURI = "totpURI" in enable.response ? enable.response.totpURI : undefined;
    expect(totpURI, "1.7 discriminates by method; expect TOTP").toBeTypeOf("string");
    const totp = OTPAuth.URI.parse(totpURI as string) as OTPAuth.TOTP;

    const setup = await auth.api.verifyTOTP({
      body: { code: totp.generate() },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(setup.headers);

    // Fresh browser: sign in again → 2FA required.
    const jar2 = new CookieJar();
    const signIn = await auth.api.signInEmail({
      body: { email: SPIKE_USER.email, password: SPIKE_USER.password },
      headers: jar2.headers(),
      returnHeaders: true,
    });
    jar2.absorb(signIn.headers);
    expect((signIn.response as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(jar2.names().some((n) => n.includes("two_factor"))).toBe(true);

    const verify = await auth.api.verifyTOTP({
      body: { code: totp.generate() },
      headers: jar2.headers(),
      returnHeaders: true,
    });
    jar2.absorb(verify.headers);
    const session = await auth.api.getSession({ headers: jar2.headers() });
    expect(session?.user.email).toBe(SPIKE_USER.email);

    const twoFactorRows = await env.DB.prepare(`SELECT verified FROM "twoFactor"`).all<{ verified: number }>();
    expect(twoFactorRows.results[0]?.verified).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run S6 + S7**

Run: `bun run --cwd apps/idp test -- --project integration -t "S6|S7"`
Expected: PASS. Known adjustment points (record in `docs/decisions.md`): exact cookie names (`better-auth.session_token`, `better-auth.two_factor`), table names (`session`, `twoFactor` vs `two_factor` — check `sqlite_master` if the query fails), and whether `verifyTOTP` during setup requires the `trustDevice` field.

- [ ] **Step 5: Commit**

```sh
git add -A
git commit -m "test(spike): S6 KV session cache and S7 cookie seam through auth.api

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Spike S4 — OAuth2/OIDC flow on D1 (authorize → consent → token → userinfo → refresh, discovery, JWKS)

**Files:**
- Create: `apps/idp/test/spikes/s4-oauth-flow.test.ts`
- Modify: `apps/idp/package.json` (devDependency `jose`)

**Interfaces:**
- Consumes: `auth.handler(Request)` for protocol routes; `auth.api.adminCreateOAuthClient` for client creation; `jose` `createLocalJWKSet` + `jwtVerify`.

- [ ] **Step 1: Add `jose`**

`apps/idp/package.json` devDependencies: `"jose": "6.0.11"` (pin what `bun add -d jose` resolves; 6.x). Run `bun install`.

- [ ] **Step 2: Write the spike test**

`apps/idp/test/spikes/s4-oauth-flow.test.ts`:
```ts
import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createSpikeAuth, migrateSpikeDb, promoteToAdmin, signUpSpikeUser } from "./helpers/auth-fixture";

const BASE = "http://localhost:8787";
const REDIRECT_URI = "http://localhost:3000/callback";

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function createClient(auth: ReturnType<typeof createSpikeAuth>, adminHeaders: Headers, skipConsent: boolean) {
  const client = await auth.api.adminCreateOAuthClient({
    body: {
      client_name: skipConsent ? "first-party" : "third-party",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid profile email offline_access",
      skip_consent: skipConsent,
    },
    headers: adminHeaders,
  });
  return client as { client_id: string; client_secret?: string };
}

describe("S4 OAuth2/OIDC on D1", () => {
  it("serves discovery and JWKS with issuer = baseURL", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const disc = await auth.handler(new Request(`${BASE}/api/auth/.well-known/openid-configuration`));
    expect(disc.status).toBe(200);
    const doc = (await disc.json()) as Record<string, string>;
    expect(doc.issuer).toBe(BASE);
    expect(doc.authorization_endpoint).toContain("/oauth2/authorize");
    expect(doc.token_endpoint).toContain("/oauth2/token");
    expect(doc.jwks_uri).toBeTypeOf("string");

    const jwks = await auth.handler(new Request(doc.jwks_uri as string));
    expect(jwks.status).toBe(200);
    const keys = (await jwks.json()) as { keys: Array<{ kty: string }> };
    expect(keys.keys.length).toBeGreaterThan(0);
  });

  it("completes code+PKCE flow for a trusted client, verifies id_token against JWKS, refreshes", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar, userId } = await signUpSpikeUser(auth);
    await promoteToAdmin(userId);
    const client = await createClient(auth, jar.headers(), true);
    expect(client.client_id).toBeTypeOf("string");
    expect(client.client_secret).toBeTypeOf("string");

    const { verifier, challenge } = await pkce();
    const authorizeUrl = new URL(`${BASE}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      state: "xyz",
      nonce: "n-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const authz = await auth.handler(new Request(authorizeUrl, { headers: jar.headers(), redirect: "manual" }));
    expect([302, 303, 307]).toContain(authz.status);
    const location = new URL(authz.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    expect(code).toBeTypeOf("string");

    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const tokenRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; id_token: string; refresh_token?: string; token_type: string };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeTypeOf("string");

    // Verify id_token signature + claims against JWKS.
    const jwksRes = await auth.handler(new Request(`${BASE}/api/auth/jwks`));
    const jwks = createLocalJWKSet(await jwksRes.json());
    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: BASE, audience: client.client_id });
    expect(payload.sub).toBe(userId);
    expect(payload.nonce).toBe("n-1");

    const userinfo = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } }),
    );
    expect(userinfo.status).toBe(200);
    expect(((await userinfo.json()) as { sub: string }).sub).toBe(userId);

    const refreshRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token as string }),
      }),
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as { access_token: string; refresh_token?: string };
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    // Replaying the authorization code must fail (no transactions on D1 — prove replay protection holds).
    const replay = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code: code as string, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      }),
    );
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it("requires consent for a non-trusted client and accepts it via auth.api.oauth2Consent", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar, userId } = await signUpSpikeUser(auth);
    await promoteToAdmin(userId);
    const client = await createClient(auth, jar.headers(), false);
    const { verifier, challenge } = await pkce();

    const authorizeUrl = new URL(`${BASE}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      state: "s2",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const authz = await auth.handler(new Request(authorizeUrl, { headers: jar.headers(), redirect: "manual" }));
    jar.absorb(authz.headers);
    const location = new URL(authz.headers.get("location") ?? "", BASE);
    // Consent required → redirected to our consentPage, not the RP.
    expect(location.pathname).toBe("/oauth/consent");

    // The SPA consent page would POST to our facade, which calls:
    const consent = await auth.api.oauth2Consent({
      body: { accept: true, scope: "openid profile email" },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.absorb(consent.headers);
    const body = consent.response as Record<string, unknown>;
    const redirectTo = Object.values(body).find((v) => typeof v === "string" && v.startsWith(REDIRECT_URI)) as string | undefined;
    expect(redirectTo, `consent response: ${JSON.stringify(body)}`).toBeDefined();
    const code = new URL(redirectTo as string).searchParams.get("code");
    expect(code).toBeTypeOf("string");

    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const tokenRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code: code as string, redirect_uri: REDIRECT_URI, code_verifier: verifier }),
      }),
    );
    expect(tokenRes.status).toBe(200);
  });
});
```

- [ ] **Step 3: Run S4**

Run: `bun run --cwd apps/idp test -- --project integration -t "S4"`
Expected: PASS. If `adminCreateOAuthClient` rejects body fields, read the error message (Better-Auth returns precise Zod messages) and adjust field names (`redirect_uris`, `token_endpoint_auth_method`, `skip_consent`, `grant_types`, `scope`) — record the final shape in `docs/decisions.md`. If authorize redirects to `/sign-in` despite the cookie, the `origin` header or `trustedOrigins` mismatch — ensure `jar.headers()` sends `origin: http://localhost:8787`. If consent goes through an `/oauth2/continue` step, assert that and note it.

- [ ] **Step 4: Commit**

```sh
git add -A
git commit -m "test(spike): S4 OAuth2/OIDC code+PKCE, consent, refresh and JWKS verification on D1

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Spike S3 — passkey option generation / verification path on workerd

**Files:**
- Create: `apps/idp/test/spikes/s3-passkey.test.ts`

**Interfaces:**
- Consumes: `auth.api.generatePasskeyRegistrationOptions`, `auth.api.verifyPasskeyRegistration`, `auth.api.generatePasskeyAuthenticationOptions`, `auth.api.listPasskeys`.

- [ ] **Step 1: Write the spike test**

`apps/idp/test/spikes/s3-passkey.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createSpikeAuth, migrateSpikeDb, signUpSpikeUser } from "./helpers/auth-fixture";

/**
 * S3: the passkey plugin (SimpleWebAuthn) loads and runs on workerd. A real
 * attestation needs an authenticator, so we prove: options generate (challenge
 * is persisted), a bogus attestation is rejected with a 4xx APIError (not a
 * crash), and authentication options generate.
 */
describe("S3 passkey plugin on workerd", () => {
  it("generates registration options and rejects a bogus attestation cleanly", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar } = await signUpSpikeUser(auth);

    const reg = await auth.api.generatePasskeyRegistrationOptions({ headers: jar.headers(), returnHeaders: true });
    jar.absorb(reg.headers);
    expect(reg.response.challenge).toBeTypeOf("string");
    expect(reg.response.rp.id).toBe("localhost");

    await expect(
      auth.api.verifyPasskeyRegistration({
        body: {
          response: {
            id: "bogus",
            rawId: "Ym9ndXM",
            type: "public-key",
            clientExtensionResults: {},
            response: { clientDataJSON: "e30", attestationObject: "AAAA" },
          },
        },
        headers: jar.headers(),
      }),
    ).rejects.toMatchObject({ status: expect.stringMatching(/BAD_REQUEST|UNAUTHORIZED|INTERNAL_SERVER_ERROR/) });

    expect(await auth.api.listPasskeys({ headers: jar.headers() })).toEqual([]);
  });

  it("generates authentication options without a session (discoverable credential flow)", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const res = await auth.api.generatePasskeyAuthenticationOptions({ body: {}, headers: new Headers({ origin: "http://localhost:8787" }), returnHeaders: true });
    expect(res.response.challenge).toBeTypeOf("string");
    expect(res.headers.getSetCookie().some((c) => c.includes("passkey"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run S3**

Run: `bun run --cwd apps/idp test -- --project integration -t "S3"`
Expected: PASS. If `verifyPasskeyRegistration` throws a non-APIError (e.g. `ReferenceError`/missing Node API), that's the finding — record the stack in `docs/decisions.md` and raise it before Phase 5 (mitigation candidates: `nodejs_compat_v2`, pinning `@simplewebauthn/server`).

- [ ] **Step 3: Commit**

```sh
git add -A
git commit -m "test(spike): S3 passkey options/verification path on workerd

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Spike S5 — Email Service binding and Queue producer/consumer in miniflare; scheduled handler

**Files:**
- Create: `apps/idp/test/spikes/s5-email-queue.test.ts`, `apps/idp/test/integration/worker-handlers.test.ts`
- Modify (only if needed): `apps/idp/vitest.config.ts` (add `miniflare.email` fallback)

**Interfaces:**
- Consumes: `env.EMAIL.send(...)`, `env.EMAIL_QUEUE.send(...)`, `createMessageBatch`, `getQueueResult`, `createScheduledController`, `createExecutionContext`, `waitOnExecutionContext` from `cloudflare:test`; worker default export from `apps/idp/src/worker.ts`.

- [ ] **Step 1: Write the spike + handler tests**

`apps/idp/test/spikes/s5-email-queue.test.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("S5 Email Service binding in miniflare", () => {
  it("exposes EMAIL.send and accepts a plain-object message", async () => {
    expect(env.EMAIL).toBeDefined();
    const result = await env.EMAIL.send({
      from: "noreply@example.com",
      to: "user@example.com",
      subject: "flare-idp spike",
      text: "hello",
      html: "<p>hello</p>",
    });
    // Local simulator returns a message id (or resolves undefined on older miniflare) — must not throw.
    expect(result === undefined || typeof (result as { messageId?: string }).messageId === "string").toBe(true);
  });
});

describe("S5 Queue producer binding", () => {
  it("accepts a message on EMAIL_QUEUE", async () => {
    await expect(env.EMAIL_QUEUE.send({ kind: "spike", to: "user@example.com" })).resolves.toBeUndefined();
  });
});
```

`apps/idp/test/integration/worker-handlers.test.ts`:
```ts
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker";

describe("worker handlers", () => {
  it("scheduled handler runs to completion", async () => {
    const controller = createScheduledController({ scheduledTime: new Date(), cron: "0 3 * * *" });
    const ctx = createExecutionContext();
    await worker.scheduled?.(controller, env, ctx);
    await waitOnExecutionContext(ctx);
  });

  it("queue handler acks every message", async () => {
    const batch = createMessageBatch("flare-idp-email", [
      { id: "m1", timestamp: new Date(), body: { kind: "spike" }, attempts: 1 },
      { id: "m2", timestamp: new Date(), body: { kind: "spike" }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await worker.queue?.(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun run --cwd apps/idp test -- --project integration -t "S5|worker handlers"`
Expected: PASS. If `env.EMAIL` is undefined, the vitest plugin did not map `send_email` from `wrangler.jsonc`; add to `miniflare` in `vitest.config.ts`: `email: { send_email: [{ name: "EMAIL" }] }` and re-run. If `env.EMAIL_QUEUE` is undefined, add `queueProducers: { EMAIL_QUEUE: "flare-idp-email" }` and `queueConsumers: { "flare-idp-email": { maxBatchSize: 10, maxRetries: 3 } }`. Record whichever was needed in `docs/decisions.md`.

- [ ] **Step 3: Commit**

```sh
git add -A
git commit -m "test(spike): S5 Email Service and Queue bindings in miniflare; scheduled/queue handler tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Spike S2 — bundle size and cold-start CPU of the Better-Auth stack

**Files:**
- Create: `apps/idp/scripts/check-startup.sh`
- Modify: `apps/idp/package.json` (script `check:startup`)

**Interfaces:**
- Consumes: `vite build` output `apps/idp/dist/<worker>/`; `wrangler check startup`.

- [ ] **Step 1: Write the script**

`apps/idp/scripts/check-startup.sh`:
```sh
#!/usr/bin/env bash
# S2: measure Worker bundle size and startup CPU for the Better-Auth stack.
# Usage: bun run check:startup   (from apps/idp)
set -euo pipefail
cd "$(dirname "$0")/.."
bunx vite build >/dev/null
worker_dir=$(ls -d dist/*/ | grep -v '^dist/client/' | head -1)
config="${worker_dir}wrangler.json"
echo "worker dir: $worker_dir"
gz=$(gzip -c "${worker_dir}"*.js 2>/dev/null | wc -c || echo 0)
echo "entry js gzip bytes: $gz"
# Startup profile: reports CPU time spent at module evaluation (must stay well under the platform limit).
bunx wrangler check startup --config "$config" --outfile "../../.startup-profile.cpuprofile" || {
  echo "wrangler check startup failed (see output above)"; exit 1; }
echo "profile written to ../../.startup-profile.cpuprofile"
```
Make executable: `chmod +x apps/idp/scripts/check-startup.sh`. Add `"check:startup": "bash scripts/check-startup.sh"` to `apps/idp/package.json` scripts. Add `.startup-profile.cpuprofile` and `*.cpuprofile` to `.gitignore`.

- [ ] **Step 2: Run it and record numbers**

Run: `bun run --cwd apps/idp check:startup`
Expected: prints gzip size and wrangler's startup summary. Acceptance: gzip size < 3 MB and `wrangler check startup` reports no limit violation (current platform limit is 400 ms startup CPU; target < 200 ms). Note both numbers for `docs/decisions.md`. If over budget: (1) switch the spike to `import { betterAuth } from "better-auth/minimal"` is not possible with native D1 (needs Kysely) — that is expected to improve in Phase 1 with the Drizzle adapter; (2) lazily create the auth singleton on first request instead of at module scope; (3) drop `jwt` key generation from startup (keys are generated lazily on first JWKS call anyway — confirm).

- [ ] **Step 3: Commit**

```sh
git add -A
git commit -m "chore(spike): S2 bundle size and startup CPU check script

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Record spike outcomes and close Phase 0

**Files:**
- Create: `docs/decisions.md`
- Modify: `README.md` (link decisions)

- [ ] **Step 1: Write `docs/decisions.md` with the actual results**

Template — fill every line with measured facts from Tasks 4–10 (no "TBD"):
```markdown
# Decisions and verified facts

Facts verified by the Phase 0 spikes (date: YYYY-MM-DD, better-auth 1.7.1, wrangler 4.125.0, @cloudflare/vite-plugin 1.53.1, @cloudflare/vitest-plugin 1.0.0).

## S1 — workspace paths
- `main: src/worker.ts` importing `@flare-idp/api` source works in `vite dev`, `vite build` and the vitest plugin: yes/no (+ notes).
- `migrations_dir: ../../packages/db/migrations` resolved by wrangler CLI: yes/no (fallback used: …).
- Build output worker dir: `dist/<name>`.

## S2 — bundle + cold start
- Entry JS gzip: N bytes. `wrangler check startup`: N ms CPU. Within budget: yes/no. Mitigation chosen: …

## S3 — passkey on workerd
- Registration/authentication options generate: yes/no. Bogus attestation rejected with APIError status: …

## S4 — OAuth2/OIDC on D1
- Discovery issuer equals baseURL; authorize/token/userinfo/refresh/replay results: …
- `adminCreateOAuthClient` body shape that worked: { … }
- Consent response shape: { … } ; consent redirect path observed: …

## S5 — Email Service + Queue in miniflare
- `env.EMAIL.send` result: … ; extra miniflare config needed: none / `email.send_email` / `queueProducers`…

## S6 — KV secondary storage
- Session cached in KV under raw token: yes/no; D1 `session` row present with `storeSessionInDatabase: true`: yes/no.

## S7 — cookie seam
- Cookie names observed: session `…`, 2FA interim `…`, passkey challenge `…`.
- `returnHeaders: true` forwards Set-Cookie for sign-in/2FA/sign-out: yes/no.

## Consequences for Phase 1
- …
```

- [ ] **Step 2: Link it from README and run the full suite**

Add to `README.md` under the docs list: `- Decisions / verified facts: docs/decisions.md`.
Run: `bun run ci`
Expected: green.

- [ ] **Step 3: Commit**

```sh
git add -A
git commit -m "docs: record Phase 0 spike outcomes in docs/decisions.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage (Phase 0 section): root scaffold ✔ (T1), apps/idp worker + wrangler + vite + vitest ✔ (T1–T2), `wrangler types` ✔ (T1), empty packages ✔ (T1), ci.yml with migration check ✔ (T3), spikes S1–S7 ✔ (T4–T10), decisions.md ✔ (T11). `wrangler-config`/`migrations-lint` tests ported ✔ (T3). Assets fixture ✔ (T1).
- Deliberately deferred to Phase 1: Drizzle schema + `npx auth generate`, env validation middleware, secure headers, rate limiter, `.well-known` root rewrites, Better-Auth allowlist, Scalar/OpenAPI. Phase 0 mounts Better-Auth at `/api/auth/*` unfiltered **for spikes only**; Phase 1's first task replaces `packages/api/src/auth.ts` and adds the allowlist.
- Type consistency: `createAuth(env, options)`, `kvSecondaryStorage(kv)`, `migrateSpikeDb(auth)`, `signUpSpikeUser(auth, jar?)`, `promoteToAdmin(userId)`, `CookieJar.absorb/header/headers/get/names` are used with the same signatures across T5–T8.
- Known uncertainty is isolated to spike assertions that are intentionally flexible (consent response field name, Email Service local return value, table/cookie names) and each has an explicit "record in decisions.md" instruction.
