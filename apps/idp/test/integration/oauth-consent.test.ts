import { SELF } from "cloudflare:test";
import { errorBodySchema } from "@flare-idp/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { CookieJar } from "./helpers/cookies";
import { resetDatabase } from "./helpers/db";
import {
  api,
  completeSetup,
  SETUP_ADMIN,
  signIn,
  TEST_ORIGIN,
} from "./helpers/http";

beforeEach(resetDatabase);

const CONSENT = "/api/oauth/consent";
const REDIRECT_URI = "https://rp.example.com/callback";

type ConsentInfoBody = {
  client: { clientId: string; name?: string; logoUri?: string };
  scopes: Array<{ id: string; description: string }>;
};

/** Completes setup, drops the bootstrap session, signs back in fresh (see account-routes.test.ts). */
async function setupAdmin(): Promise<CookieJar> {
  const jar = await completeSetup();
  await api("/api/session/sign-out", { method: "POST" }, jar);
  const { jar: adminJar } = await signIn(
    SETUP_ADMIN.email,
    SETUP_ADMIN.password,
  );
  return adminJar;
}

/** Creates a confidential client through the Task 3 admin facade. */
async function createClient(
  jar: CookieJar,
  overrides: Record<string, unknown> = {},
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await api(
    "/api/admin/oauth-clients",
    {
      method: "POST",
      body: JSON.stringify({
        name: "Consent Test RP",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["authorization_code", "refresh_token"],
        scope: ["openid", "profile"],
        skipConsent: false,
        ...overrides,
      }),
    },
    jar,
  );
  if (res.status !== 201) {
    throw new Error(`client create failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    client: { clientId: string };
    clientSecret?: string;
  };
  return {
    clientId: body.client.clientId,
    clientSecret: body.clientSecret ?? "",
  };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 7636 S256 verifier/challenge pair. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64url(random);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * GET /api/auth/oauth2/authorize as a browser navigation (accept: text/html,
 * no sec-fetch-mode) so Better-Auth answers with a real 302 rather than the
 * `{ redirect, url }` JSON it produces for fetch-style requests.
 */
async function authorize(
  jar: CookieJar,
  params: Record<string, string>,
): Promise<Response> {
  const search = new URLSearchParams(params);
  return SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/authorize?${search}`, {
    redirect: "manual",
    headers: { cookie: jar.header(), accept: "text/html" },
  });
}

function authorizeParams(
  clientId: string,
  challenge: string,
  state: string,
): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
}

/** Drives authorize up to the consent redirect and returns its query string. */
async function captureConsentQuery(
  jar: CookieJar,
  clientId: string,
  challenge: string,
  state: string,
): Promise<string> {
  const res = await authorize(jar, authorizeParams(clientId, challenge, state));
  expect(res.status).toBe(302);
  const location = res.headers.get("location");
  if (!location) throw new Error("authorize 302 had no Location header");
  const url = new URL(location, TEST_ORIGIN);
  expect(url.pathname).toBe("/oauth/consent");
  return url.search;
}

describe("GET /api/oauth/consent", () => {
  it("requires authentication (401)", async () => {
    const res = await api(`${CONSENT}?client_id=whatever`);
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns the client's public info plus descriptions for the requested scopes, filtering unknown ones", async () => {
    const adminJar = await setupAdmin();
    const { clientId } = await createClient(adminJar);

    const query = new URLSearchParams({
      client_id: clientId,
      scope: "openid profile not-a-real-scope",
    });
    const res = await api(`${CONSENT}?${query}`, {}, adminJar);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConsentInfoBody;
    expect(body.client.clientId).toBe(clientId);
    expect(body.client.name).toBe("Consent Test RP");
    expect(body.scopes).toEqual([
      { id: "openid", description: "Sign you in and identify you" },
      { id: "profile", description: "Read your name and profile picture" },
    ]);
    // The public-info endpoint must never surface secret material.
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("returns 404 not_found for an unknown client", async () => {
    const adminJar = await setupAdmin();

    const res = await api(`${CONSENT}?client_id=does-not-exist`, {}, adminJar);
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});

describe("POST /api/oauth/consent", () => {
  it("requires authentication (401)", async () => {
    const res = await api(CONSENT, {
      method: "POST",
      body: JSON.stringify({ accept: true, oauthQuery: "client_id=x" }),
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a missing oauthQuery (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();

    const res = await api(
      CONSENT,
      { method: "POST", body: JSON.stringify({ accept: true }) },
      adminJar,
    );
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects a garbled oauthQuery whose signature does not verify (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();
    const { clientId } = await createClient(adminJar);

    const forged = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid",
      sig: "forged-signature",
      exp: String(Math.floor(Date.now() / 1000) + 600),
    });
    const res = await api(
      CONSENT,
      {
        method: "POST",
        body: JSON.stringify({ accept: true, oauthQuery: forged.toString() }),
      },
      adminJar,
    );
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("completes the full authorize -> consent -> code -> token flow for a non-trusted client", async () => {
    const adminJar = await setupAdmin();
    const { clientId, clientSecret } = await createClient(adminJar);
    const { verifier, challenge } = await pkce();
    const state = "flow-state-42";

    // 1. authorize redirects the signed-in browser to the consent page.
    const oauthQuery = await captureConsentQuery(
      adminJar,
      clientId,
      challenge,
      state,
    );

    // The consent path itself is an SPA route: the Worker's asset fallback
    // serves the app shell; the query string is what the SPA (and this test)
    // actually consumes.
    const page = await SELF.fetch(`${TEST_ORIGIN}/oauth/consent`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    // 2. the consent decision goes through OUR facade.
    const consentRes = await api(
      CONSENT,
      {
        method: "POST",
        body: JSON.stringify({
          accept: true,
          scope: ["openid", "profile"],
          oauthQuery,
        }),
      },
      adminJar,
    );
    expect(consentRes.status).toBe(200);
    const { redirectTo } = (await consentRes.json()) as { redirectTo: string };
    const redirect = new URL(redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    const code = redirect.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe(state);

    // 3. the RP exchanges the code at the token endpoint (form-encoded,
    // Basic auth) — server-to-server, no origin header needed (CSRF-exempt).
    const tokenRes = await SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      id_token?: string;
      token_type?: string;
    };
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();
    expect((tokens.token_type ?? "").toLowerCase()).toBe("bearer");
  });

  it("returns a redirectTo carrying error=access_denied when the user denies", async () => {
    const adminJar = await setupAdmin();
    const { clientId } = await createClient(adminJar);
    const { challenge } = await pkce();
    const state = "deny-state-7";

    const oauthQuery = await captureConsentQuery(
      adminJar,
      clientId,
      challenge,
      state,
    );

    const res = await api(
      CONSENT,
      {
        method: "POST",
        body: JSON.stringify({ accept: false, oauthQuery }),
      },
      adminJar,
    );
    expect(res.status).toBe(200);
    const { redirectTo } = (await res.json()) as { redirectTo: string };
    const redirect = new URL(redirectTo);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("code")).toBeNull();
    expect(redirect.searchParams.get("state")).toBe(state);
  });

  it("skips the consent hop entirely for a trusted (skipConsent) client", async () => {
    const adminJar = await setupAdmin();
    const { clientId } = await createClient(adminJar, { skipConsent: true });
    const { challenge } = await pkce();
    const state = "trusted-state-9";

    const res = await authorize(
      adminJar,
      authorizeParams(clientId, challenge, state),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    if (!location) throw new Error("authorize 302 had no Location header");
    const redirect = new URL(location);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("code")).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBe(state);
  });
});
