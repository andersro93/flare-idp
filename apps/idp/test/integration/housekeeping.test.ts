import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker";
import { resetDatabase } from "./helpers/db";

const DAY_MS = 24 * 60 * 60 * 1000;

async function runScheduled(): Promise<void> {
  const controller = createScheduledController({
    scheduledTime: new Date(),
    cron: "0 3 * * *",
  });
  const ctx = createExecutionContext();
  await worker.scheduled?.(controller, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("housekeeping cron", () => {
  beforeEach(resetDatabase);

  it("deletes expired sessions/verifications, stale rate limits and old audit events while keeping fresh rows", async () => {
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, email_verified) VALUES ('u-1', 'User', 'user@example.com', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO session (id, expires_at, token, user_id, updated_at) VALUES ('s-expired', ?1, 't-expired', 'u-1', ?2)`,
      ).bind(now - DAY_MS, now),
      env.DB.prepare(
        `INSERT INTO session (id, expires_at, token, user_id, updated_at) VALUES ('s-fresh', ?1, 't-fresh', 'u-1', ?2)`,
      ).bind(now + DAY_MS, now),
      env.DB.prepare(
        `INSERT INTO verification (id, identifier, value, expires_at) VALUES ('v-expired', 'x', 'y', ?1)`,
      ).bind(now - DAY_MS),
      env.DB.prepare(
        `INSERT INTO verification (id, identifier, value, expires_at) VALUES ('v-fresh', 'x', 'y', ?1)`,
      ).bind(now + DAY_MS),
      env.DB.prepare(
        `INSERT INTO rate_limit (id, key, count, last_request) VALUES ('r-stale', 'app:stale:1', 1, ?1)`,
      ).bind(now - 2 * DAY_MS),
      env.DB.prepare(
        `INSERT INTO rate_limit (id, key, count, last_request) VALUES ('r-fresh', 'app:fresh:1', 1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO audit_events (id, at, event) VALUES ('a-old', ?1, 'old.event')`,
      ).bind(now - 91 * DAY_MS),
      env.DB.prepare(
        `INSERT INTO audit_events (id, at, event) VALUES ('a-recent', ?1, 'recent.event')`,
      ).bind(now),
    ]);

    await runScheduled();

    const [sessions, verifications, rateLimits, auditEvents] =
      await Promise.all([
        env.DB.prepare(`SELECT id FROM session ORDER BY id`).all<{
          id: string;
        }>(),
        env.DB.prepare(`SELECT id FROM verification ORDER BY id`).all<{
          id: string;
        }>(),
        env.DB.prepare(`SELECT id FROM rate_limit ORDER BY id`).all<{
          id: string;
        }>(),
        env.DB.prepare(`SELECT id FROM audit_events ORDER BY id`).all<{
          id: string;
        }>(),
      ]);

    expect(sessions.results.map((r) => r.id)).toEqual(["s-fresh"]);
    expect(verifications.results.map((r) => r.id)).toEqual(["v-fresh"]);
    expect(rateLimits.results.map((r) => r.id)).toEqual(["r-fresh"]);
    expect(auditEvents.results.map((r) => r.id)).toEqual(["a-recent"]);
  });
});
