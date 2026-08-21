import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  createSpikeAuth,
  migrateSpikeDb,
  promoteToAdmin,
  signUpSpikeUser,
} from "./helpers/auth-fixture";

const BASE = "http://localhost:8787";
// Better-Auth's default basePath ("/api/auth") is appended to baseURL for the
// OIDC issuer — the discovery doc's `issuer` (and id_token `iss`) is
// `${BASE}/api/auth`, not bare `BASE`.
const ISSUER = `${BASE}/api/auth`;
const REDIRECT_URI = "http://localhost:3000/callback";

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

async function createClient(
  auth: ReturnType<typeof createSpikeAuth>,
  adminHeaders: Headers,
  skipConsent: boolean,
) {
  const client = await auth.api.adminCreateOAuthClient({
    body: {
      client_name: skipConsent ? "first-party" : "third-party",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_basic",
      // "web" (the default) rejects loopback redirect_uris outright, even over
      // https — RFC 8252 loopback interchange is reserved for "native" clients.
      // Our REDIRECT_URI is http://localhost:3000/callback, so this must be
      // "native" or the client creation itself is rejected with
      // invalid_redirect_uri ("web clients require https redirect URIs on
      // non-loopback hosts").
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid profile email offline_access",
      skip_consent: skipConsent,
    },
    headers: adminHeaders,
  });
  return client as { client_id: string; client_secret?: string };
}

describe("S4 OAuth2/OIDC on D1", () => {
  it("serves discovery and JWKS with issuer = baseURL + basePath", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const disc = await auth.handler(
      new Request(`${BASE}/api/auth/.well-known/openid-configuration`),
    );
    expect(disc.status).toBe(200);
    const doc = (await disc.json()) as Record<string, string>;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toContain("/oauth2/authorize");
    expect(doc.token_endpoint).toContain("/oauth2/token");
    expect(doc.jwks_uri).toBeTypeOf("string");

    const jwks = await auth.handler(new Request(doc.jwks_uri as string));
    expect(jwks.status).toBe(200);
    const keys = (await jwks.json()) as { keys: Array<{ kty: string }> };
    expect(keys.keys.length).toBeGreaterThan(0);
  });

  it("completes code+PKCE flow for a trusted client, verifies id_token against JWKS, refreshes", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar, userId } = await signUpSpikeUser(auth);
    await promoteToAdmin(userId);
    const client = await createClient(auth, jar.headers(), true);
    expect(client.client_id).toBeTypeOf("string");
    expect(client.client_secret).toBeTypeOf("string");

    const { verifier, challenge } = await pkce();
    const authorizeUrl = new URL(`${BASE}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      state: "xyz",
      nonce: "n-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    const authz = await auth.handler(
      new Request(authorizeUrl, { headers: jar.headers(), redirect: "manual" }),
    );
    expect([302, 303, 307]).toContain(authz.status);
    const location = new URL(authz.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    expect(code).toBeTypeOf("string");

    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const tokenRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      id_token: string;
      refresh_token?: string;
      token_type: string;
    };
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeTypeOf("string");

    // Verify id_token signature + claims against JWKS.
    const jwksRes = await auth.handler(new Request(`${BASE}/api/auth/jwks`));
    const jwks = createLocalJWKSet(await jwksRes.json());
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ISSUER,
      audience: client.client_id,
    });
    expect(payload.sub).toBe(userId);
    expect(payload.nonce).toBe("n-1");

    const userinfo = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(userinfo.status).toBe(200);
    expect(((await userinfo.json()) as { sub: string }).sub).toBe(userId);

    const refreshRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token as string,
        }),
      }),
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).toBeTypeOf("string");
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // Replaying the authorization code must fail (no transactions on D1 — prove replay protection holds).
    const replay = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      }),
    );
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it("requires consent for a non-trusted client and accepts it via POST /oauth2/consent", async () => {
    const auth = createSpikeAuth();
    await migrateSpikeDb(auth);
    const { jar, userId } = await signUpSpikeUser(auth);
    await promoteToAdmin(userId);
    const client = await createClient(auth, jar.headers(), false);
    const { verifier, challenge } = await pkce();

    const authorizeUrl = new URL(`${BASE}/api/auth/oauth2/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      state: "s2",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const authz = await auth.handler(
      new Request(authorizeUrl, { headers: jar.headers(), redirect: "manual" }),
    );
    jar.absorb(authz.headers);
    const location = new URL(authz.headers.get("location") ?? "", BASE);
    // Consent required → redirected to our consentPage, not the RP.
    expect(location.pathname).toBe("/oauth/consent");

    // Better-Auth signs the original authorize query into the consent
    // redirect's own query string (not wrapped in an "oauth_query" key —
    // the whole `location.search` IS the signed oauth_query). The consent
    // endpoint's `before` hook requires that signed string back in
    // `body.oauth_query` to restore the pending-authorization state
    // (server-side, not session-bound) — omitting it fails with
    // `{ error: "invalid_request", error_description: "missing oauth query" }`.
    // The SPA consent page would forward it the same way when POSTing to our facade.
    //
    // Accepting the consent internally re-runs the authorize endpoint, which
    // unconditionally requires `ctx.request` (`if (!ctx.request) throw
    // UNAUTHORIZED "request not found"`) — a real `Request` object, not just
    // `{ body, headers }`. Calling `auth.api.oauth2Consent(...)` directly
    // left `ctx.request` undefined and, even after supplying a `request:`,
    // the re-entrant authorize call's own content negotiation didn't see it
    // as JSON-accepting and `consent.response` came back empty. Routing
    // through `auth.handler` — exactly how the real SPA facade would POST —
    // sidesteps both: a real Request negotiates via its own `accept` header.
    const consentRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: jar.headers({
          "content-type": "application/json",
          accept: "application/json",
        }),
        body: JSON.stringify({
          accept: true,
          scope: "openid profile email",
          oauth_query: location.search.slice(1),
        }),
      }),
    );
    jar.absorb(consentRes.headers);
    expect(consentRes.status).toBe(200);
    const body = (await consentRes.json()) as Record<string, unknown>;
    const redirectTo = Object.values(body).find(
      (v) => typeof v === "string" && v.startsWith(REDIRECT_URI),
    ) as string | undefined;
    expect(
      redirectTo,
      `consent response: ${JSON.stringify(body)}`,
    ).toBeDefined();
    const code = new URL(redirectTo as string).searchParams.get("code");
    expect(code).toBeTypeOf("string");

    const basic = btoa(`${client.client_id}:${client.client_secret}`);
    const tokenRes = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        }),
      }),
    );
    expect(tokenRes.status).toBe(200);
  });
});
