import type { MiddlewareHandler } from "hono";
import type { SessionFetcher } from "../../auth/types";
import type { AppEnv, SessionUser } from "../types";

type RawSession = NonNullable<
  Awaited<ReturnType<SessionFetcher["api"]["getSession"]>>
>;

function toSessionUser(user: RawSession["user"]): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: typeof user.image === "string" ? user.image : null,
    emailVerified: user.emailVerified,
    role: typeof user.role === "string" ? user.role : "user",
    createdAt:
      user.createdAt instanceof Date
        ? user.createdAt
        : new Date(
            typeof user.createdAt === "string" ||
              typeof user.createdAt === "number"
              ? user.createdAt
              : Date.now(),
          ),
  };
}

/**
 * Loads the current session (if any) via the (Task 5) `auth` singleton,
 * passed in lazily so this module has no compile-time dependency on it.
 * Sets `user`/`session` context vars; never throws — a session lookup
 * failure is treated as "no session" so the rest of the request can proceed
 * (public routes must still work when the session store is briefly down).
 */
export function loadSession(
  authRef: () => SessionFetcher,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      const result = await authRef().api.getSession({
        headers: c.req.raw.headers,
      });
      if (!result) {
        c.set("user", null);
        c.set("session", null);
      } else {
        c.set("user", toSessionUser(result.user));
        c.set("session", result.session);
      }
    } catch {
      c.set("user", null);
      c.set("session", null);
    }
    await next();
  };
}
