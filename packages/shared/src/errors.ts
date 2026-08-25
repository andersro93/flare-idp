import { z } from "zod";

export const ERROR_CODES = [
  "invalid_request",
  "invalid_credentials",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "invalid_token",
  "email_not_verified",
  "setup_already_complete",
  "invalid_setup_secret",
  "misconfigured",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
  }),
});
