import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { appInstallation } from "../schema/app";

export type InstallationStatus = "pending" | "in_progress" | "complete";

export interface Installation {
  id: number;
  status: InstallationStatus;
  ownerUserId: string | null;
  ownerEmail: string | null;
  completedAt: number | null;
}

/** Reads the single-row install state (id = 1). */
export async function getInstallation(
  db: AppDatabase,
): Promise<Installation | undefined> {
  const [row] = await db
    .select()
    .from(appInstallation)
    .where(eq(appInstallation.id, 1))
    .limit(1);
  return row as Installation | undefined;
}

/**
 * Atomically claims the install lock: flips `pending` → `in_progress`.
 * Returns `true` only for the caller that performed the transition — a
 * second concurrent/subsequent call returns `false`.
 */
export async function claimInstallation(db: AppDatabase): Promise<boolean> {
  const result = await db.run(
    sql`UPDATE app_installation SET status = 'in_progress' WHERE id = 1 AND status = 'pending'`,
  );
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return changes === 1;
}

/** Marks the install complete and records the owner who completed it. */
export async function completeInstallation(
  db: AppDatabase,
  { userId, email }: { userId: string; email: string },
): Promise<void> {
  await db
    .update(appInstallation)
    .set({
      status: "complete",
      ownerUserId: userId,
      ownerEmail: email,
      completedAt: Date.now(),
    })
    .where(eq(appInstallation.id, 1));
}

/**
 * Rolls a claimed install lock back to `pending`. Used when provisioning the
 * admin account fails after `claimInstallation` succeeded, so a later
 * request can retry setup from a clean state.
 */
export async function releaseInstallation(db: AppDatabase): Promise<void> {
  await db
    .update(appInstallation)
    .set({ status: "pending", ownerUserId: null, ownerEmail: null })
    .where(eq(appInstallation.id, 1));
}
