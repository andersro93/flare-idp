import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

// Every checked-in D1 migration is applied before each test file so tests
// run against the real schema. applyD1Migrations only applies new ones.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
