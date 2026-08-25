import { env, SELF } from "cloudflare:test";
import { errorBodySchema } from "@flare-idp/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers/db";
import {
  api,
  completeSetup,
  SETUP_ADMIN,
  signIn,
  TEST_ORIGIN,
} from "./helpers/http";

beforeEach(resetDatabase);

async function auditCountFor(event: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM audit_events WHERE event = ?1",
  )
    .bind(event)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("GET /api/session", () => {
  it("returns nulls when unauthenticated", async () => {
    const res = await api("/api/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, session: null });
  });

  it("returns the user and session once signed in", async () => {
    await completeSetup();
    const { jar, res: signInRes } = await signIn(
      SETUP_ADMIN.email,
      SETUP_ADMIN.password,
    );
    expect(signInRes.status).toBe(200);

    const res = await api("/api/session", {}, jar);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { email: string; role: string };
      session: { id: string; expiresAt: string };
    };
    expect(body.user.email).toBe(SETUP_ADMIN.email);
    expect(body.user.role).toBe("admin");
    expect(typeof body.session.id).toBe("string");
    expect(body.session.id.length).toBeGreaterThan(0);
    expect(new Date(body.session.expiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });
});

describe("POST /api/session/sign-in/password", () => {
  it("rejects a wrong password (401 invalid_credentials) and audits the failure, not a success", async () => {
    await completeSetup();

    const res = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({
        email: SETUP_ADMIN.email,
        password: "totally-wrong-password",
      }),
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_credentials");

    expect(await auditCountFor("session.sign_in_failed")).toBe(1);
    expect(await auditCountFor("session.sign_in")).toBe(0);
  });

  it("signs in with the right password (200), forwards the cookie, and audits success", async () => {
    await completeSetup();

    const { jar, res } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe(SETUP_ADMIN.email);
    expect(jar.names()).toContain("better-auth.session_token");

    const sessionRes = await api("/api/session", {}, jar);
    const sessionBody = (await sessionRes.json()) as {
      user: { email: string } | null;
      session: { id: string; expiresAt: string } | null;
    };
    expect(sessionBody.user?.email).toBe(SETUP_ADMIN.email);
    expect(sessionBody.session?.id).toBeTruthy();
    expect(sessionBody.session?.expiresAt).toBeTruthy();

    expect(await auditCountFor("session.sign_in")).toBe(1);
  });

  it("rejects a cross-site sign-in attempt (403 forbidden)", async () => {
    // `helpers/http.ts`'s `api()` always stamps the same-origin `origin`
    // header, so exercising the CSRF guard needs a raw `SELF.fetch` with a
    // genuinely foreign `Origin`.
    const res = await SELF.fetch(
      `${TEST_ORIGIN}/api/session/sign-in/password`,
      {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: SETUP_ADMIN.email,
          password: SETUP_ADMIN.password,
        }),
      },
    );
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });

  it("rate limits after 5 wrong-password attempts for the same email (429 + Retry-After)", async () => {
    await completeSetup();

    for (let i = 0; i < 5; i += 1) {
      const res = await api("/api/session/sign-in/password", {
        method: "POST",
        body: JSON.stringify({
          email: SETUP_ADMIN.email,
          password: "totally-wrong-password",
        }),
      });
      expect(res.status).toBe(401);
    }

    const sixth = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({
        email: SETUP_ADMIN.email,
        password: "totally-wrong-password",
      }),
    });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
    const body = errorBodySchema.parse(await sixth.json());
    expect(body.error.code).toBe("rate_limited");
  });

  it("keys the rate limit per email, not just per IP", async () => {
    await completeSetup();

    // Exhaust the limit for the admin's email.
    for (let i = 0; i < 5; i += 1) {
      const res = await api("/api/session/sign-in/password", {
        method: "POST",
        body: JSON.stringify({
          email: SETUP_ADMIN.email,
          password: "totally-wrong-password",
        }),
      });
      expect(res.status).toBe(401);
    }
    const exhausted = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({
        email: SETUP_ADMIN.email,
        password: "totally-wrong-password",
      }),
    });
    expect(exhausted.status).toBe(429);

    // A different email, same IP, is not rate-limited (still gets 401 —
    // proving its own counter, not a 429 carried over from the admin's).
    const different = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({
        email: "nobody@example.com",
        password: "totally-wrong-password",
      }),
    });
    expect(different.status).toBe(401);
  });
});

describe("POST /api/session/sign-out", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/session/sign-out", { method: "POST" });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("signs out (204) and clears the session", async () => {
    await completeSetup();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api("/api/session/sign-out", { method: "POST" }, jar);
    expect(res.status).toBe(204);

    const after = await api("/api/session", {}, jar);
    expect(await after.json()).toEqual({ user: null, session: null });
    expect(await auditCountFor("session.sign_out")).toBe(1);
  });
});

describe("POST /api/session/sign-out-all", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/session/sign-out-all", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("revokes every session for the user, including other jars (204)", async () => {
    await completeSetup();
    const { jar: jar1 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);
    const { jar: jar2 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const jar2Before = await api("/api/session", {}, jar2);
    expect(
      ((await jar2Before.json()) as { user: unknown }).user,
    ).not.toBeNull();

    const res = await api(
      "/api/session/sign-out-all",
      { method: "POST" },
      jar1,
    );
    expect(res.status).toBe(204);

    const jar1After = await api("/api/session", {}, jar1);
    expect(await jar1After.json()).toEqual({ user: null, session: null });

    const jar2After = await api("/api/session", {}, jar2);
    expect(await jar2After.json()).toEqual({ user: null, session: null });

    expect(await auditCountFor("session.sign_out_all")).toBe(1);
  });
});
