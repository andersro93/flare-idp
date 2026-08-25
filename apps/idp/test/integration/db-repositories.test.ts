import { env } from "cloudflare:test";
import {
  claimInstallation,
  completeInstallation,
  dbFor,
  getInstallation,
  getSettings,
  listAuditEvents,
  putSettings,
  recordAuditEvent,
} from "@flare-idp/db";
import { beforeEach, describe, expect, it } from "vitest";

const db = dbFor(env.DB);

// This file owns its own cleanup (no shared resetDatabase() helper until
// Task 5) — tests within it share D1 state, so every test starts from the
// same known-clean rows.
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_events").run();
  await env.DB.prepare(
    "UPDATE app_installation SET status = 'pending', owner_user_id = NULL, owner_email = NULL, completed_at = NULL WHERE id = 1",
  ).run();
  await env.DB.prepare(
    "UPDATE app_settings SET settings = '{}', updated_at = 0 WHERE id = 1",
  ).run();
});

describe("audit repository", () => {
  it("records and lists audit events, newest first", async () => {
    await recordAuditEvent(db, { event: "test.one", actorIp: "127.0.0.1" });
    await recordAuditEvent(db, { event: "test.two", actorUserId: "u1" });

    const { items } = await listAuditEvents(db, { limit: 10 });
    expect(items.map((e) => e.event)).toEqual(["test.two", "test.one"]);
    expect(items[0]?.actorUserId).toBe("u1");
    expect(items[1]?.actorIp).toBe("127.0.0.1");
  });

  it("filters by event name", async () => {
    await recordAuditEvent(db, { event: "login.success" });
    await recordAuditEvent(db, { event: "login.failure" });
    await recordAuditEvent(db, { event: "login.success" });

    const { items } = await listAuditEvents(db, {
      limit: 10,
      event: "login.failure",
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.event).toBe("login.failure");
  });

  it("paginates with a cursor", async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordAuditEvent(db, { event: `paged.${i}` });
    }

    const page1 = await listAuditEvents(db, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listAuditEvents(db, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items].map((e) => e.event);
    expect(new Set(seen)).toEqual(new Set(["paged.0", "paged.1", "paged.2"]));
  });

  it("never throws, even when insertion fails", async () => {
    // event is NOT NULL — passing an object without it (cast past the type
    // system, as a caller bug would) must not throw.
    await expect(
      recordAuditEvent(db, { event: undefined as unknown as string }),
    ).resolves.toBeUndefined();
  });
});

describe("installation repository", () => {
  it("reads the seeded pending row", async () => {
    const installation = await getInstallation(db);
    expect(installation?.status).toBe("pending");
    expect(installation?.ownerUserId).toBeNull();
  });

  it("claims the install lock exactly once", async () => {
    const first = await claimInstallation(db);
    expect(first).toBe(true);

    const second = await claimInstallation(db);
    expect(second).toBe(false);

    const installation = await getInstallation(db);
    expect(installation?.status).toBe("in_progress");
  });

  it("completes the install with owner details", async () => {
    await claimInstallation(db);
    await completeInstallation(db, {
      userId: "owner-1",
      email: "owner@example.com",
    });

    const installation = await getInstallation(db);
    expect(installation?.status).toBe("complete");
    expect(installation?.ownerUserId).toBe("owner-1");
    expect(installation?.ownerEmail).toBe("owner@example.com");
    expect(installation?.completedAt).toBeTypeOf("number");
  });
});

describe("settings repository", () => {
  it("reads the seeded default settings", async () => {
    const settings = await getSettings(db);
    expect(settings).toEqual({});
  });

  it("returns parsed defaults when the row is missing", async () => {
    await env.DB.prepare("DELETE FROM app_settings WHERE id = 1").run();
    const settings = await getSettings(db);
    expect(settings).toEqual({});
  });

  it("round-trips settings via upsert", async () => {
    await putSettings(db, { theme: "dark", inviteOnly: true });
    const settings = await getSettings(db);
    expect(settings).toEqual({ theme: "dark", inviteOnly: true });

    await putSettings(db, { theme: "light" });
    const updated = await getSettings(db);
    expect(updated).toEqual({ theme: "light" });
  });

  it("upserts even when the row was deleted", async () => {
    await env.DB.prepare("DELETE FROM app_settings WHERE id = 1").run();
    await putSettings(db, { fresh: true });
    const settings = await getSettings(db);
    expect(settings).toEqual({ fresh: true });
  });
});
