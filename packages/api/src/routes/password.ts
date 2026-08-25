import { dbFor, recordAuditEvent } from "@flare-idp/db";
import {
  errorBodySchema,
  passwordChangeSchema,
  passwordForgotSchema,
  passwordResetSchema,
} from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { APIError } from "better-auth";
import { callAuth } from "../auth/forward";
import { auth } from "../http/app";
import { newRouter } from "../http/app-shared";
import { AppError } from "../http/errors";
import { logEvent } from "../http/log";
import { requireAuth } from "../http/middleware/require-auth";
import {
  clientAddress,
  RATE_LIMITS,
  rateLimit,
  userScopedKey,
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

const forgotRoute = createRoute({
  method: "post",
  path: "/forgot",
  request: {
    body: {
      content: { "application/json": { schema: passwordForgotSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Always 200, whether or not the email belongs to an account — this route never reveals account existence.",
      content: { "application/json": { schema: okSchema } },
    },
    400: errorResponse("The request body failed validation."),
    403: errorResponse("Cross-site request rejected."),
    429: errorResponse("Too many requests; retry later."),
  },
});

const resetRoute = createRoute({
  method: "post",
  path: "/reset",
  request: {
    body: {
      content: { "application/json": { schema: passwordResetSchema } },
    },
  },
  responses: {
    200: {
      description: "Password reset; other sessions were revoked.",
      content: { "application/json": { schema: okSchema } },
    },
    400: errorResponse(
      "The request body failed validation, or the token is invalid/expired.",
    ),
    403: errorResponse("Cross-site request rejected."),
    429: errorResponse("Too many requests; retry later."),
  },
});

const changeRoute = createRoute({
  method: "post",
  path: "/change",
  request: {
    body: {
      content: { "application/json": { schema: passwordChangeSchema } },
    },
  },
  responses: {
    200: {
      description: "Password changed.",
      content: { "application/json": { schema: okSchema } },
    },
    400: errorResponse(
      "The request body failed validation, or the current password was incorrect.",
    ),
    401: errorResponse("Authentication required."),
    403: errorResponse("Cross-site request rejected."),
    429: errorResponse("Too many requests; retry later."),
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
// `.use()` as bare statements on `passwordRoutesBase` sidesteps that: the
// side effects (registering the middleware) still happen, in the same
// order, before the `.openapi()` chain below runs its own registration —
// only the STATIC TYPE of a captured return value would have been wrong,
// and nothing captures it.
const passwordRoutesBase = newRouter();
// requireAuth/rateLimit are wired via their own `.use()` statements per
// route, so the public `/forgot` and `/reset` routes stay unauthenticated
// while `/change` requires a session.
passwordRoutesBase.use("/forgot", rateLimit(RATE_LIMITS.passwordForgot));
passwordRoutesBase.use("/reset", rateLimit(RATE_LIMITS.passwordReset));
passwordRoutesBase.use("/change", requireAuth);
// Registered AFTER requireAuth (registration order) so `user` is already set
// on context — the rate limit is keyed per user, not per IP.
passwordRoutesBase.use(
  "/change",
  rateLimit(RATE_LIMITS.passwordChange, userScopedKey),
);

export const passwordRoutes = passwordRoutesBase
  .openapi(forgotRoute, async (c) => {
    const body = c.req.valid("json");

    try {
      // No `returnHeaders`/`callAuth`: Better-Auth sets no cookies for this
      // call, and any failure is swallowed below — nothing to forward.
      await auth.api.requestPasswordReset({
        body: { email: body.email, redirectTo: "/reset-password" },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      // Never surface this to the caller — the response is always 200 so an
      // attacker can't use it to enumerate registered emails. Not audited:
      // an audit row here would itself leak whether the email exists.
      logEvent("warn", "password_forgot_failed", { message: error.message });
    }

    return c.json({ ok: true as const }, 200);
  })
  .openapi(resetRoute, async (c) => {
    const body = c.req.valid("json");
    const db = dbFor(c.env.DB);
    const ip = clientAddress(c.req.raw.headers);

    try {
      await callAuth(c, () =>
        auth.api.resetPassword({
          body: { token: body.token, newPassword: body.password },
          headers: c.req.raw.headers,
          returnHeaders: true,
        }),
      );
    } catch (error) {
      // Route-level semantic remap: any 4xx from resetPassword (missing
      // token, expired/consumed token, unknown token) reads as `invalid_token`
      // to the caller, regardless of Better-Auth's underlying status.
      if (error instanceof AppError && isClientError(error.status)) {
        throw new AppError(
          400,
          "invalid_token",
          "The reset token is invalid or expired.",
        );
      }
      throw error;
    }

    // The token, not a user id, is the only proof of identity at this point —
    // Better-Auth's resetPassword response carries no user. Audited with the
    // IP only; never the token.
    await recordAuditEvent(db, {
      event: "password.reset",
      actorUserId: null,
      actorIp: ip,
    });

    return c.json({ ok: true as const }, 200);
  })
  .openapi(changeRoute, async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    const db = dbFor(c.env.DB);
    const ip = clientAddress(c.req.raw.headers);

    try {
      await callAuth(c, () =>
        auth.api.changePassword({
          body: {
            currentPassword: body.currentPassword,
            newPassword: body.newPassword,
            revokeOtherSessions: body.revokeOtherSessions,
          },
          headers: c.req.raw.headers,
          returnHeaders: true,
        }),
      );
    } catch (error) {
      // Simpler and safer than trying to distinguish Better-Auth's error
      // codes here: any CLIENT failure from changePassword (wrong current
      // password, no credential account, etc.) reads as `invalid_credentials`.
      // A 5xx (e.g. an internal Better-Auth error) must propagate as-is —
      // never masquerade a server error as a 400.
      if (error instanceof AppError && error.status < 500) {
        throw new AppError(
          400,
          "invalid_credentials",
          "The current password was incorrect.",
        );
      }
      throw error;
    }

    await recordAuditEvent(db, {
      event: "password.changed",
      actorUserId: user?.id ?? null,
      actorIp: ip,
    });

    return c.json({ ok: true as const }, 200);
  });
