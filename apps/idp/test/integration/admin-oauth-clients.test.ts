import { env } from "cloudflare:test";
import { createAuth } from "@flare-idp/api";
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

const BASE = "/api/admin/oauth-clients";

type CreateResponseBody = {
  client: {
    clientId: string;
    name?: string;
    redirectUris: string[];
    applicationType?: string | null;
  };
  clientSecret?: string;
};

async function auditCountFor(event: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM audit_events WHERE event = ?1",
  )
    .bind(event)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Completes setup (creating the admin), signs its bootstrap session out, then signs back in fresh — see account-routes.test.ts for why the fresh sign-in matters. */
async function setupAdmin(): Promise<CookieJar> {
  const jar = await completeSetup();
  await api("/api/session/sign-out", { method: "POST" }, jar);
  const { jar: adminJar } = await signIn(
    SETUP_ADMIN.email,
    SETUP_ADMIN.password,
  );
  return adminJar;
}

/** Provisions a second, non-admin user via a one-shot sign-up-enabled auth instance. */
async function createOtherUser(): Promise<{ email: string; password: string }> {
  const email = "other-user@example.com";
  const password = "another-correct-horse";
  const provisioning = createAuth(env, {}, { allowSignUp: true });
  await provisioning.api.signUpEmail({
    body: { email, password, name: "Other User" },
    headers: new Headers({ origin: TEST_ORIGIN }),
  });
  return { email, password };
}

function validCreateBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Client",
    redirectUris: ["https://client.example.com/callback"],
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    scope: ["openid", "profile"],
    skipConsent: true,
    ...overrides,
  };
}

async function createClient(
  jar: CookieJar,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return api(
    BASE,
    { method: "POST", body: JSON.stringify(validCreateBody(overrides)) },
    jar,
  );
}

describe("GET /api/admin/oauth-clients", () => {
  it("requires authentication (401)", async () => {
    const res = await api(BASE);
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("requires admin (403) for a non-admin session", async () => {
    await setupAdmin();
    const other = await createOtherUser();
    const { jar } = await signIn(other.email, other.password);

    const res = await api(BASE, {}, jar);
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("lists created clients (200)", async () => {
    const adminJar = await setupAdmin();
    await createClient(adminJar);

    const res = await api(BASE, {}, adminJar);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: Array<{ clientId: string; name?: string }>;
    };
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]?.name).toBe("Test Client");
  });
});

describe("POST /api/admin/oauth-clients", () => {
  it("requires authentication (401)", async () => {
    const res = await api(BASE, {
      method: "POST",
      body: JSON.stringify(validCreateBody()),
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("requires admin (403) for a non-admin session", async () => {
    await setupAdmin();
    const other = await createOtherUser();
    const { jar } = await signIn(other.email, other.password);

    const res = await createClient(jar);
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("creates a confidential client (201), returns the secret once, and it never reappears in the list", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar);
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateResponseBody;
    expect(body.client.clientId).toBeTruthy();
    expect(body.clientSecret).toBeTruthy();

    const listRes = await api(BASE, {}, adminJar);
    const listBody = await listRes.json();
    const secret = body.clientSecret;
    if (!secret)
      throw new Error("expected a clientSecret in the create response");
    expect(JSON.stringify(listBody)).not.toContain(secret);

    expect(await auditCountFor("oauth_client.created")).toBe(1);
  });

  it("creates a public client (token_endpoint_auth_method: none) with no clientSecret field", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, {
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateResponseBody;
    expect(Object.hasOwn(body, "clientSecret")).toBe(false);
  });

  it("rejects empty redirect_uris (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, { redirectUris: [] });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects a non-loopback http redirect_uri (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, {
      redirectUris: ["http://example.com/callback"],
    });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("auto-forces applicationType to native for a loopback redirect_uri", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, {
      redirectUris: ["http://127.0.0.1:4444/callback"],
      grantTypes: ["authorization_code"],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateResponseBody;
    expect(body.client.applicationType).toBe("native");
  });

  it("rejects an unknown scope (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, { scope: ["not-a-real-scope"] });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects client_credentials grant combined with auth method none (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, {
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "client_credentials"],
    });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects an out-of-enum grant type (400 invalid_request)", async () => {
    const adminJar = await setupAdmin();

    const res = await createClient(adminJar, { grantTypes: ["implicit"] });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("GET /api/admin/oauth-clients/:clientId", () => {
  it("requires authentication (401)", async () => {
    const res = await api(`${BASE}/does-not-matter`);
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("requires admin (403) for a non-admin session", async () => {
    await setupAdmin();
    const other = await createOtherUser();
    const { jar } = await signIn(other.email, other.password);

    const res = await api(`${BASE}/does-not-matter`, {}, jar);
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 404 for an unknown client id", async () => {
    const adminJar = await setupAdmin();

    const res = await api(`${BASE}/does-not-exist`, {}, adminJar);
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });

  it("returns the client's DTO (200)", async () => {
    const adminJar = await setupAdmin();
    const createRes = await createClient(adminJar);
    const { client } = (await createRes.json()) as CreateResponseBody;

    const res = await api(`${BASE}/${client.clientId}`, {}, adminJar);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientId: string; name?: string };
    expect(body.clientId).toBe(client.clientId);
    expect(body.name).toBe("Test Client");
    expect(JSON.stringify(body)).not.toContain("clientSecret");
  });
});

describe("PATCH /api/admin/oauth-clients/:clientId", () => {
  it("requires authentication (401)", async () => {
    const res = await api(`${BASE}/does-not-matter`, {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("requires admin (403) for a non-admin session", async () => {
    await setupAdmin();
    const other = await createOtherUser();
    const { jar } = await signIn(other.email, other.password);

    const res = await api(
      `${BASE}/does-not-matter`,
      { method: "PATCH", body: JSON.stringify({ name: "New Name" }) },
      jar,
    );
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 404 for an unknown client id", async () => {
    const adminJar = await setupAdmin();

    const res = await api(
      `${BASE}/does-not-exist`,
      { method: "PATCH", body: JSON.stringify({ name: "New Name" }) },
      adminJar,
    );
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });

  it("updates redirectUris (200) and audits", async () => {
    const adminJar = await setupAdmin();
    const createRes = await createClient(adminJar);
    const { client } = (await createRes.json()) as CreateResponseBody;

    const res = await api(
      `${BASE}/${client.clientId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          redirectUris: ["https://client.example.com/other-callback"],
        }),
      },
      adminJar,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectUris: string[] };
    expect(body.redirectUris).toEqual([
      "https://client.example.com/other-callback",
    ]);

    expect(await auditCountFor("oauth_client.updated")).toBe(1);
  });

  // Regression: the update body must only carry the fields the caller
  // actually provided. Sending the other (unpatched) fields as explicit
  // `undefined` lets Better-Auth's `{ ...stored, ...updates }` merge wipe
  // them, which its own re-validation then re-defaults (e.g. `grant_types`
  // back to `["authorization_code"]`) — a rename-only or scope-only patch
  // must not touch `redirectUris` at all.
  it("renames a client without touching its redirectUris (200)", async () => {
    const adminJar = await setupAdmin();
    const createRes = await createClient(adminJar);
    const { client } = (await createRes.json()) as CreateResponseBody;

    const res = await api(
      `${BASE}/${client.clientId}`,
      { method: "PATCH", body: JSON.stringify({ name: "Renamed Client" }) },
      adminJar,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name?: string;
      redirectUris: string[];
    };
    expect(body.name).toBe("Renamed Client");
    expect(body.redirectUris).toEqual(client.redirectUris);

    const getRes = await api(`${BASE}/${client.clientId}`, {}, adminJar);
    const getBody = (await getRes.json()) as {
      name?: string;
      redirectUris: string[];
    };
    expect(getBody.name).toBe("Renamed Client");
    expect(getBody.redirectUris).toEqual(client.redirectUris);
  });

  it("toggles skipConsent alone without touching other fields (200)", async () => {
    const adminJar = await setupAdmin();
    const createRes = await createClient(adminJar, { skipConsent: false });
    const { client } = (await createRes.json()) as CreateResponseBody;

    const res = await api(
      `${BASE}/${client.clientId}`,
      { method: "PATCH", body: JSON.stringify({ skipConsent: true }) },
      adminJar,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skipConsent?: boolean;
      redirectUris: string[];
      name?: string;
    };
    expect(body.skipConsent).toBe(true);
    expect(body.redirectUris).toEqual(client.redirectUris);
    expect(body.name).toBe(client.name);

    const getRes = await api(`${BASE}/${client.clientId}`, {}, adminJar);
    const getBody = (await getRes.json()) as {
      skipConsent?: boolean;
      redirectUris: string[];
      name?: string;
    };
    expect(getBody.skipConsent).toBe(true);
    expect(getBody.redirectUris).toEqual(client.redirectUris);
    expect(getBody.name).toBe(client.name);
  });

  // Regression: a patch that touches ONLY `applicationType` (no
  // `redirectUris` in the body at all) must still apply — the update-body
  // builder above must not gate `application_type` on `redirectUris` also
  // being present in the same patch.
  it("applies a standalone applicationType patch with no redirectUris in the body (200)", async () => {
    const adminJar = await setupAdmin();
    // The default https, non-loopback redirect URI is valid for both "web"
    // and "native" application types, so this patch is otherwise a no-op
    // apart from the field under test.
    const createRes = await createClient(adminJar);
    const { client } = (await createRes.json()) as CreateResponseBody;
    expect(client.applicationType).not.toBe("native");

    const res = await api(
      `${BASE}/${client.clientId}`,
      { method: "PATCH", body: JSON.stringify({ applicationType: "native" }) },
      adminJar,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applicationType?: string;
      redirectUris: string[];
    };
    expect(body.applicationType).toBe("native");
    expect(body.redirectUris).toEqual(client.redirectUris);

    const getRes = await api(`${BASE}/${client.clientId}`, {}, adminJar);
    const getBody = (await getRes.json()) as { applicationType?: string };
    expect(getBody.applicationType).toBe("native");
  });
});

describe("POST /api/admin/oauth-clients/:clientId/rotate-secret", () => {
  it("requires authentication (401)", async () => {
    const res = await api(`${BASE}/does-not-matter/rotate-secret`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("requires admin (403) for a non-admin session", async () => {
    await setupAdmin();
    const other = await createOtherUser();
    const { jar } = await signIn(other.email, other.password);

    const res = await api(
      `${BASE}/does-not-matter/rotate-secret`,
      { method: "POST" },
      jar,
    );
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 404 for an unknown client id", async () => {
    const adminJar = await setupAdmin();

    const res = await api(
      `${BASE}/does-not-exist/rotate-secret`,
      { method: "POST" },
      adminJar,
    );
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });

  it("returns a fresh secret that differs from the create-time one, and audits", async () => {
    const adminJar = await setupAdmin();
    const createRes = await createClient(adminJar);
    const { client, clientSecret: originalSecret } =
      (await createRes.json()) as CreateResponseBody;
    if (!originalSecret)
      throw new Error("expected a clientSecret at create time");

    const res = await api(
      `${BASE}/${client.clientId}/rotate-secret`,
      { method: "POST" },
      adminJar,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientSecret: string };
    expect(body.clientSecret).toBeTruthy();
    expect(body.clientSecret).not.toBe(originalSecret);

    expect(await auditCountFor("oauth_client.secret_rotated")).toBe(1);
  });
});

describe("DELETE /api/admin/oauth-clients/:clientId", () => {
  it("requires authentication (401)", async () => {
    const res = await api(`${BASE}/does-not-matter`, { method: "DELETE" });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("requires admin (403) for a non-admin session", async () => {
    await setupAdmin();
    const other = await createOtherUser();
    const { jar } = await signIn(other.email, other.password);

    const res = await api(`${BASE}/does-not-matter`, { method: "DELETE" }, jar);
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 404 for an unknown client id", async () => {
    const adminJar = await setupAdmin();

    const res = await api(
      `${BASE}/does-not-exist`,
      { method: "DELETE" },
      adminJar,
    );
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });

  it("deletes the client (204), it disappears from the list, and audits", async () => {
    const adminJar = await setupAdmin();
    const createRes = await createClient(adminJar);
    const { client } = (await createRes.json()) as CreateResponseBody;

    const res = await api(
      `${BASE}/${client.clientId}`,
      { method: "DELETE" },
      adminJar,
    );
    expect(res.status).toBe(204);

    const listRes = await api(BASE, {}, adminJar);
    const listBody = (await listRes.json()) as {
      clients: Array<{ clientId: string }>;
    };
    expect(listBody.clients).toHaveLength(0);

    expect(await auditCountFor("oauth_client.deleted")).toBe(1);
  });
});
