import { eq } from "drizzle-orm";
import type { AppDatabase } from "../client";
import { appSettings } from "../schema/app";

export type SettingsJson = Record<string, unknown>;

/**
 * Reads the single-row instance settings (id = 1). Returns parsed defaults
 * (`{}`) when the row is missing — later test helpers may delete it, and
 * settings are otherwise optional until first configured.
 */
export async function getSettings(db: AppDatabase): Promise<SettingsJson> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .limit(1);
  if (!row) return {};
  return JSON.parse(row.settings) as SettingsJson;
}

/** Upserts the single-row instance settings (id = 1). */
export async function putSettings(
  db: AppDatabase,
  json: SettingsJson,
): Promise<void> {
  const settings = JSON.stringify(json);
  const updatedAt = Date.now();
  await db
    .insert(appSettings)
    .values({ id: 1, settings, updatedAt })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { settings, updatedAt },
    });
}
