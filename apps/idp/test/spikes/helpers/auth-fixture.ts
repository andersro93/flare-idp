import { env } from "cloudflare:test";
import { type Auth, createAuth } from "@flare-idp/api";
import { getMigrations } from "better-auth/db/migration";
import { CookieJar } from "./cookies";

export const SPIKE_USER = {
  email: "spike@example.com",
  password: "correct-horse-battery-staple",
  name: "Spike",
};

/** Create a Better-Auth instance for spikes (native D1; optional KV). */
export function createSpikeAuth(options: { useKv?: boolean } = {}): Auth {
  return createAuth(env, options);
}

/** Create Better-Auth tables in the (isolated, per-test) D1 via the Kysely migrator. */
export async function migrateSpikeDb(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/** Sign up SPIKE_USER and return a jar holding the session cookie. */
export async function signUpSpikeUser(
  auth: Auth,
  jar = new CookieJar(),
): Promise<{ jar: CookieJar; userId: string }> {
  const { headers, response } = await auth.api.signUpEmail({
    body: SPIKE_USER,
    headers: jar.headers(),
    returnHeaders: true,
  });
  jar.absorb(headers);
  return { jar, userId: response.user.id };
}

/** Promote a user to admin directly in D1 (spikes only). */
export async function promoteToAdmin(userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?1`)
    .bind(userId)
    .run();
}
