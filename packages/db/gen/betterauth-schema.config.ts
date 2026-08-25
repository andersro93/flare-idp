import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
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
  // Required by the oauthProvider plugin's init (issuer URL parsing) —
  // irrelevant to the generated schema, never used at runtime.
  baseURL: "http://localhost:3000",
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  session: { storeSessionInDatabase: true },
  advanced: { database: { generateId: "uuid" } },
  plugins: [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/oauth/consent",
      scopes: ["openid", "profile", "email", "offline_access"],
      storeClientSecret: "hashed",
      customIdTokenClaims: ({ user }) => ({
        role: (user as { role?: string }).role ?? "user",
      }),
      customUserInfoClaims: ({ user }) => ({
        role: (user as { role?: string }).role ?? "user",
      }),
    }),
  ],
});
