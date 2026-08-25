import { SELF } from "cloudflare:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import type { CookieJar } from "./helpers/cookies";
import { resetDatabase } from "./helpers/db";
import { api, TEST_ORIGIN } from "./helpers/http";
import {
  authorize,
  authorizeParams,
  createOAuthClient,
  pkce,
  REDIRECT_URI,
  setupAdmin,
  tokenRequest,
} from "./helpers/oauth";

beforeEach(resetDatabase);

const FULL_SCOPE = "openid profile email offline_access";

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type RfcError = { error?: string; error_description?: string };

async function currentUserId(jar: CookieJar): Promise<string> {
  const res = await api("/api/session", {}, jar);
  const body = (await res.json()) as { user: { id: string } | null };
  if (!body.user?.id) throw new Error("no signed-in user");
  return body.user.id;
}

/**
 * Signs in the admin, creates a confidential TRUSTED (skipConsent) client
 * with the full user-delegated scope set, and drives authorize (GET, PKCE
 * S256, nonce) straight to the redirect URI (no consent hop) — returning
 * everything needed for the token exchange.
 */
async function trustedAuthCodeFlow(
  clientOverrides: Record<string, unknown> = {},
) {
  const jar = await setupAdmin();
  const userId = await currentUserId(jar);
  const { clientId, clientSecret } = await createOAuthClient(jar, {
    skipConsent: true,
    scope: ["openid", "profile", "email", "offline_access"],
    grantTypes: ["authorization_code", "refresh_token"],
    ...clientOverrides,
  });
  const { verifier, challenge } = await pkce();
  const state = "oidc-flow-state";
  const nonce = "oidc-flow-nonce-42";

  const res = await authorize(
    jar,
    authorizeParams(clientId, challenge, state, { scope: FULL_SCOPE, nonce }),
  );
  expect(res.status).toBe(302);
  const location = res.headers.get("location");
  if (!location) throw new Error("authorize 302 had no Location header");
  const redirect = new URL(location);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
  expect(redirect.searchParams.get("state")).toBe(state);
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("authorize redirect carried no code");

  return { jar, userId, clientId, clientSecret, code, verifier, nonce };
}

async function exchangeCode(flow: {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
}): Promise<Response> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      code: flow.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: flow.verifier,
    },
    { clientId: flow.clientId, clientSecret: flow.clientSecret },
  );
}

async function userinfo(accessToken: string): Promise<Response> {
  return SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function introspect(
  token: string,
  creds: { clientId: string; clientSecret: string },
): Promise<{ active: boolean }> {
  const res = await SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/introspect`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(creds.clientId, creds.clientSecret),
    },
    body: new URLSearchParams({ token }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { active: boolean };
}

describe("authorization-code + PKCE happy path (confidential trusted client)", () => {
  it("issues access, id and refresh tokens with bearer type and expiry", async () => {
    const flow = await trustedAuthCodeFlow();

    const tokenRes = await exchangeCode(flow);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as TokenResponse;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect((tokens.token_type ?? "").toLowerCase()).toBe("bearer");
    expect(typeof tokens.expires_in).toBe("number");
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  it("issues an id_token verifiable against our JWKS with iss/aud/sub/nonce and the role claim", async () => {
    const flow = await trustedAuthCodeFlow();
    const tokenRes = await exchangeCode(flow);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as TokenResponse;
    if (!tokens.id_token) throw new Error("no id_token issued");

    const jwksRes = await SELF.fetch(`${TEST_ORIGIN}/.well-known/jwks.json`);
    expect(jwksRes.status).toBe(200);
    const jwks = createLocalJWKSet(
      (await jwksRes.json()) as Parameters<typeof createLocalJWKSet>[0],
    );

    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: TEST_ORIGIN, // test APP_URL — the bare origin, not /api/auth
      audience: flow.clientId,
    });
    expect(payload.sub).toBe(flow.userId);
    expect(payload.nonce).toBe(flow.nonce);
    // customIdTokenClaims: the setup admin's role.
    expect(payload.role).toBe("admin");
  });

  it("serves userinfo (GET, Bearer) with sub and the custom role claim", async () => {
    const flow = await trustedAuthCodeFlow();
    const tokenRes = await exchangeCode(flow);
    const tokens = (await tokenRes.json()) as TokenResponse;
    if (!tokens.access_token) throw new Error("no access_token issued");

    const res = await userinfo(tokens.access_token);
    expect(res.status).toBe(200);
    const claims = (await res.json()) as { sub?: string; role?: string };
    expect(claims.sub).toBe(flow.userId);
    expect(claims.role).toBe("admin");
  });
});

describe("refresh_token grant", () => {
  it("rotates the refresh token and rejects reuse of the old one (400 invalid_grant)", async () => {
    const flow = await trustedAuthCodeFlow();
    const tokenRes = await exchangeCode(flow);
    const first = (await tokenRes.json()) as TokenResponse;
    if (!first.refresh_token) throw new Error("no refresh_token issued");

    const refreshRes = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: first.refresh_token },
      { clientId: flow.clientId, clientSecret: flow.clientSecret },
    );
    expect(refreshRes.status).toBe(200);
    const second = (await refreshRes.json()) as TokenResponse;
    expect(second.access_token).toBeTruthy();
    expect(second.access_token).not.toBe(first.access_token);
    // Rotation: a NEW refresh token replaces the old one.
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Reusing the OLD (rotated-out) refresh token: 400 invalid_grant
    // (refreshTokenReuseInterval defaults to 0 — no replay grace).
    const reuseRes = await tokenRequest(
      { grant_type: "refresh_token", refresh_token: first.refresh_token },
      { clientId: flow.clientId, clientSecret: flow.clientSecret },
    );
    expect(reuseRes.status).toBe(400);
    const reuseBody = (await reuseRes.json()) as RfcError;
    expect(reuseBody.error).toBe("invalid_grant");
  });
});

describe("authorization-code replay", () => {
  it("rejects a second exchange of the same code (400 invalid_grant)", async () => {
    const flow = await trustedAuthCodeFlow();

    const firstRes = await exchangeCode(flow);
    expect(firstRes.status).toBe(200);

    const replayRes = await exchangeCode(flow);
    expect(replayRes.status).toBe(400);
    const body = (await replayRes.json()) as RfcError;
    expect(body.error).toBe("invalid_grant");
  });
});

describe("public client (token_endpoint_auth_method none) without PKCE", () => {
  it("fails at AUTHORIZE: 302 to redirect_uri with error=invalid_request (pkce required)", async () => {
    const jar = await setupAdmin();
    const { clientId } = await createOAuthClient(jar, {
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      skipConsent: true,
    });

    // No code_challenge / code_challenge_method at all: requirePKCE defaults
    // to true for every client, so authorize itself refuses — as an OAuth
    // error redirect back to the redirect_uri, not an HTTP error status.
    const res = await authorize(jar, {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile",
      state: "no-pkce-state",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    if (!location) throw new Error("authorize 302 had no Location header");
    const redirect = new URL(location);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("code")).toBeNull();
    expect(redirect.searchParams.get("error")).toBe("invalid_request");
    expect(redirect.searchParams.get("error_description")).toContain("pkce");
    expect(redirect.searchParams.get("state")).toBe("no-pkce-state");
  });
});

describe("client_credentials grant", () => {
  it("issues an access token (no id_token, no refresh_token) scoped to the client's machine scopes", async () => {
    const jar = await setupAdmin();
    const { clientId, clientSecret } = await createOAuthClient(jar, {
      grantTypes: ["authorization_code", "client_credentials"],
      clientCredentialsScopes: ["api"],
    });

    const res = await tokenRequest(
      { grant_type: "client_credentials" },
      { clientId, clientSecret },
    );
    expect(res.status).toBe(200);
    const tokens = (await res.json()) as TokenResponse;
    expect(tokens.access_token).toBeTruthy();
    expect((tokens.token_type ?? "").toLowerCase()).toBe("bearer");
    // M2M: no user, so no id_token; no offline_access, so no refresh_token.
    expect(tokens.id_token).toBeUndefined();
    expect(tokens.refresh_token).toBeUndefined();
    // Defaults to the full client_credentials_scopes assignment.
    expect(tokens.scope).toBe("api");

    // userinfo requires the openid scope, which client_credentials tokens
    // can never carry (user-delegated) → 400 invalid_scope.
    const uiRes = await userinfo(tokens.access_token ?? "");
    expect(uiRes.status).toBe(400);
    const uiBody = (await uiRes.json()) as RfcError;
    expect(uiBody.error).toBe("invalid_scope");
  });

  it("refuses the grant for a confidential client with no clientCredentialsScopes assigned (400 unauthorized_client)", async () => {
    const jar = await setupAdmin();
    // Grant configured, but NO machine-scope assignment: the plugin refuses
    // outright ("client has no authorized client_credentials scopes").
    const { clientId, clientSecret } = await createOAuthClient(jar, {
      grantTypes: ["authorization_code", "client_credentials"],
    });

    const res = await tokenRequest(
      { grant_type: "client_credentials" },
      { clientId, clientSecret },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as RfcError;
    expect(body.error).toBe("unauthorized_client");
  });
});

describe("introspection and revocation", () => {
  it("reports its own access token active, and inactive after revocation", async () => {
    const flow = await trustedAuthCodeFlow();
    const tokenRes = await exchangeCode(flow);
    const tokens = (await tokenRes.json()) as TokenResponse;
    if (!tokens.access_token) throw new Error("no access_token issued");
    const creds = { clientId: flow.clientId, clientSecret: flow.clientSecret };

    const before = await introspect(tokens.access_token, creds);
    expect(before.active).toBe(true);

    const revokeRes = await SELF.fetch(
      `${TEST_ORIGIN}/api/auth/oauth2/revoke`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicAuth(creds.clientId, creds.clientSecret),
        },
        body: new URLSearchParams({ token: tokens.access_token }).toString(),
      },
    );
    expect(revokeRes.status).toBe(200);

    const after = await introspect(tokens.access_token, creds);
    expect(after.active).toBe(false);
  });
});

describe("token endpoint rate limit", () => {
  it("returns an RFC-shaped 429 after 30 requests from one IP in the window", async () => {
    const garbage = () =>
      tokenRequest({ grant_type: "authorization_code", code: "not-a-code" });

    for (let i = 0; i < 30; i += 1) {
      const res = await garbage();
      expect(res.status).not.toBe(429);
    }

    const over = await garbage();
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBeTruthy();
    const body = (await over.json()) as RfcError;
    // RFC 6749 §5.2 shape (not our envelope): RP libraries parse `error`.
    expect(body.error).toBe("temporarily_unavailable");
    expect(typeof body.error_description).toBe("string");
  });
});
