import { env } from "cloudflare:test";
import { app } from "@flare-idp/api";
import { errorBodySchema } from "@flare-idp/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { CookieJar } from "./helpers/cookies";
import { resetDatabase } from "./helpers/db";
import { api, completeSetup, SETUP_ADMIN } from "./helpers/http";

beforeEach(resetDatabase);

function completeBody(
  overrides: Partial<typeof SETUP_ADMIN & { secret: string }> = {},
) {
  return JSON.stringify({
    secret: "test-setup-secret",
    ...SETUP_ADMIN,
    ...overrides,
  });
}

describe("GET /api/setup/status", () => {
  it("reports pending before setup runs", async () => {
    const res = await api("/api/setup/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("reports complete after setup runs", async () => {
    await completeSetup();
    const res = await api("/api/setup/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "complete" });
  });
});

describe("POST /api/setup/complete", () => {
  it("creates the admin account, forwards the session cookie, and completes install (201)", async () => {
    const jar = new CookieJar();
    const res = await api(
      "/api/setup/complete",
      { method: "POST", body: completeBody() },
      jar,
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      user: { email: string; role: string };
    };
    expect(body.user.email).toBe(SETUP_ADMIN.email);
    expect(body.user.role).toBe("admin");
    expect(jar.names()).toContain("better-auth.session_token");

    const row = await env.DB.prepare("SELECT role FROM user WHERE email = ?1")
      .bind(SETUP_ADMIN.email)
      .first<{ role: string }>();
    expect(row?.role).toBe("admin");

    const status = await api("/api/setup/status");
    expect(await status.json()).toEqual({ status: "complete" });
  });

  it("rejects the wrong secret (403) without an audit row, and leaves status pending", async () => {
    const res = await api("/api/setup/complete", {
      method: "POST",
      body: completeBody({ secret: "wrong-secret" }),
    });
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_setup_secret");

    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM audit_events",
    ).first<{ n: number }>();
    expect(auditCount?.n).toBe(0);

    const statusRow = await env.DB.prepare(
      "SELECT status FROM app_installation WHERE id = 1",
    ).first<{ status: string }>();
    expect(statusRow?.status).toBe("pending");
  });

  it("returns 503 misconfigured when SETUP_SECRET is not bound", async () => {
    // `app` (the exported OpenAPIHono instance) accepts a per-call env
    // override as `.request()`'s 3rd argument, which is exactly what's
    // needed here: SELF.fetch always uses the worker's real (fully bound)
    // test environment, but this case needs SETUP_SECRET specifically
    // absent while every other binding (D1, KV, etc.) stays real so the
    // request still reaches the route instead of tripping the env
    // validation middleware.
    const res = await app.request(
      "/api/setup/complete",
      {
        method: "POST",
        headers: {
          origin: "http://localhost:8787",
          "content-type": "application/json",
        },
        body: completeBody(),
      },
      { ...env, SETUP_SECRET: undefined },
    );
    expect(res.status).toBe(503);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("misconfigured");
  });

  it("returns 409 setup_already_complete on a second run", async () => {
    await completeSetup();

    const res = await api("/api/setup/complete", {
      method: "POST",
      body: completeBody({ email: "second-admin@example.com" }),
    });
    expect(res.status).toBe(409);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("setup_already_complete");
  });

  it("sign-up stays disabled everywhere else, even after setup completes", async () => {
    await completeSetup();

    const res = await api("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: "not-allowed@example.com",
        password: "correct-horse-battery-staple",
        name: "Nope",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rate limits after 5 wrong-secret attempts in the window (429 + Retry-After)", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await api("/api/setup/complete", {
        method: "POST",
        body: completeBody({ secret: "wrong-secret" }),
      });
      expect(res.status).toBe(403);
    }

    const sixth = await api("/api/setup/complete", {
      method: "POST",
      body: completeBody({ secret: "wrong-secret" }),
    });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
    const body = errorBodySchema.parse(await sixth.json());
    expect(body.error.code).toBe("rate_limited");
  });

  it("rolls the claim back to pending when admin provisioning fails after the claim", async () => {
    // Validation happens before the claim, so the only realistic
    // post-claim failure is a duplicate email — pre-insert a user row with
    // the admin's email so `signUpEmail` throws.
    await env.DB.prepare(
      "INSERT INTO user (id, name, email) VALUES (?1, ?2, ?3)",
    )
      .bind("existing-user", "Existing", SETUP_ADMIN.email)
      .run();

    const res = await api("/api/setup/complete", {
      method: "POST",
      body: completeBody(),
    });
    // `signUpEmail`'s duplicate-email APIError maps through `mapAuthError`
    // to 400 `invalid_request` (BAD_REQUEST -> invalid_request).
    expect(res.status).toBe(400);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("invalid_request");

    const statusRow = await env.DB.prepare(
      "SELECT status FROM app_installation WHERE id = 1",
    ).first<{ status: string }>();
    expect(statusRow?.status).toBe("pending");

    const retry = await api("/api/setup/complete", {
      method: "POST",
      body: completeBody({ email: "different-admin@example.com" }),
    });
    expect(retry.status).toBe(201);
  });
});
