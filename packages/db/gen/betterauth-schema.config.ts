import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { admin, jwt } from "better-auth/plugins";

/**
 * Schema-generation-only config for `bun x auth generate`. Not imported at
 * runtime — env values are irrelevant here since only the plugin/options
 * shape determines the generated table columns.
 *
 * KEEP IN SYNC with packages/api/src/auth/auth.ts plugin list.
 */
export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  session: { storeSessionInDatabase: true },
  advanced: { database: { generateId: "uuid" } },
  plugins: [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
  ],
});
