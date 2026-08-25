import { SELF } from "cloudflare:test";
import { BETTER_AUTH_ALLOWLIST } from "@flare-idp/api";
import { errorBodySchema } from "@flare-idp/shared";
import { describe, expect, it } from "vitest";

describe("Better-Auth allowlist", () => {
  it("is exactly the Phase 2 allowlist (growth is a conscious diff)", () => {
    expect(BETTER_AUTH_ALLOWLIST).toEqual([
      { path: "/api/auth/jwks", methods: ["GET"] },
      { path: "/api/auth/oauth2/authorize", methods: ["GET", "POST"] },
      { path: "/api/auth/oauth2/token", methods: ["POST"] },
      { path: "/api/auth/oauth2/userinfo", methods: ["GET", "POST"] },
      { path: "/api/auth/oauth2/introspect", methods: ["POST"] },
      { path: "/api/auth/oauth2/revoke", methods: ["POST"] },
      {
        path: "/api/auth/.well-known/openid-configuration",
        methods: ["GET"],
      },
      {
        path: "/api/auth/.well-known/oauth-authorization-server",
        methods: ["GET"],
      },
    ]);
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
    // Only exact-path GET/POST to /api/auth/jwks is allowlisted — other
    // methods to that same path, and other methods to any other
    // /api/auth/* path, must never reach `auth.handler` either.
    ["PUT", "/api/auth/jwks"],
    ["DELETE", "/api/auth/jwks"],
    ["PATCH", "/api/auth/jwks"],
    ["POST", "/api/auth/jwks"],
    ["PUT", "/api/auth/sign-in/email"],
    // Method-aware allowlist entries reject the wrong method too.
    ["GET", "/api/auth/oauth2/token"],
    ["POST", "/api/auth/.well-known/openid-configuration"],
  ])(
    "%s %s (not allowlisted) returns the 404 envelope",
    async (method, path) => {
      const res = await SELF.fetch(`http://localhost${path}`, { method });
      expect(res.status).toBe(404);
      const body = errorBodySchema.parse(await res.json());
      expect(body.error.code).toBe("not_found");
    },
  );

  it("POST /api/auth/oauth2/authorize (allowlisted method) is NOT our 404 envelope", async () => {
    // Allowlisted → reaches Better-Auth, which will reject the garbage body
    // with its own protocol error. Any status is acceptable here (it's not
    // our route); what matters is that it never falls through to our
    // `not_found` envelope.
    const res = await SELF.fetch("http://localhost/api/auth/oauth2/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const text = await res.text();
    expect(text).not.toContain('"code":"not_found"');
  });
});
