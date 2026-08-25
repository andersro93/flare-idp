import {
  claimInstallation,
  completeInstallation,
  dbFor,
  getInstallation,
  recordAuditEvent,
  releaseInstallation,
  schema,
} from "@flare-idp/db";
import {
  errorBodySchema,
  sessionUserSchema,
  setupCompleteSchema,
} from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { createAuth } from "../auth/auth";
import { callAuth } from "../auth/forward";
import { newRouter } from "../http/app-shared";
import { AppError } from "../http/errors";
import { secretsEqual } from "../http/security/compare";
import { RATE_LIMITS, rateLimit } from "../http/security/rate-limit";

export const setupRoutes = newRouter();

// Rate limit runs first, before we even look at the secret — a wrong-secret
// probe must not get unlimited attempts.
setupRoutes.use("/complete", rateLimit(RATE_LIMITS.setup));

const statusSchema = z.object({
  status: z.enum(["pending", "in_progress", "complete"]),
});

const errorResponses = {
  400: {
    description: "The request body failed validation.",
    content: { "application/json": { schema: errorBodySchema } },
  },
  403: {
    description: "The setup secret did not match.",
    content: { "application/json": { schema: errorBodySchema } },
  },
  409: {
    description: "Setup has already been completed.",
    content: { "application/json": { schema: errorBodySchema } },
  },
  429: {
    description: "Too many setup attempts; retry later.",
    content: { "application/json": { schema: errorBodySchema } },
  },
  503: {
    description: "The service is misconfigured.",
    content: { "application/json": { schema: errorBodySchema } },
  },
} as const;

const status = createRoute({
  method: "get",
  path: "/status",
  responses: {
    200: {
      description: "The current first-run install state.",
      content: { "application/json": { schema: statusSchema } },
    },
  },
});
setupRoutes.openapi(status, async (c) => {
  const db = dbFor(c.env.DB);
  const installation = await getInstallation(db);
  return c.json({ status: installation?.status ?? "pending" }, 200);
});

const complete = createRoute({
  method: "post",
  path: "/complete",
  request: {
    body: {
      content: {
        "application/json": { schema: setupCompleteSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Setup completed; the admin account was created.",
      content: {
        "application/json": { schema: z.object({ user: sessionUserSchema }) },
      },
    },
    ...errorResponses,
  },
});
setupRoutes.openapi(complete, async (c) => {
  const body = c.req.valid("json");

  const secret = c.env.SETUP_SECRET;
  if (!secret) {
    throw new AppError(503, "misconfigured", "Service is misconfigured");
  }

  if (!(await secretsEqual(body.secret, secret))) {
    throw new AppError(403, "invalid_setup_secret", "Invalid setup secret");
  }

  const db = dbFor(c.env.DB);
  const claimed = await claimInstallation(db);
  if (!claimed) {
    throw new AppError(409, "setup_already_complete", "Setup already complete");
  }

  try {
    const provisioning = createAuth(c.env, {}, { allowSignUp: true });
    const result = await callAuth(c, () =>
      provisioning.api.signUpEmail({
        body: { email: body.email, password: body.password, name: body.name },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );

    await db
      .update(schema.user)
      .set({ role: "admin" })
      .where(eq(schema.user.id, result.user.id));

    // `signUpEmail` already mirrored `{ session, user }` into KV
    // (secondaryStorage) keyed by the raw session token, BEFORE the role
    // UPDATE above ran — that snapshot still has the pre-promotion role
    // (the admin plugin's `defaultRole`). The raw drizzle UPDATE bypasses
    // Better-Auth's own session-mirroring, so nothing else invalidates it.
    // Deleting the cached entry makes the next `findSession` for this token
    // fall through to D1, which returns the now-"admin" row — otherwise the
    // bootstrap admin's session would report role "user" until it re-logs
    // in or the cache entry naturally expires.
    if (result.token) {
      await c.env.KV.delete(result.token);
    }

    await completeInstallation(db, {
      userId: result.user.id,
      email: result.user.email,
    });

    await recordAuditEvent(db, {
      event: "setup.completed",
      actorUserId: result.user.id,
      actorIp: c.req.header("cf-connecting-ip") ?? null,
      target: result.user.email,
    });

    return c.json(
      {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
          image: result.user.image ?? null,
          emailVerified: result.user.emailVerified,
          role: "admin" as const,
          createdAt: result.user.createdAt,
        },
      },
      201,
    );
  } catch (error) {
    await releaseInstallation(db);
    throw error;
  }
});
