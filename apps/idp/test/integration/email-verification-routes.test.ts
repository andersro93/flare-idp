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

async function emailVerifiedFor(email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT email_verified FROM "user" WHERE email = ?1',
  )
    .bind(email)
    .first<{ email_verified: number | boolean }>();
  if (!row) throw new Error(`no user row for ${email}`);
  return Boolean(row.email_verified);
}

/**
 * Better-Auth's `sendVerificationEmail` mails a URL shaped
 * `${baseURL}/verify-email?token=...&callbackURL=...` — the token IS a
 * query param here (unlike password reset, confirmed against
 * node_modules/better-auth/dist/api/routes/email-verification.mjs).
 */
function extractVerifyToken(url: string): string {
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error(`could not extract verify token from ${url}`);
  return token;
}

async function auditCountFor(event: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM audit_events WHERE event = ?1",
  )
    .bind(event)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /api/auth/email/verify", () => {
  it("starts unverified after setup, then flips to verified via the facade route (200) and audits", async () => {
    await completeSetup();
    // signUpEmail (the setup route's own call to createAuth) leaves
    // emailVerified false by default — confirmed against
    // node_modules/better-auth/dist/api/routes/sign-up.mjs.
    expect(await emailVerifiedFor(SETUP_ADMIN.email)).toBe(false);

    const capture = captureEmailSender();
    const testAuth = createAuth(env, { emailSender: capture });

    await testAuth.api.sendVerificationEmail({
      body: { email: SETUP_ADMIN.email, callbackURL: "/verify-email" },
      headers: new Headers({ origin: TEST_ORIGIN }),
    });

    expect(capture.jobs).toHaveLength(1);
    const job = capture.jobs[0];
    if (job?.kind !== "verify-email") {
      throw new Error(
        `expected a verify-email job, got ${JSON.stringify(job)}`,
      );
    }
    const token = extractVerifyToken(job.url);

    const res = await api("/api/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await emailVerifiedFor(SETUP_ADMIN.email)).toBe(true);
    expect(await auditCountFor("email.verified")).toBe(1);
  });

  it("rejects a garbage token (400 invalid_token)", async () => {
    await completeSetup();

    const res = await api("/api/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_token");
  });

  it("rate limits after 10 requests in the window (11th -> 429)", async () => {
    await completeSetup();

    for (let i = 0; i < 10; i += 1) {
      const res = await api("/api/auth/email/verify", {
        method: "POST",
        body: JSON.stringify({ token: "not-a-real-token" }),
      });
      expect(res.status).toBe(400);
    }

    const eleventh = await api("/api/auth/email/verify", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(eleventh.status).toBe(429);
    const body = errorBodySchema.parse(await eleventh.json());
    expect(body.error.code).toBe("rate_limited");
  });
});

describe("POST /api/auth/email/resend", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/auth/email/resend", { method: "POST" });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("resends the verification email when authenticated (200)", async () => {
    await completeSetup();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    // This goes through the singleton `auth` (real EMAIL_QUEUE), so the job
    // can't be captured here the way the token-retrieval tests do — only
    // the facade's response shape is asserted.
    const res = await api("/api/auth/email/resend", { method: "POST" }, jar);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
