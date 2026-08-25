import { dbFor, recordAuditEvent, schema } from "@flare-idp/db";
import {
  errorBodySchema,
  profilePatchSchema,
  ROLES,
  sessionInfoSchema,
  sessionUserSchema,
} from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { callAuth, mapAuthError } from "../auth/forward";
import { auth } from "../http/app";
import { newRouter } from "../http/app-shared";
import { AppError } from "../http/errors";
import { requireAuth } from "../http/middleware/require-auth";
import { clientAddress } from "../http/security/rate-limit";

export const accountRoutes = newRouter();

// Every route under /api/account requires an authenticated session.
accountRoutes.use("*", requireAuth);

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: errorBodySchema } },
  } as const;
}

type SessionUserPayload = z.infer<typeof sessionUserSchema>;

/** Narrows a free-form role string to the closed `ROLES` union, defaulting to "user". */
function toRole(role: unknown): SessionUserPayload["role"] {
  return typeof role === "string" && (ROLES as readonly string[]).includes(role)
    ? (role as SessionUserPayload["role"])
    : "user";
}

function toSessionUserPayload(user: {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  emailVerified: boolean;
  role?: unknown;
  createdAt: Date | string | number;
}): SessionUserPayload {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: typeof user.image === "string" ? user.image : null,
    emailVerified: user.emailVerified,
    role: toRole(user.role),
    createdAt:
      user.createdAt instanceof Date
        ? user.createdAt
        : new Date(user.createdAt),
  };
}

const profileResponseSchema = z.object({ user: sessionUserSchema });

const profileGetRoute = createRoute({
  method: "get",
  path: "/profile",
  responses: {
    200: {
      description: "The current user's profile.",
      content: { "application/json": { schema: profileResponseSchema } },
    },
    401: errorResponse("Authentication required."),
  },
});

accountRoutes.openapi(profileGetRoute, (c) => {
  const user = c.get("user");
  if (!user) {
    // requireAuth already guards this path; narrows for the type checker.
    throw new AppError(401, "unauthorized", "Authentication required");
  }
  return c.json({ user: toSessionUserPayload(user) }, 200);
});

const profilePatchRoute = createRoute({
  method: "patch",
  path: "/profile",
  request: {
    body: {
      content: { "application/json": { schema: profilePatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Profile updated.",
      content: { "application/json": { schema: profileResponseSchema } },
    },
    400: errorResponse("The request body failed validation, or was empty."),
    401: errorResponse("Authentication required."),
  },
});

accountRoutes.openapi(profilePatchRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");
  if (!user) {
    throw new AppError(401, "unauthorized", "Authentication required");
  }
  const db = dbFor(c.env.DB);
  const ip = clientAddress(c.req.raw.headers);

  await callAuth(c, () =>
    auth.api.updateUser({
      body: { name: body.name, image: body.image },
      headers: c.req.raw.headers,
      returnHeaders: true,
    }),
  );

  // `updateUser`'s own response is just `{ status: true }` (no user
  // payload) — re-fetch the session for truthfulness: it reflects whatever
  // the DB now holds rather than a locally-reconstructed guess. The
  // request's own (unchanged) cookie still resolves to the same session
  // row, whose user fields the update above just changed.
  const fresh = await auth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: true },
  });
  const updatedUser = fresh?.user ?? { ...user, ...body };

  // Never log the new values themselves — only which fields changed.
  await recordAuditEvent(db, {
    event: "account.profile_updated",
    actorUserId: user.id,
    actorIp: ip,
    details: JSON.stringify({ fields: Object.keys(body) }),
  });

  return c.json({ user: toSessionUserPayload(updatedUser) }, 200);
});

const sessionsListResponseSchema = z.object({
  sessions: z.array(sessionInfoSchema),
});

const sessionsListRoute = createRoute({
  method: "get",
  path: "/sessions",
  responses: {
    200: {
      description: "The current user's active sessions.",
      content: { "application/json": { schema: sessionsListResponseSchema } },
    },
    401: errorResponse("Authentication required."),
  },
});

accountRoutes.openapi(sessionsListRoute, async (c) => {
  const currentSessionId = c.get("session")?.id;

  let rows: Awaited<ReturnType<typeof auth.api.listSessions>>;
  try {
    rows = await auth.api.listSessions({ headers: c.req.raw.headers });
  } catch (error) {
    throw mapAuthError(error);
  }

  // Built field-by-field — NEVER spread the raw row, which carries `token`.
  const sessions = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    userAgent: row.userAgent ?? null,
    ipAddress: row.ipAddress ?? null,
    current: row.id === currentSessionId,
  }));

  return c.json({ sessions }, 200);
});

const sessionRevokeRoute = createRoute({
  method: "delete",
  path: "/sessions/{id}",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: { description: "Session revoked." },
    401: errorResponse("Authentication required."),
    404: errorResponse("No such session for the current user."),
  },
});

accountRoutes.openapi(sessionRevokeRoute, async (c) => {
  const { id } = c.req.valid("param");
  const user = c.get("user");
  if (!user) {
    throw new AppError(401, "unauthorized", "Authentication required");
  }
  const db = dbFor(c.env.DB);
  const ip = clientAddress(c.req.raw.headers);

  const [row] = await db
    .select()
    .from(schema.session)
    .where(eq(schema.session.id, id))
    .limit(1);

  // Same 404 for "no such session" and "belongs to someone else" — no
  // ownership oracle for a caller probing session ids.
  if (!row || row.userId !== user.id) {
    throw new AppError(404, "not_found", "Session not found");
  }

  await callAuth(c, () =>
    auth.api.revokeSession({
      body: { token: row.token },
      headers: c.req.raw.headers,
      returnHeaders: true,
    }),
  );

  // Session id only — never the token.
  await recordAuditEvent(db, {
    event: "account.session_revoked",
    actorUserId: user.id,
    actorIp: ip,
    details: JSON.stringify({ sessionId: row.id }),
  });

  return c.body(null, 204);
});
