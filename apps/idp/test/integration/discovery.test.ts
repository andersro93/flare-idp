import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type OidcDiscoveryDoc = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
};

describe("OIDC discovery", () => {
  it("GET /.well-known/openid-configuration serves the discovery doc at the bare origin", async () => {
    const res = await SELF.fetch(
      "http://localhost/.well-known/openid-configuration",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OidcDiscoveryDoc;

    // Pins the Phase 1 `jwt.issuer` knob: the issuer must be the bare
    // APP_URL origin, not `${APP_URL}/api/auth`.
    expect(body.issuer).toBe("http://localhost:8787");
    expect(typeof body.authorization_endpoint).toBe("string");
    expect(body.authorization_endpoint).toContain("/api/auth/");
    expect(typeof body.token_endpoint).toBe("string");
    expect(body.token_endpoint).toContain("/api/auth/");
    expect(typeof body.userinfo_endpoint).toBe("string");
    expect(body.userinfo_endpoint).toContain("/api/auth/");
    expect(typeof body.jwks_uri).toBe("string");
    expect(body.jwks_uri).toContain("/api/auth/");
  });

  it("same doc is served at the allowlisted /api/auth path", async () => {
    const res = await SELF.fetch(
      "http://localhost/api/auth/.well-known/openid-configuration",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OidcDiscoveryDoc;
    expect(body.issuer).toBe("http://localhost:8787");
  });

  it("GET /.well-known/oauth-authorization-server serves the OAuth server metadata doc", async () => {
    const res = await SELF.fetch(
      "http://localhost/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string };
    expect(body.issuer).toBe("http://localhost:8787");
  });

  it.each([
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ])(
    "%s advertises only user-delegated scopes (machine scopes stay unpublished)",
    async (path) => {
      const res = await SELF.fetch(`http://localhost${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scopes_supported?: string[] };
      // `advertisedMetadata.scopes_supported` pins the public docs to the
      // user-delegated set; the internal M2M "api" scope is issuable via
      // client_credentials but deliberately not advertised.
      expect(body.scopes_supported).toEqual([
        "openid",
        "profile",
        "email",
        "offline_access",
      ]);
    },
  );

  it.each([
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ])(
    "POST %s (GET-only root rewrite) falls to Hono's default 404, not our envelope or the discovery doc",
    async (path) => {
      const res = await SELF.fetch(`http://localhost${path}`, {
        method: "POST",
      });
      // These root routes are registered as `app.get(...)`; a POST matches
      // no route at all (they sit above/outside the `/api/*` prefix, so
      // neither the `/api/*` 404 envelope catcher nor the `app.get("*")`
      // SPA/asset fallthrough — itself GET-only — apply). Hono's router
      // falls back to its OWN default not-found response: 404, plain text
      // "404 Not Found", NOT our JSON error envelope.
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("404 Not Found");
    },
  );
});
