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
    const row = await env.DB.prepare(
      "SELECT status FROM app_installation WHERE id = 1",
    ).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("serves /api/health/ready when DB and KV are reachable", async () => {
    const res = await SELF.fetch("http://localhost/api/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
