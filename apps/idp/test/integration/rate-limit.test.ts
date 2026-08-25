import { env } from "cloudflare:test";
import { consumeRateLimit, RATE_LIMITS } from "@flare-idp/api";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limit").run();
});

describe("consumeRateLimit (D1-backed)", () => {
  it("counts per window and resets after it", async () => {
    const rule = { name: "t-window", windowSeconds: 60, max: 2 };
    const t0 = 1_000_000;

    expect(await consumeRateLimit(env.DB, rule, "1.1.1.1", t0)).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(await consumeRateLimit(env.DB, rule, "1.1.1.1", t0 + 1000)).toEqual({
      allowed: true,
      remaining: 0,
    });

    const blocked = await consumeRateLimit(env.DB, rule, "1.1.1.1", t0 + 2000);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
    }

    // The window rolls over after windowSeconds have elapsed.
    expect(
      (await consumeRateLimit(env.DB, rule, "1.1.1.1", t0 + 61_000)).allowed,
    ).toBe(true);
  });

  it("tracks composite keys (rule name + client) independently", async () => {
    const ruleA = { name: "t-a", windowSeconds: 60, max: 1 };
    const ruleB = { name: "t-b", windowSeconds: 60, max: 1 };
    const t0 = 2_000_000;

    expect((await consumeRateLimit(env.DB, ruleA, "9.9.9.9", t0)).allowed).toBe(
      true,
    );
    // Same client, different rule name -> independent counter.
    expect((await consumeRateLimit(env.DB, ruleB, "9.9.9.9", t0)).allowed).toBe(
      true,
    );
    // Same rule, different client -> independent counter.
    expect((await consumeRateLimit(env.DB, ruleA, "8.8.8.8", t0)).allowed).toBe(
      true,
    );
    // Same rule + same client, second request -> denied (max: 1).
    const blocked = await consumeRateLimit(env.DB, ruleA, "9.9.9.9", t0 + 100);
    expect(blocked.allowed).toBe(false);
  });

  it("denies the 6th call within the window with a correct retryAfterSeconds", async () => {
    const rule = { name: "t-sixth", windowSeconds: 30, max: 5 };
    const t0 = 3_000_000;

    for (let i = 0; i < 5; i += 1) {
      const decision = await consumeRateLimit(
        env.DB,
        rule,
        "5.5.5.5",
        t0 + i * 1000,
      );
      expect(decision.allowed).toBe(true);
    }

    const sixth = await consumeRateLimit(env.DB, rule, "5.5.5.5", t0 + 5000);
    expect(sixth.allowed).toBe(false);
    if (!sixth.allowed) {
      // last_request stays at t0 (the first request in the window); the
      // window closes at t0 + 30_000, so ~25s remain from t0 + 5000.
      expect(sixth.retryAfterSeconds).toBe(25);
    }
  });
});

describe("RATE_LIMITS", () => {
  it("exports the exact rule set the facade relies on", () => {
    expect(RATE_LIMITS).toEqual({
      setup: { name: "setup", windowSeconds: 900, max: 5 },
      signIn: { name: "sign-in", windowSeconds: 60, max: 5 },
      passwordForgot: { name: "pw-forgot", windowSeconds: 300, max: 3 },
      passwordReset: { name: "pw-reset", windowSeconds: 300, max: 5 },
      emailVerify: { name: "email-verify", windowSeconds: 300, max: 10 },
    });
  });
});
