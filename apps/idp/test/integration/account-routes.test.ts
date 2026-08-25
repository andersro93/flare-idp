import { env } from "cloudflare:test";
import { createAuth } from "@flare-idp/api";
import { errorBodySchema, sessionUserSchema } from "@flare-idp/shared";
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

async function sessionTokensFor(email: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.token as token FROM session s JOIN user u ON u.id = s.user_id WHERE u.email = ?1`,
  )
    .bind(email)
    .all<{ token: string }>();
  return results.map((r) => r.token);
}

/**
 * Completes setup, then immediately signs the resulting (setup-flow) session
 * out. `completeSetup` creates its own session as a side effect of
 * `signUpEmail`, and admin-role provisioning happens via a raw DB update
 * (bypassing Better-Auth's own cache-invalidating update path) — that
 * leftover session would otherwise both (a) read back a stale cached
 * `role` and (b) silently pad out session-count assertions below. Tests
 * that need an authenticated jar sign in fresh afterward instead.
 */
async function setupAdmin(): Promise<void> {
  const jar = await completeSetup();
  await api("/api/session/sign-out", { method: "POST" }, jar);
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

describe("GET /api/account/profile", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/account/profile");
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns the current user's profile (200)", async () => {
    await setupAdmin();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api("/api/account/profile", {}, jar);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    const user = sessionUserSchema.parse(body.user);
    expect(user.email).toBe(SETUP_ADMIN.email);
    expect(user.name).toBe(SETUP_ADMIN.name);
    expect(user.role).toBe("admin");
  });
});

describe("PATCH /api/account/profile", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/account/profile", {
      method: "PATCH",
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects an empty patch (400 invalid_request)", async () => {
    await setupAdmin();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api(
      "/api/account/profile",
      { method: "PATCH", body: JSON.stringify({}) },
      jar,
    );
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");
  });

  it("updates the name (200), it is visible via GET /api/session, and it audits", async () => {
    await setupAdmin();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api(
      "/api/account/profile",
      { method: "PATCH", body: JSON.stringify({ name: "New Name" }) },
      jar,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    const user = sessionUserSchema.parse(body.user);
    expect(user.name).toBe("New Name");

    const sessionRes = await api("/api/session", {}, jar);
    const sessionBody = (await sessionRes.json()) as {
      user: { name: string } | null;
    };
    expect(sessionBody.user?.name).toBe("New Name");

    expect(await auditCountFor("account.profile_updated")).toBe(1);
  });
});

describe("GET /api/account/sessions", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/account/sessions");
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("lists both sessions, marks exactly one current, and never leaks raw tokens (200)", async () => {
    await setupAdmin();
    const { jar: jar1 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);
    await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api("/api/account/sessions", {}, jar1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        id: string;
        current: boolean;
        userAgent: string | null;
        ipAddress: string | null;
      }>;
    };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);

    const rawTokens = await sessionTokensFor(SETUP_ADMIN.email);
    expect(rawTokens.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(body);
    for (const token of rawTokens) {
      expect(serialized).not.toContain(token);
    }
    // Sanity check that these are real, non-trivial token values so the
    // "not.toContain" assertions above are meaningful.
    for (const token of rawTokens) {
      expect(token.length).toBeGreaterThan(10);
    }
  });
});

describe("DELETE /api/account/sessions/:id", () => {
  it("requires authentication (401)", async () => {
    const res = await api("/api/account/sessions/does-not-matter", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("revokes another session of the same user (204), killing it, and audits", async () => {
    await setupAdmin();
    const { jar: jar1 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);
    const { jar: jar2 } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const listRes = await api("/api/account/sessions", {}, jar1);
    const { sessions } = (await listRes.json()) as {
      sessions: Array<{ id: string; current: boolean }>;
    };
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current);
    if (!other) throw new Error("expected a non-current session in the list");

    const res = await api(
      `/api/account/sessions/${other.id}`,
      { method: "DELETE" },
      jar1,
    );
    expect(res.status).toBe(204);
    expect(await auditCountFor("account.session_revoked")).toBe(1);

    const jar2After = await api("/api/session", {}, jar2);
    expect(await jar2After.json()).toEqual({ user: null, session: null });
  });

  it("returns 404 for a nonexistent session id", async () => {
    await setupAdmin();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);

    const res = await api(
      "/api/account/sessions/does-not-exist",
      { method: "DELETE" },
      jar,
    );
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 for a session belonging to another user (no ownership oracle)", async () => {
    await setupAdmin();
    const { jar } = await signIn(SETUP_ADMIN.email, SETUP_ADMIN.password);
    const other = await createOtherUser();
    const { jar: otherJar } = await signIn(other.email, other.password);

    const otherSessionsRes = await api("/api/account/sessions", {}, otherJar);
    const { sessions: otherSessions } = (await otherSessionsRes.json()) as {
      sessions: Array<{ id: string }>;
    };
    const otherSessionId = otherSessions[0]?.id;
    if (!otherSessionId)
      throw new Error("expected the other user to have a session");

    const res = await api(
      `/api/account/sessions/${otherSessionId}`,
      { method: "DELETE" },
      jar,
    );
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");

    // The foreign session survives the failed attempt.
    const stillThere = await api("/api/account/sessions", {}, otherJar);
    const { sessions: stillSessions } = (await stillThere.json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(stillSessions.map((s) => s.id)).toContain(otherSessionId);
  });
});
