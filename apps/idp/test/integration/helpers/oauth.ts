import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { CookieJar } from "./cookies";
import { api, completeSetup, SETUP_ADMIN, signIn, TEST_ORIGIN } from "./http";

/** Registered redirect URI for every test client created through here. */
export const REDIRECT_URI = "https://rp.example.com/callback";

/** Completes setup, drops the bootstrap session, signs back in fresh (see account-routes.test.ts). */
export async function setupAdmin(): Promise<CookieJar> {
  const jar = await completeSetup();
  await api("/api/session/sign-out", { method: "POST" }, jar);
  const { jar: adminJar } = await signIn(
    SETUP_ADMIN.email,
    SETUP_ADMIN.password,
  );
  return adminJar;
}

/** Creates an OAuth client through the Task 3 admin facade. */
export async function createOAuthClient(
  jar: CookieJar,
  overrides: Record<string, unknown> = {},
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await api(
    "/api/admin/oauth-clients",
    {
      method: "POST",
      body: JSON.stringify({
        name: "Test RP",
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
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
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
export async function authorize(
  jar: CookieJar,
  params: Record<string, string>,
): Promise<Response> {
  const search = new URLSearchParams(params);
  return SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/authorize?${search}`, {
    redirect: "manual",
    headers: { cookie: jar.header(), accept: "text/html" },
  });
}

/** Standard authorize query; `extra` overrides/extends (e.g. scope, nonce). */
export function authorizeParams(
  clientId: string,
  challenge: string,
  state: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...extra,
  };
}

/** Drives authorize up to the consent redirect and returns its query string. */
export async function captureConsentQuery(
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

/**
 * POST /api/auth/oauth2/token as an RP would: form-encoded, optional Basic
 * auth, server-to-server (no origin header — the endpoint is CSRF-exempt).
 */
export async function tokenRequest(
  body: Record<string, string>,
  creds?: { clientId: string; clientSecret: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (creds) {
    headers.authorization = `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`;
  }
  return SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
}
