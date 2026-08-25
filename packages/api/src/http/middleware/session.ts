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
 *
 * `disableCookieCache: true` — this is the authoritative session check every
 * `/api/*` request relies on for authz (`requireAuth`/`requireAdmin`) and for
 * `GET /api/session`. The `auth` singleton's `session` config has no
 * `cookieCache` block (see `auth/auth.ts`), so this flag is currently
 * belt-and-suspenders: it's kept as defense-in-depth so a FUTURE change that
 * re-enables `cookieCache` on the config can't silently reintroduce a
 * ≤`maxAge`-second stale-revocation window here — Better-Auth's cookie cache,
 * when enabled, answers straight from a signed client-side blob without
 * touching the DB or KV at all, so a revoked session (sign-out-all, admin
 * ban, password reset) would read as valid until that blob expired. The KV
 * secondary storage (`kvSecondaryStorage`) is the intended read cache
 * instead (Global Constraints: "KV = session read cache only") — it's
 * consulted by Better-Auth's internal adapter and stays correctly
 * invalidated on revoke.
 */
export function loadSession(
  authRef: () => SessionFetcher,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      const result = await authRef().api.getSession({
        headers: c.req.raw.headers,
        query: { disableCookieCache: true },
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
