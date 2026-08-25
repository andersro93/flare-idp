#!/usr/bin/env bun
/**
 * End-to-end OIDC smoke test against a RUNNING flare-idp instance (dev
 * server or production). Runs on Bun's Node-ish runtime — plain `fetch`,
 * no workerd/cloudflare:test involved.
 *
 *   bun scripts/oidc-smoke.ts --base http://localhost:5173 \
 *     --email admin@example.com --password <password>
 *
 * Flow: facade sign-in (cookie jar) → create a temporary confidential
 * TRUSTED client via the admin facade → authorize (PKCE S256, manual
 * redirect) → code → token (Basic) → verify id_token against the JWKS
 * (iss/aud/sub/nonce) → userinfo → refresh grant (rotation) → revoke (+
 * introspect confirms inactive) → delete the temp client.
 *
 * Prints PASS/FAIL per step and exits non-zero on any failure. Never
 * prints tokens or the password.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

// ---------------------------------------------------------------- args

function parseArgs(argv: string[]): {
  base: string;
  email: string;
  password: string;
} {
  const args = new Map<string, string>();
  const positional = argv.filter((a) => a !== "--");
  for (let i = 0; i < positional.length; i++) {
    const arg = positional[i];
    if (arg?.startsWith("--")) {
      const value = positional[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`missing value for ${arg}`);
      }
      args.set(arg.slice(2), value);
      i++;
    }
  }
  const base = args.get("base");
  const email = args.get("email");
  const password = args.get("password");
  if (!base || !email || !password) {
    fail(
      "usage: bun scripts/oidc-smoke.ts --base <url> --email <email> --password <password>",
    );
  }
  return { base: new URL(base).origin, email, password };
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------- cookie jar

/** Minimal cookie jar: absorbs Set-Cookie headers, emits a Cookie header. */
class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const [pair] = raw.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(raw)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// ------------------------------------------------------------- helpers

const { base, email, password } = parseArgs(process.argv.slice(2));
const jar = new CookieJar();

/** Facade request: same-origin JSON with the session cookie jar. */
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", base);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("cookie", jar.header());
  const res = await fetch(`${base}${path}`, { ...init, headers });
  jar.absorb(res.headers);
  return res;
}

async function expectStatus(res: Response, status: number): Promise<void> {
  if (res.status !== status) {
    // Error bodies from these endpoints never carry tokens or credentials.
    const body = (await res.text()).slice(0, 300);
    throw new Error(`expected ${status}, got ${res.status}: ${body}`);
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

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

async function tokenRequest(
  body: Record<string, string>,
  creds: { clientId: string; clientSecret: string },
): Promise<Response> {
  return fetch(`${base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: new URLSearchParams(body).toString(),
  });
}

let stepFailed = false;

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run();
    console.log(`PASS  ${name}`);
    return value;
  } catch (error) {
    stepFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL  ${name}: ${message}`);
    throw error;
  }
}

// ---------------------------------------------------------------- flow

const REDIRECT_URI = "https://oidc-smoke.example.com/callback";
const SCOPE = "openid profile email offline_access";

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
};

async function main(): Promise<void> {
  const userId = await step("sign in via facade", async () => {
    const res = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await expectStatus(res, 200);
    const body = (await res.json()) as { user: { id: string } };
    if (!body.user?.id) throw new Error("sign-in response had no user id");
    return body.user.id;
  });

  const issuer = await step("discovery document", async () => {
    const res = await fetch(`${base}/.well-known/openid-configuration`);
    await expectStatus(res, 200);
    const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
    if (!doc.issuer) throw new Error("discovery document had no issuer");
    if (!doc.jwks_uri) throw new Error("discovery document had no jwks_uri");
    return doc.issuer;
  });

  let clientId = "";
  let clientSecret = "";

  try {
    await step("create temp confidential trusted client", async () => {
      const res = await api("/api/admin/oauth-clients", {
        method: "POST",
        body: JSON.stringify({
          name: "oidc-smoke temp client",
          redirectUris: [REDIRECT_URI],
          tokenEndpointAuthMethod: "client_secret_basic",
          grantTypes: ["authorization_code", "refresh_token"],
          scope: ["openid", "profile", "email", "offline_access"],
          skipConsent: true,
        }),
      });
      await expectStatus(res, 201);
      const body = (await res.json()) as {
        client: { clientId: string };
        clientSecret?: string;
      };
      clientId = body.client.clientId;
      clientSecret = body.clientSecret ?? "";
      if (!clientId || !clientSecret) {
        throw new Error("create response missing clientId or clientSecret");
      }
    });

    const { verifier, challenge } = await pkce();
    const state = crypto.randomUUID();
    const nonce = crypto.randomUUID();

    const code = await step("authorize (PKCE S256, trusted skip)", async () => {
      const search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const res = await fetch(`${base}/api/auth/oauth2/authorize?${search}`, {
        redirect: "manual",
        headers: { cookie: jar.header(), accept: "text/html" },
      });
      // Better-Auth answers browser navigations with a real 302 and
      // fetch-style requests with 200 `{ redirect: true, url }` (its
      // heuristic differs between runtimes) — accept both, they carry the
      // same redirect target.
      let location: string;
      if (res.status === 302) {
        const header = res.headers.get("location");
        if (!header) throw new Error("authorize 302 had no Location header");
        location = header;
      } else {
        await expectStatus(res, 200);
        const body = (await res.json()) as { redirect?: boolean; url?: string };
        if (!body.redirect || !body.url) {
          throw new Error("authorize 200 body was not { redirect: true, url }");
        }
        location = body.url;
      }
      const url = new URL(location, base);
      if (`${url.origin}${url.pathname}` !== REDIRECT_URI) {
        throw new Error(
          `redirected to ${url.origin}${url.pathname} (${url.searchParams.get("error") ?? "no error param"}), expected the redirect_uri`,
        );
      }
      const err = url.searchParams.get("error");
      if (err) throw new Error(`authorize error redirect: ${err}`);
      if (url.searchParams.get("state") !== state) {
        throw new Error("state mismatch on the authorize redirect");
      }
      const authCode = url.searchParams.get("code");
      if (!authCode) throw new Error("authorize redirect carried no code");
      return authCode;
    });

    const tokens = await step("token exchange (Basic auth)", async () => {
      const res = await tokenRequest(
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        },
        { clientId, clientSecret },
      );
      await expectStatus(res, 200);
      const body = (await res.json()) as TokenResponse;
      if (!body.access_token) throw new Error("no access_token issued");
      if (!body.id_token) throw new Error("no id_token issued");
      if (!body.refresh_token) throw new Error("no refresh_token issued");
      if ((body.token_type ?? "").toLowerCase() !== "bearer") {
        throw new Error(`unexpected token_type: ${body.token_type}`);
      }
      return body;
    });

    await step("verify id_token against JWKS (iss/aud/sub/nonce)", async () => {
      const jwks = createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(tokens.id_token as string, jwks, {
        issuer,
        audience: clientId,
      });
      if (payload.sub !== userId) {
        throw new Error(`sub ${payload.sub} != signed-in user ${userId}`);
      }
      if (payload.nonce !== nonce) throw new Error("nonce was not echoed");
    });

    await step("userinfo (Bearer)", async () => {
      const res = await fetch(`${base}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      await expectStatus(res, 200);
      const claims = (await res.json()) as { sub?: string };
      if (claims.sub !== userId) {
        throw new Error(`userinfo sub ${claims.sub} != ${userId}`);
      }
    });

    const refreshed = await step("refresh grant (rotation)", async () => {
      const res = await tokenRequest(
        {
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token as string,
        },
        { clientId, clientSecret },
      );
      await expectStatus(res, 200);
      const body = (await res.json()) as TokenResponse;
      if (!body.access_token) throw new Error("refresh issued no access_token");
      if (body.access_token === tokens.access_token) {
        throw new Error("refresh returned the same access_token");
      }
      if (!body.refresh_token || body.refresh_token === tokens.refresh_token) {
        throw new Error("refresh_token was not rotated");
      }
      return body;
    });

    await step("revoke access token (introspect confirms)", async () => {
      const revokeRes = await fetch(`${base}/api/auth/oauth2/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({ token: refreshed.access_token }).toString(),
      });
      await expectStatus(revokeRes, 200);

      const introspectRes = await fetch(`${base}/api/auth/oauth2/introspect`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({
          token: refreshed.access_token,
        }).toString(),
      });
      await expectStatus(introspectRes, 200);
      const { active } = (await introspectRes.json()) as { active: boolean };
      if (active) throw new Error("token still active after revocation");
    });
  } finally {
    if (clientId) {
      // Cleanup runs even when a step failed; its own failure marks the run
      // failed too (but must not mask the original error, hence no throw).
      try {
        const res = await api(`/api/admin/oauth-clients/${clientId}`, {
          method: "DELETE",
        });
        await expectStatus(res, 204);
        console.log("PASS  delete temp client");
      } catch (error) {
        stepFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`FAIL  delete temp client: ${message}`);
      }
    }
  }
}

try {
  await main();
} catch {
  // The failing step already printed its FAIL line.
}
if (stepFailed) {
  console.error("oidc-smoke: FAILED");
  process.exit(1);
}
console.log("oidc-smoke: all steps passed");
