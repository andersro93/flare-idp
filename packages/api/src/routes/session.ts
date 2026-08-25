import { dbFor, recordAuditEvent } from "@flare-idp/db";
import {
  errorBodySchema,
  ROLES,
  type sessionUserSchema,
  signInSchema,
} from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { callAuth } from "../auth/forward";
import { auth } from "../http/app";
import { newRouter } from "../http/app-shared";
import { AppError, errorBody } from "../http/errors";
import { requireAuth } from "../http/middleware/require-auth";
import { sessionUserResponseSchema } from "../http/openapi-schemas";
import {
  clientAddress,
  consumeRateLimit,
  RATE_LIMITS,
} from "../http/security/rate-limit";

type SessionUserPayload = z.infer<typeof sessionUserSchema>;

/** Narrows a free-form role string to the closed `ROLES` union, defaulting to "user". */
function toRole(role: string): SessionUserPayload["role"] {
  return (ROLES as readonly string[]).includes(role)
    ? (role as SessionUserPayload["role"])
    : "user";
}

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: errorBodySchema } },
  } as const;
}

function toSessionUserPayload(user: {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
  role?: unknown;
  createdAt: Date;
}): SessionUserPayload {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: typeof user.image === "string" ? user.image : null,
    emailVerified: user.emailVerified,
    role: toRole(typeof user.role === "string" ? user.role : "user"),
    createdAt: user.createdAt,
  };
}

function sessionExpiresAt(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

const currentSessionInfoSchema = z.object({
  id: z.string(),
  expiresAt: z.coerce.date(),
});

const getSessionResponseSchema = z.union([
  z.object({
    user: sessionUserResponseSchema,
    session: currentSessionInfoSchema,
  }),
  z.object({ user: z.null(), session: z.null() }),
]);

const getSessionRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      description: "The current session, or nulls when unauthenticated.",
      content: { "application/json": { schema: getSessionResponseSchema } },
    },
  },
});

const signInResponseSchema = z.object({ user: sessionUserResponseSchema });

const signInRoute = createRoute({
  method: "post",
  path: "/sign-in/password",
  request: {
    body: { content: { "application/json": { schema: signInSchema } } },
  },
  responses: {
    200: {
      description: "Signed in.",
      content: { "application/json": { schema: signInResponseSchema } },
    },
    400: errorResponse("The request body failed validation."),
    401: errorResponse("The email or password was incorrect."),
    403: errorResponse("Cross-site request rejected."),
    429: errorResponse("Too many sign-in attempts; retry later."),
  },
});

const signOutRoute = createRoute({
  method: "post",
  path: "/sign-out",
  responses: {
    204: { description: "Signed out." },
    401: errorResponse("Authentication required."),
  },
});

const signOutAllRoute = createRoute({
  method: "post",
  path: "/sign-out-all",
  responses: {
    204: { description: "All sessions revoked." },
    401: errorResponse("Authentication required."),
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
// `.use()` as bare statements on `sessionRoutesBase` sidesteps that: the
// side effects (registering the middleware) still happen, in the same
// order, before the `.openapi()` chain below runs its own registration —
// only the STATIC TYPE of a captured return value would have been wrong,
// and nothing captures it.
const sessionRoutesBase = newRouter();
// requireAuth is wired via its own `.use()` statement per route, so the
// public `GET /` and `POST /sign-in/password` routes stay unauthenticated.
sessionRoutesBase.use("/sign-out", requireAuth);
sessionRoutesBase.use("/sign-out-all", requireAuth);

export const sessionRoutes = sessionRoutesBase
  // Built ONLY from the `loadSession` vars (`c.get("user")`/`c.get("session")`)
  // — no extra `auth.api.getSession` call, since `loadSession` already made
  // that call for every `/api/*` request this turn.
  .openapi(getSessionRoute, (c) => {
    const user = c.get("user");
    const session = c.get("session");

    if (!user || !session) {
      return c.json({ user: null, session: null }, 200);
    }

    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image ?? null,
          emailVerified: user.emailVerified,
          role: toRole(user.role),
          createdAt: user.createdAt,
        },
        session: {
          id: session.id,
          expiresAt: sessionExpiresAt(session.expiresAt),
        },
      },
      200,
    );
  })
  .openapi(signInRoute, async (c) => {
    const body = c.req.valid("json");
    const ip = clientAddress(c.req.raw.headers);
    const db = dbFor(c.env.DB);

    // Rate limit runs first, keyed by ip+email, BEFORE any auth call or audit
    // write — a locked-out client must not get unlimited credential-stuffing
    // attempts nor generate audit noise.
    const decision = await consumeRateLimit(
      c.env.DB,
      RATE_LIMITS.signIn,
      `${ip}:${body.email}`,
    );
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return c.json(
        errorBody(
          "rate_limited",
          "Too many sign-in attempts. Please try again later.",
        ),
        429,
      );
    }

    try {
      const result = await callAuth(c, () =>
        auth.api.signInEmail({
          body: { email: body.email, password: body.password },
          headers: c.req.raw.headers,
          returnHeaders: true,
        }),
      );

      await recordAuditEvent(db, {
        event: "session.sign_in",
        actorUserId: result.user.id,
        actorIp: ip,
        target: body.email,
      });

      return c.json({ user: toSessionUserPayload(result.user) }, 200);
    } catch (error) {
      if (error instanceof AppError && error.code === "invalid_credentials") {
        // Audited WITHOUT the password — ip + email only.
        await recordAuditEvent(db, {
          event: "session.sign_in_failed",
          actorIp: ip,
          target: body.email,
        });
      }
      throw error;
    }
  })
  .openapi(signOutRoute, async (c) => {
    const user = c.get("user");
    const ip = clientAddress(c.req.raw.headers);
    const db = dbFor(c.env.DB);

    await callAuth(c, () =>
      auth.api.signOut({ headers: c.req.raw.headers, returnHeaders: true }),
    );

    await recordAuditEvent(db, {
      event: "session.sign_out",
      actorUserId: user?.id ?? null,
      actorIp: ip,
    });

    return c.body(null, 204);
  })
  .openapi(signOutAllRoute, async (c) => {
    const user = c.get("user");
    const ip = clientAddress(c.req.raw.headers);
    const db = dbFor(c.env.DB);

    await callAuth(c, () =>
      auth.api.revokeSessions({
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );
    await callAuth(c, () =>
      auth.api.signOut({ headers: c.req.raw.headers, returnHeaders: true }),
    );

    await recordAuditEvent(db, {
      event: "session.sign_out_all",
      actorUserId: user?.id ?? null,
      actorIp: ip,
    });

    return c.body(null, 204);
  });
