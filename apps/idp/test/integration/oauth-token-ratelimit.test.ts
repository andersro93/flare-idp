import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./helpers/db";
import { TEST_ORIGIN } from "./helpers/http";

beforeEach(resetDatabase);

async function postGarbageToken(): Promise<Response> {
  return SELF.fetch(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=authorization_code&code=not-a-real-code",
  });
}

describe("POST /api/auth/oauth2/token rate limit", () => {
  it("rate limits after 30 requests from the same IP within the window (RFC-shaped 429)", async () => {
    for (let i = 0; i < 30; i += 1) {
      const res = await postGarbageToken();
      expect(res.status).not.toBe(429);
    }

    const over = await postGarbageToken();
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).toBeTruthy();
    const body = (await over.json()) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("temporarily_unavailable");
    expect(typeof body.error_description).toBe("string");
  });
});
