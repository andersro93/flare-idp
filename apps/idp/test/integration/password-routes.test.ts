import { env } from "cloudflare:test";
import { createAuth } from "@flare-idp/api";
import { captureEmailSender } from "@flare-idp/email";
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

async function verificationRowCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM verification",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Better-Auth's `requestPasswordReset` mails a URL shaped
 * `${baseURL}/reset-password/${token}?callbackURL=...` — the token is a
 * PATH SEGMENT, not a query param (confirmed against
 * node_modules/better-auth/dist/api/routes/password.mjs).
 */
function extractResetToken(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  const token = segments.at(-1);
  if (!token) throw new Error(`could not extract reset token from ${url}`);
  return token;
}

describe("POST /api/auth/password/forgot", () => {
  it("always returns 200 for an existing email and enqueues a reset (a verification row appears)", async () => {
    await completeSetup();
    const before = await verificationRowCount();

    const res = await api("/api/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email: SETUP_ADMIN.email }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await verificationRowCount()).toBe(before + 1);
  });

  it("always returns 200 for a nonexistent email and does not enumerate (no verification row added)", async () => {
    await completeSetup();
    const before = await verificationRowCount();

    const res = await api("/api/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email: "nobody@example.com" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await verificationRowCount()).toBe(before);
  });

  it("rate limits after 3 requests in the window (4th -> 429)", async () => {
    await completeSetup();

    for (let i = 0; i < 3; i += 1) {
      const res = await api("/api/auth/password/forgot", {
        method: "POST",
        body: JSON.stringify({ email: SETUP_ADMIN.email }),
      });
      expect(res.status).toBe(200);
    }

    const fourth = await api("/api/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email: SETUP_ADMIN.email }),
    });
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("Retry-After")).toBeTruthy();
    const body = errorBodySchema.parse(await fourth.json());
    expect(body.error.code).toBe("rate_limited");
  });
});

describe("POST /api/auth/password/reset", () => {
  it("resets the password with a token obtained via the capture sender, revokes other sessions, and audits", async () => {
    await completeSetup();

    const capture = captureEmailSender();
    const testAuth = createAuth(env, { emailSender: capture });

    // Establish a second session BEFORE the reset — it must be dead after.
    const { jar: otherJar } = await signIn(
      SETUP_ADMIN.email,
      SETUP_ADMIN.password,
    );
    const otherBefore = await api("/api/session", {}, otherJar);
    expect(
      ((await otherBefore.json()) as { user: unknown }).user,
    ).not.toBeNull();

    await testAuth.api.requestPasswordReset({
      body: { email: SETUP_ADMIN.email, redirectTo: "/reset-password" },
      headers: new Headers({ origin: TEST_ORIGIN }),
    });

    expect(capture.jobs).toHaveLength(1);
    const job = capture.jobs[0];
    if (job?.kind !== "reset-password") {
      throw new Error(
        `expected a reset-password job, got ${JSON.stringify(job)}`,
      );
    }
    const token = extractResetToken(job.url);

    const newPassword = "brand-new-correct-horse";
    const res = await api("/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({ token, password: newPassword }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await auditCountFor("password.reset")).toBe(1);

    // Old password no longer works.
    const oldSignIn = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({
        email: SETUP_ADMIN.email,
        password: SETUP_ADMIN.password,
      }),
    });
    expect(oldSignIn.status).toBe(401);

    // New password works.
    const { res: newSignIn } = await signIn(SETUP_ADMIN.email, newPassword);
    expect(newSignIn.status).toBe(200);

    // The other, pre-reset session was revoked.
    const otherAfter = await api("/api/session", {}, otherJar);
    expect(await otherAfter.json()).toEqual({ user: null, session: null });
  });

  it("rejects a garbage token (400 invalid_token)", async () => {
    await completeSetup();

    const res = await api("/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({
        token: "not-a-real-token",
        password: "brand-new-correct-horse",
      }),
    });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_token");
  });

  it("rate limits after 5 requests in the window (6th -> 429)", async () => {
    await completeSetup();

    for (let i = 0; i < 5; i += 1) {
      const res = await api("/api/auth/password/reset", {
        method: "POST",
        body: JSON.stringify({
          token: "not-a-real-token",
          password: "brand-new-correct-horse",
        }),
      });
      expect(res.status).toBe(400);
    }

    const sixth = await api("/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({
        token: "not-a-real-token",
        password: "brand-new-correct-horse",
      }),
    });
    expect(sixth.status).toBe(429);
  });
});

describe("POST /api/auth/password/change", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/auth/password/change", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: SETUP_ADMIN.password,
        newPassword: "brand-new-correct-horse",
      }),
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("changes the password (200), the old password stops working, and audits", async () => {
    await completeSetup();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const newPassword = "brand-new-correct-horse";
    const res = await api(
      "/api/auth/password/change",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword: SETUP_ADMIN.password,
          newPassword,
        }),
      },
      jar,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await auditCountFor("password.changed")).toBe(1);

    const oldSignIn = await api("/api/session/sign-in/password", {
      method: "POST",
      body: JSON.stringify({
        email: SETUP_ADMIN.email,
        password: SETUP_ADMIN.password,
      }),
    });
    expect(oldSignIn.status).toBe(401);

    const { res: newSignIn } = await signIn(SETUP_ADMIN.email, newPassword);
    expect(newSignIn.status).toBe(200);
  });

  it("rejects the wrong current password (400 invalid_credentials)", async () => {
    await completeSetup();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api(
      "/api/auth/password/change",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword: "totally-wrong-password",
          newPassword: "brand-new-correct-horse",
        }),
      },
      jar,
    );
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_credentials");
  });

  it("rate limits after 5 attempts in the window, per user (6th -> 429)", async () => {
    await completeSetup();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    for (let i = 0; i < 5; i += 1) {
      const res = await api(
        "/api/auth/password/change",
        {
          method: "POST",
          body: JSON.stringify({
            currentPassword: "totally-wrong-password",
            newPassword: "brand-new-correct-horse",
          }),
        },
        jar,
      );
      expect(res.status).toBe(400);
    }

    const sixth = await api(
      "/api/auth/password/change",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword: "totally-wrong-password",
          newPassword: "brand-new-correct-horse",
        }),
      },
      jar,
    );
    expect(sixth.status).toBe(429);
    const body = errorBodySchema.parse(await sixth.json());
    expect(body.error.code).toBe("rate_limited");
  });

  it("revokes other sessions by default", async () => {
    await completeSetup();
    const { jar: jar1 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);
    const { jar: jar2 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api(
      "/api/auth/password/change",
      {
        method: "POST",
        body: JSON.stringify({
          currentPassword: SETUP_ADMIN.password,
          newPassword: "brand-new-correct-horse",
        }),
      },
      jar1,
    );
    expect(res.status).toBe(200);

    const jar2After = await api("/api/session", {}, jar2);
    expect(await jar2After.json()).toEqual({ user: null, session: null });
  });
});
