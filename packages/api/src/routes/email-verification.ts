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

// `.openapi()` calls MUST be chained directly off `newRouter()`'s result
// and the return captured — `OpenAPIHono#openapi()` returns a NEW,
// more-refined-Schema type; calling it without capturing the return
// leaves the ORIGINAL binding's static type unchanged (still
// `Schema = {}`). That's harmless at runtime (the route is still
// registered — `.openapi()` mutates in place too) but silently erases
// this route file's contribution to `AppType`, which is what
// `hc<AppType>` types itself from. See
// `apps/idp/test/unit/hc-client.test.ts`.
//
// `.use()`, by contrast, must NOT be chained into that same expression:
// its declared return type is the base `Hono`, not `OpenAPIHono` (a known
// upstream typing gap — see `app-shared.ts`'s `newRouter()` docstring), so
// chaining `.openapi()` after a `.use()` call is a type error. Calling
// `.use()` as bare statements on `emailVerificationRoutesBase` sidesteps
// that: the side effects (registering the middleware) still happen, in
// the same order, before the `.openapi()` chain below runs its own
// registration — only the STATIC TYPE of a captured return value would
// have been wrong, and nothing captures it.
const emailVerificationRoutesBase = newRouter();
// requireAuth/rateLimit are wired via their own `.use()` statements per
// route, so the public `/verify` route stays unauthenticated while
// `/resend` requires a session.
emailVerificationRoutesBase.use("/verify", rateLimit(RATE_LIMITS.emailVerify));
emailVerificationRoutesBase.use("/resend", requireAuth);

export const emailVerificationRoutes = emailVerificationRoutesBase
  .openapi(verifyRoute, async (c) => {
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
  })
  .openapi(resendRoute, async (c) => {
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
