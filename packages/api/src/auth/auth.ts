// Production Better-Auth core. Keep the plugin list in sync with
// `packages/db/gen/betterauth-schema.config.ts` (schema-generation-only
// config for `bun x auth generate`) — a comment in both files says so.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { dbFor, schema } from "@flare-idp/db";
import { type EmailSender, queueEmailSender } from "@flare-idp/email";
import { MACHINE_SCOPES, OAUTH_SCOPES } from "@flare-idp/shared";
import { betterAuth } from "better-auth/minimal";
import { admin, jwt } from "better-auth/plugins";
import { kvSecondaryStorage } from "../kv-secondary-storage";

export type CreateAuthDeps = { emailSender?: EmailSender };
export type CreateAuthOptions = { allowSignUp?: boolean };

export function createAuth(
  env: Env,
  deps: CreateAuthDeps = {},
  opts: CreateAuthOptions = {},
) {
  const sender = deps.emailSender ?? queueEmailSender(env.EMAIL_QUEUE);
  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(dbFor(env.DB), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    secondaryStorage: kvSecondaryStorage(env.KV),
    session: {
      storeSessionInDatabase: true,
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
      // No cookieCache: session reads must always hit KV/D1 so revocation
      // takes effect on the next request (KV is the read cache). See
      // loadSession's disableCookieCache.
    },
    verification: { storeInDatabase: true },
    emailAndPassword: {
      enabled: true,
      // Invite-only: sign-up is disabled everywhere except the one-shot
      // provisioning instance the setup route constructs with
      // `{ allowSignUp: true }`.
      disableSignUp: !opts.allowSignUp,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sender.send({
          kind: "reset-password",
          to: user.email,
          recipientName: user.name ?? user.email,
          url,
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sender.send({
          kind: "verify-email",
          to: user.email,
          recipientName: user.name ?? user.email,
          url,
        });
      },
    },
    // Our D1 limiter (http/security/rate-limit.ts) guards the facade;
    // Better-Auth's own limiter would only ever see allowlisted routes.
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies:
        env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test",
    },
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      // Issuer knob (docs/decisions.md, recommended option 1): bare-origin
      // OIDC issuer, keeps the /api/auth mount.
      jwt({
        jwt: { issuer: env.APP_URL },
        jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
      }),
      // Client CRUD happens only through our requireAdmin facade; the
      // plugin's own client endpoints stay OFF the allowlist.
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        // User-delegated scopes + machine scopes: the plugin only issues
        // client_credentials tokens for scopes that are BOTH in this list and
        // not user-delegated, so MACHINE_SCOPES must be registered here even
        // though the consent facade never shows them.
        scopes: [...OAUTH_SCOPES, ...MACHINE_SCOPES],
        // Machine scopes are an internal M2M concern — keep them out of the
        // public discovery doc's `scopes_supported` (the plugin validates at
        // init that every advertised scope is in `scopes` above).
        advertisedMetadata: { scopes_supported: [...OAUTH_SCOPES] },
        storeClientSecret: "hashed",
        // Facade-only client CRUD still holds (endpoints off the allowlist),
        // but `client_credentials_scopes` assignment is additionally gated by
        // the plugin behind `clientPrivileges` even for server-side
        // `auth.api.admin*` calls (`assertClientPrivileges` throws
        // UNAUTHORIZED for "configure-client-credentials-scopes" when the
        // option is unset) — grant it to admins. NOTE: setting this ALSO
        // activates the plugin's cross-owner carve-out on client update (see
        // the ownership note in routes/admin-oauth-clients.ts).
        clientPrivileges: ({ user }) =>
          ((user as { role?: string } | undefined)?.role ?? "user") === "admin",
        customIdTokenClaims: ({ user }) => ({
          role: (user as { role?: string }).role ?? "user",
        }),
        customUserInfoClaims: ({ user }) => ({
          role: (user as { role?: string }).role ?? "user",
        }),
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
