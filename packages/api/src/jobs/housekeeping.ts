import { logEvent } from "../http/log";

const RATE_LIMIT_STALE_MS = 24 * 60 * 60 * 1000;
const AUDIT_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Scheduled cron cleanup. Raw SQL (not the drizzle query builder) against
 * the real column names in `packages/db/src/schema/{auth,app}.ts`:
 * `session.expires_at` / `verification.expires_at` (both `timestamp_ms`,
 * epoch milliseconds — comparable directly against `Date.now()`),
 * `rate_limit.last_request` and `audit_events.at` (plain integers, also
 * epoch milliseconds — `consumeRateLimit`/`recordAuditEvent` both write
 * `Date.now()`).
 */
export async function runHousekeeping(env: Env): Promise<void> {
  const now = Date.now();
  const rateLimitCutoff = now - RATE_LIMIT_STALE_MS;
  const auditEventCutoff = now - AUDIT_EVENT_RETENTION_MS;

  const [sessions, verifications, rateLimits, auditEvents] = await env.DB.batch(
    [
      env.DB.prepare("DELETE FROM session WHERE expires_at < ?1").bind(now),
      env.DB.prepare("DELETE FROM verification WHERE expires_at < ?1").bind(
        now,
      ),
      env.DB.prepare("DELETE FROM rate_limit WHERE last_request < ?1").bind(
        rateLimitCutoff,
      ),
      env.DB.prepare("DELETE FROM audit_events WHERE at < ?1").bind(
        auditEventCutoff,
      ),
    ],
  );

  logEvent("info", "housekeeping_completed", {
    sessionsDeleted: sessions?.meta.changes ?? 0,
    verificationsDeleted: verifications?.meta.changes ?? 0,
    rateLimitDeleted: rateLimits?.meta.changes ?? 0,
    auditEventsDeleted: auditEvents?.meta.changes ?? 0,
  });
}
