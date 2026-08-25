import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * `@flare-idp/api`'s barrel (`packages/api/src/index.ts`) re-exports the
 * production `app`/`auth` singleton (`./http/app`) alongside the pure
 * http/security modules the `unit` project tests. `http/app.ts` imports
 * `cloudflare:workers` and eagerly builds a Better-Auth instance at module
 * scope — neither works outside workerd. Stub ONLY that specific
 * `index.ts -> ./http/app` edge (scoped by importer, not a blanket alias —
 * other files import their own unrelated `./app`) so the barrel resolves
 * without a workerd runtime. Nothing in the `unit` project touches
 * `app`/`auth`; those are covered by the `integration` project's real
 * Workers runtime.
 */
function stubProductionAuthApp(): Plugin {
  const stubPath = fileURLToPath(
    new URL("./test/unit/shims/api-app-stub.ts", import.meta.url),
  );
  return {
    name: "stub-production-auth-app",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "./http/app" &&
        importer?.endsWith("/packages/api/src/index.ts")
      ) {
        return stubPath;
      }
      return null;
    },
  };
}

export const TEST_BINDINGS = {
  APP_NAME: "flare-idp (test)",
  APP_URL: "http://localhost:8787",
  ENVIRONMENT: "test",
  AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef0123456789",
  SETUP_SECRET: "test-setup-secret",
  OUTBOUND_EMAIL_FROM: "noreply@example.com",
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [stubProductionAuthApp()],
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["test/unit/**/*.test.{ts,tsx}"],
          exclude: ["test/unit/{wrangler-config,migrations-lint}.test.ts"],
          setupFiles: ["./test/unit/setup.ts"],
        },
      },
      {
        test: {
          name: "unit-fs",
          environment: "node",
          include: ["test/unit/{wrangler-config,migrations-lint}.test.ts"],
          setupFiles: ["./test/unit/setup.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations(
              "../../packages/db/migrations",
            );
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // Assets: a tiny stand-in for dist/client so the SPA passthrough
                // is exercised without a Vite build.
                assets: {
                  directory: "./test/fixtures/assets",
                  binding: "ASSETS",
                  routerConfig: {
                    has_user_worker: true,
                    invoke_user_worker_ahead_of_assets: true,
                  },
                  assetConfig: {
                    not_found_handling: "single-page-application",
                  },
                },
                bindings: { ...TEST_BINDINGS, TEST_MIGRATIONS: migrations },
              },
            };
          }),
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["./test/integration/setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
