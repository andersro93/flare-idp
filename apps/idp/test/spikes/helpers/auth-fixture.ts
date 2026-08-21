import { env } from "cloudflare:test";
import { type Auth, createAuth } from "@flare-idp/api";
import { getMigrations } from "better-auth/db/migration";
import { CookieJar } from "./cookies";

export const SPIKE_USER = {
  email: "spike@example.com",
  password: "correct-horse-battery-staple",
  name: "Spike",
};

/** Create a Better-Auth instance for spikes (native D1; optional KV). */
export function createSpikeAuth(options: { useKv?: boolean } = {}): Auth {
  return createAuth(env, options);
}

type IndexIntrospectionRow = {
  tableName: string;
  indexName: string;
  columnName: string;
  isUnique: number;
  isPartial: number;
  columnPosition: number;
};

/**
 * D1's SQL authorizer rejects `pragma_index_list`/`pragma_index_info` used as
 * table-valued functions in a `SELECT ... FROM ... JOIN pragma_index_list(...)`
 * (`D1_ERROR: not authorized: SQLITE_AUTH`) — exactly the query shape
 * Better-Auth's Kysely migrator issues to introspect existing indexes before
 * diffing (`getDatabaseIndexes` in `better-auth/dist/db/get-migration.mjs`).
 * The *statement* forms `PRAGMA index_list(table)` / `PRAGMA index_info(index)`
 * are allowed by D1, so we reconstruct the same row shape by driving those
 * instead and hand the migrator an equivalent result set. Every other query
 * passes through to the real D1 binding untouched.
 */
async function realIndexRows(db: D1Database): Promise<IndexIntrospectionRow[]> {
  // Exclude sqlite's own bookkeeping tables and D1's internal `_cf_%` tables
  // (e.g. `_cf_METADATA`) — D1's authorizer rejects PRAGMA introspection
  // against `_cf_%` tables outright (`SQLITE_AUTH`), and Better-Auth's own
  // D1 introspector applies the same exclusion when listing tables.
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`,
    )
    .all<{
      name: string;
    }>();
  const rows: IndexIntrospectionRow[] = [];
  for (const { name: tableName } of tables.results) {
    const indexes = await db.prepare(`PRAGMA index_list("${tableName}")`).all<{
      name: string;
      unique: number;
      partial: number;
    }>();
    for (const idx of indexes.results) {
      const columns = await db.prepare(`PRAGMA index_info("${idx.name}")`).all<{
        seqno: number;
        name: string | null;
      }>();
      for (const column of columns.results) {
        // Expression index columns report name = null; skip (not a real column).
        if (column.name === null) continue;
        rows.push({
          tableName,
          indexName: idx.name,
          columnName: column.name,
          isUnique: idx.unique,
          isPartial: idx.partial,
          columnPosition: column.seqno,
        });
      }
    }
  }
  return rows;
}

function d1WithAllowedIndexIntrospection(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (!sql.includes("pragma_index_list")) return target.prepare(sql);
          return {
            bind: () => ({
              all: async () => ({
                results: await realIndexRows(target),
                success: true,
                meta: {},
              }),
            }),
          };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as D1Database;
}

/**
 * `@cloudflare/vitest-plugin` 1.0.0 advertises "isolated per-test storage",
 * but that isolation does not extend to D1 in practice: within one test
 * file, D1 rows written by an earlier `it()` are still present in a later
 * `it()` (KV does not show this — the S6 adapter tests use disjoint keys
 * and never observed leakage). Rather than rely on that isolation, drop
 * every Better-Auth-managed table before each migration so `migrateSpikeDb`
 * always hands back a genuinely empty schema, independent of what earlier
 * tests in the same file left behind.
 */
async function dropExistingAuthTables(db: D1Database): Promise<void> {
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         AND name NOT IN ('d1_migrations', 'app_installation')`,
    )
    .all<{ name: string }>();
  // `sqlite_master` lists tables in creation order, and Better-Auth creates
  // FK targets before their referencing tables (e.g. "user" before
  // "oauthClient", which has a FK to "user"). D1 revalidates a table's own
  // FK targets when it is dropped, so dropping "user" before "oauthClient"
  // fails "oauthClient"'s drop with a stale `no such table: main.user`.
  // Dropping in reverse creation order drops referencing (child) tables
  // before the tables they reference (parents), avoiding that.
  for (const { name } of [...tables.results].reverse()) {
    await db.prepare(`DROP TABLE "${name}"`).run();
  }
}

/** Create Better-Auth tables in D1 via the Kysely migrator (always fresh — see `dropExistingAuthTables`). */
export async function migrateSpikeDb(auth: Auth): Promise<void> {
  const rawDatabase = auth.options.database as D1Database;
  await dropExistingAuthTables(rawDatabase);
  const database = d1WithAllowedIndexIntrospection(rawDatabase);
  const { runMigrations } = await getMigrations({ ...auth.options, database });
  await runMigrations();
}

/** Sign up SPIKE_USER and return a jar holding the session cookie. */
export async function signUpSpikeUser(
  auth: Auth,
  jar = new CookieJar(),
): Promise<{ jar: CookieJar; userId: string }> {
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
  await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?1`)
    .bind(userId)
    .run();
}
