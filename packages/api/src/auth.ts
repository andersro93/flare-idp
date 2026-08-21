import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { admin, jwt, twoFactor } from "better-auth/plugins";
import { kvSecondaryStorage } from "./kv-secondary-storage";

export type CreateAuthOptions = {
  /** Use KV as Better-Auth secondaryStorage (session cache). */
  useKv?: boolean;
};

export function createAuth(env: Env, options: CreateAuthOptions = {}) {
  const origin = new URL(env.APP_URL);
  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    // Spike: native D1 dialect (auto-detected). Phase 1 switches to the
    // Drizzle adapter + generated schema.
    database: env.DB,
    secondaryStorage: options.useKv ? kvSecondaryStorage(env.KV) : undefined,
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: false,
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } } }),
      twoFactor({ issuer: env.APP_NAME }),
      passkey({
        rpID: origin.hostname,
        rpName: env.APP_NAME,
        origin: env.APP_URL,
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        scopes: ["openid", "profile", "email", "offline_access"],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
