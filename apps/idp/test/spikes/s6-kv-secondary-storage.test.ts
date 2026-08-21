import { env } from "cloudflare:test";
import { kvSecondaryStorage } from "@flare-idp/api";
import { describe, expect, it } from "vitest";
import {
  createSpikeAuth,
  migrateSpikeDb,
  signUpSpikeUser,
} from "./helpers/auth-fixture";

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

describe("S6 sessions with KV secondaryStorage + storeSessionInDatabase", () => {
  it("writes the session row to D1 and caches it in KV; listSessions works", async () => {
    const auth = createSpikeAuth({ useKv: true });
    await migrateSpikeDb(auth);
    const { jar } = await signUpSpikeUser(auth);

    const session = await auth.api.getSession({ headers: jar.headers() });
    expect(session?.user.email).toBe("spike@example.com");

    const rows = await env.DB.prepare(`SELECT token FROM "session"`).all<{
      token: string;
    }>();
    expect(rows.results).toHaveLength(1);

    // Better-Auth stores sessions in secondary storage keyed by the raw token.
    const cached = await env.KV.get(rows.results[0]?.token ?? "");
    expect(cached).not.toBeNull();

    const sessions = await auth.api.listSessions({ headers: jar.headers() });
    expect(sessions).toHaveLength(1);
  });
});
