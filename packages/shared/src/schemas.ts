import { z } from "zod";
import { ROLES } from "./roles";

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
