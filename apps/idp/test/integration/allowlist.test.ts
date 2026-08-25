import { SELF } from "cloudflare:test";
import { BETTER_AUTH_ALLOWLIST } from "@flare-idp/api";
import { errorBodySchema } from "@flare-idp/shared";
import { describe, expect, it } from "vitest";

describe("Better-Auth allowlist", () => {
  it("is exactly the Phase 1 allowlist (growth is a conscious diff)", () => {
    expect(BETTER_AUTH_ALLOWLIST).toEqual(["/api/auth/jwks"]);
  });

  it("GET /api/auth/jwks returns the key set", async () => {
    const res = await SELF.fetch("http://localhost/api/auth/jwks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
  });

  it("GET /.well-known/jwks.json rewrites to the same handler", async () => {
    const res = await SELF.fetch("http://localhost/.well-known/jwks.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
  });

  it.each([
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/auth/admin/list-users"],
  ])(
    "%s %s (not allowlisted) returns the 404 envelope",
    async (method, path) => {
      const res = await SELF.fetch(`http://localhost${path}`, { method });
      expect(res.status).toBe(404);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("not_found");
    },
  );
});
