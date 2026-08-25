/** Shared constants and schemas are added in Phase 1. */
export const APP_ID = "flare-idp" as const;

export type { ErrorCode } from "./errors";
export { ERROR_CODES, errorBodySchema } from "./errors";

export type { Role } from "./roles";
export { ROLES } from "./roles";

export type { OAuthScope } from "./schemas";
export {
  emailSchema,
  emailVerifySchema,
  nameSchema,
  OAUTH_SCOPES,
  oauthClientCreateSchema,
  oauthClientDtoSchema,
  oauthClientPatchSchema,
  passwordChangeSchema,
  passwordForgotSchema,
  passwordResetSchema,
  passwordSchema,
  profilePatchSchema,
  SCOPE_DESCRIPTIONS,
  sessionInfoSchema,
  sessionUserSchema,
  setupCompleteSchema,
  signInSchema,
} from "./schemas";
