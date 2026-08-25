import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const OAUTH_TABLES = [
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
  "oauth_client_resource",
  "oauth_client",
  "oauth_resource",
  "oauth_client_assertion",
] as const;

describe("oauth-provider schema", () => {
  it("applied the 0001 migration's oauth tables", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%'`,
    ).all<{ name: string }>();
    const names = (results ?? []).map((r) => r.name).sort();
    expect(names).toEqual([...OAUTH_TABLES].sort());
  });

  it.each(OAUTH_TABLES)("can query %s", async (table) => {
    const row = await env.DB.prepare(
      `SELECT count(*) as n FROM "${table}"`,
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
