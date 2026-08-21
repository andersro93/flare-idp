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
