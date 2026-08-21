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
          include: [
            "test/integration/**/*.test.ts",
            "test/spikes/**/*.test.ts",
          ],
          setupFiles: ["./test/integration/setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
