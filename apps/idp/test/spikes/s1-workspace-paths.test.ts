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
    expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual(["0000_init.sql"]);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_installation'",
    ).all();
    expect(tables.results).toHaveLength(1);
  });
});
