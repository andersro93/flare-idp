import { env } from "cloudflare:test";

/** Children before parents; extend when new tables land in later phases. */
export const RESET_ORDER = [
  "audit_events",
  "rate_limit",
  "jwks",
  "verification",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
  "oauth_client_resource",
  "oauth_client",
  "oauth_resource",
  "oauth_client_assertion",
  "account",
  "session",
  "user",
  "app_settings",
] as const;

export async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    ...RESET_ORDER.map((t) => env.DB.prepare(`DELETE FROM "${t}"`)),
    env.DB.prepare(
      `UPDATE app_installation SET status = 'pending', owner_user_id = NULL, owner_email = NULL, completed_at = NULL WHERE id = 1`,
    ),
  ]);
}
