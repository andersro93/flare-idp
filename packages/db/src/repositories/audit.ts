import { and, desc, eq, lt, or } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { auditEvents } from "../schema/app";

export interface AuditEventInput {
  event: string;
  actorUserId?: string | null;
  actorIp?: string | null;
  target?: string | null;
  details?: string | null;
}

export interface AuditEvent {
  id: string;
  at: number;
  event: string;
  actorUserId: string | null;
  actorIp: string | null;
  target: string | null;
  details: string | null;
}

export interface ListAuditEventsOptions {
  limit: number;
  cursor?: string;
  event?: string;
}

export interface ListAuditEventsResult {
  items: AuditEvent[];
  nextCursor: string | null;
}

/**
 * Records a security/audit event. Never throws — audit logging must not
 * break the request that triggered it. On failure, logs a JSON error line.
 */
export async function recordAuditEvent(
  db: AppDatabase,
  event: AuditEventInput,
): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      at: Date.now(),
      event: event.event,
      actorUserId: event.actorUserId ?? null,
      actorIp: event.actorIp ?? null,
      target: event.target ?? null,
      details: event.details ?? null,
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        level: "error",
        msg: "recordAuditEvent failed",
        event: event.event,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

// Cursor is `${at}_${id}`, opaque to callers. Pagination orders newest-first
// (at desc, id desc as a deterministic tiebreaker for same-millisecond events).
function encodeCursor(at: number, id: string): string {
  return `${at}_${id}`;
}

function decodeCursor(cursor: string): { at: number; id: string } {
  const separator = cursor.indexOf("_");
  return {
    at: Number(cursor.slice(0, separator)),
    id: cursor.slice(separator + 1),
  };
}

/** Lists audit events newest-first, optionally filtered by event name and paged by cursor. */
export async function listAuditEvents(
  db: AppDatabase,
  { limit, cursor, event }: ListAuditEventsOptions,
): Promise<ListAuditEventsResult> {
  const conditions = [];
  if (event) conditions.push(eq(auditEvents.event, event));
  if (cursor) {
    const { at, id } = decodeCursor(cursor);
    conditions.push(
      or(
        lt(auditEvents.at, at),
        and(eq(auditEvents.at, at), lt(auditEvents.id, id)),
      ),
    );
  }

  const rows = await db
    .select()
    .from(auditEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.at, last.id) : null;

  return { items, nextCursor };
}
