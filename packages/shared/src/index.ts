/** Shared constants and schemas are added in Phase 1. */
export const APP_ID = "flare-idp" as const;

export type { ErrorCode } from "./errors";
export { ERROR_CODES, errorBodySchema } from "./errors";

export type { Role } from "./roles";
export { ROLES } from "./roles";

export {
  emailSchema,
  emailVerifySchema,
  nameSchema,
  passwordChangeSchema,
  passwordForgotSchema,
  passwordResetSchema,
  passwordSchema,
  profilePatchSchema,
  sessionInfoSchema,
  sessionUserSchema,
  setupCompleteSchema,
  signInSchema,
} from "./schemas";
