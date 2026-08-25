import { SELF } from "cloudflare:test";
import { errorBodySchema } from "@flare-idp/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers/db";
import { TEST_ORIGIN } from "./helpers/http";

beforeEach(resetDatabase);

describe("CSRF guard exemptions for client-authenticated OAuth endpoints", () => {
  it("POST /api/auth/oauth2/token with a foreign Origin reaches Better-Auth (RFC protocol error, not our 403 envelope)", async () => {
    const res = await SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=authorization_code&code=not-a-real-code",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as { error?: unknown };
    expect(typeof body.error).toBe("string");
  });

  it("POST /api/session/sign-out with a foreign Origin still 403s (our envelope, not exempt)", async () => {
    const res = await SELF.fetch(`${TEST_ORIGIN}/api/session/sign-out`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("forbidden");
  });
});
