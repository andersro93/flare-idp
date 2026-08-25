import { dbFor, recordAuditEvent } from "@flare-idp/db";
import { emailVerifySchema, errorBodySchema } from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { callAuth, mapAuthError } from "../auth/forward";
import { auth } from "../http/app";
import { newRouter } from "../http/app-shared";
import { AppError } from "../http/errors";
import { requireAuth } from "../http/middleware/require-auth";
import {
  clientAddress,
  RATE_LIMITS,
  rateLimit,
} from "../http/security/rate-limit";

export const emailVerificationRoutes = newRouter();

// requireAuth/rateLimit are wired via their own `.use()` statements per
// route, so the public `/verify` route stays unauthenticated while
// `/resend` requires a session.
emailVerificationRoutes.use("/verify", rateLimit(RATE_LIMITS.emailVerify));
emailVerificationRoutes.use("/resend", requireAuth);

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: errorBodySchema } },
  } as const;
}

const okSchema = z.object({ ok: z.literal(true) });

/** A 4xx `AppError` from a token-bearing Better-Auth call, route-remapped to `invalid_token`. */
function isClientError(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * `verifyEmail`'s success payload sometimes carries the affected user (email
 * changes) and sometimes doesn't (the plain verify-email flow returns
 * `user: null`) — narrow defensively rather than trusting the declared
 * (looser) SDK return type.
 */
function verifiedUserIdFrom(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("user" in result)) {
    return null;
  }
  const user = (result as { user?: unknown }).user;
  if (!user || typeof user !== "object" || !("id" in user)) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

const verifyRoute = createRoute({
  method: "post",
  path: "/verify",
  request: {
    body: {
      content: { "application/json": { schema: emailVerifySchema } },
    },
  },
  responses: {
    200: {
      description: "Email verified.",
      content: { "application/json": { schema: okSchema } },
    },
    400: errorResponse(
      "The request body failed validation, or the token is invalid/expired.",
    ),
    403: errorResponse("Cross-site request rejected."),
    429: errorResponse("Too many requests; retry later."),
  },
});

emailVerificationRoutes.openapi(verifyRoute, async (c) => {
  const body = c.req.valid("json");
  const db = dbFor(c.env.DB);
  const ip = clientAddress(c.req.raw.headers);
  const varsUser = c.get("user");

  let result: unknown;
  try {
    result = await callAuth(c, () =>
      auth.api.verifyEmail({
        query: { token: body.token },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );
  } catch (error) {
    // Route-level semantic remap: any 4xx from verifyEmail (missing token,
    // expired/consumed token, unknown token) reads as `invalid_token` to the
    // caller, regardless of Better-Auth's underlying status.
    if (error instanceof AppError && isClientError(error.status)) {
      throw new AppError(
        400,
        "invalid_token",
        "The verification token is invalid or expired.",
      );
    }
    throw error;
  }

  await recordAuditEvent(db, {
    event: "email.verified",
    actorUserId: verifiedUserIdFrom(result) ?? varsUser?.id ?? null,
    actorIp: ip,
  });

  return c.json({ ok: true as const }, 200);
});

const resendRoute = createRoute({
  method: "post",
  path: "/resend",
  responses: {
    200: {
      description: "Verification email re-sent.",
      content: { "application/json": { schema: okSchema } },
    },
    401: errorResponse("Authentication required."),
    403: errorResponse("Cross-site request rejected."),
  },
});

emailVerificationRoutes.openapi(resendRoute, async (c) => {
  const user = c.get("user");
  // requireAuth already guards this path; narrow for the type checker.
  if (!user) {
    throw new AppError(401, "unauthorized", "Authentication required");
  }

  try {
    // No `returnHeaders`/`callAuth`: this call sets no cookies to forward.
    await auth.api.sendVerificationEmail({
      body: { email: user.email, callbackURL: "/verify-email" },
      headers: c.req.raw.headers,
    });
  } catch (error) {
    throw mapAuthError(error);
  }

  return c.json({ ok: true as const }, 200);
});
