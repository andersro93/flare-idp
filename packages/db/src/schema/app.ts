import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** First-run state; a single row (id = 1) seeded by the init migration. */
export const appInstallation = sqliteTable("app_installation", {
  id: integer("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  ownerUserId: text("owner_user_id"),
  ownerEmail: text("owner_email"),
  completedAt: integer("completed_at"),
});

/** Single-row instance settings (id = 1), JSON blob validated by @flare-idp/shared. */
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  settings: text("settings").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull().default(0),
});

/** Security/audit events. Append-only; pruned by the housekeeping cron. */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    event: text("event").notNull(),
    actorUserId: text("actor_user_id"),
    actorIp: text("actor_ip"),
    target: text("target"),
    details: text("details"),
  },
  (t) => [
    index("audit_events_at_idx").on(t.at),
    index("audit_events_event_idx").on(t.event),
  ],
);

/** Fixed-window rate-limit counters (see packages/api http/security/rate-limit.ts). */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});
