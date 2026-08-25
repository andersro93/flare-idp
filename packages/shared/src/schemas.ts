import { z } from "zod";
import { ROLES } from "./roles";

export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  openid: "Sign you in and identify you",
  profile: "Read your name and profile picture",
  email: "Read your email address",
  offline_access: "Stay signed in (refresh tokens)",
};

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const passwordSchema = z.string().min(12).max(128);

export const nameSchema = z.string().trim().min(1).max(100);

export const setupCompleteSchema = z.object({
  secret: z.string().min(1),
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const passwordForgotSchema = z.object({
  email: emailSchema,
});

export const passwordResetSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
  revokeOtherSessions: z.boolean().default(true),
});

export const emailVerifySchema = z.object({
  token: z.string().min(1),
});

export const profilePatchSchema = z
  .object({
    name: nameSchema.optional(),
    image: z.union([z.url(), z.null()]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "empty patch");

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
  emailVerified: z.boolean(),
  role: z.enum(ROLES).catch("user"),
  createdAt: z.coerce.date(),
});

export const sessionInfoSchema = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  userAgent: z.string().nullable().optional(),
  ipAddress: z.string().nullable().optional(),
  current: z.boolean(),
});

// Fields are intentionally loose strings/arrays here (not enums) — the
// admin OAuth-client facade (packages/api/src/routes/admin-oauth-clients.ts)
// enforces the actual policy (allowed scopes/grant types/auth methods,
// redirect URI shape) itself, BEFORE calling Better-Auth, so it can return a
// specific `invalid_request` message. Restricting these to zod enums here
// would just produce a generic zod validation message instead and skip that
// policy code entirely.
export const oauthClientCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  redirectUris: z.array(z.string().trim().min(1)),
  tokenEndpointAuthMethod: z.string().trim().min(1),
  grantTypes: z.array(z.string().trim().min(1)).min(1),
  scope: z.array(z.string().trim().min(1)).min(1),
  skipConsent: z.boolean().default(false),
  applicationType: z.enum(["web", "native"]).optional(),
});

// `tokenEndpointAuthMethod` is deliberately NOT patchable: Better-Auth's
// `adminUpdateOAuthClient` `update` body schema has no such field (verified
// against the installed d.mts) — changing it has side effects (clearing
// `client_secret`, requiring `jwks`/`jwks_uri` for `private_key_jwt`) that
// the admin update endpoint doesn't handle, so it's simply not part of that
// contract. Rotate/recreate the client to change it.
export const oauthClientPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    redirectUris: z.array(z.string().trim().min(1)).optional(),
    grantTypes: z.array(z.string().trim().min(1)).min(1).optional(),
    scope: z.array(z.string().trim().min(1)).min(1).optional(),
    skipConsent: z.boolean().optional(),
    applicationType: z.enum(["web", "native"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "empty patch");

// Consent decision body for POST /api/oauth/consent. `oauthQuery` is the
// VERBATIM query string Better-Auth appended when redirecting the browser to
// the consent page (it carries a signature + expiry the plugin verifies) —
// camelCase here, proxied to Better-Auth as snake_case `oauth_query`. An
// omitted `scope` accepts all originally requested scopes.
export const consentPostSchema = z.object({
  accept: z.boolean(),
  scope: z.array(z.enum(OAUTH_SCOPES)).optional(),
  oauthQuery: z.string().min(1),
});

// GET /api/oauth/consent response: what the consent screen renders.
export const consentInfoSchema = z.object({
  client: z.object({
    clientId: z.string(),
    name: z.string().optional(),
    logoUri: z.string().optional(),
  }),
  scopes: z.array(
    z.object({ id: z.enum(OAUTH_SCOPES), description: z.string() }),
  ),
});

// camelCase DTO — never carries `clientSecret` (that's added only by the
// create/rotate response wrappers in the route file, where the plaintext
// secret is genuinely present).
export const oauthClientDtoSchema = z.object({
  clientId: z.string(),
  name: z.string().optional(),
  redirectUris: z.array(z.string()),
  tokenEndpointAuthMethod: z.string().optional(),
  grantTypes: z.array(z.string()).optional(),
  scope: z.string().optional(),
  skipConsent: z.boolean().optional(),
  applicationType: z.enum(["web", "native"]).nullable().optional(),
  disabled: z.boolean().optional(),
  createdAt: z.coerce.date().optional(),
});
