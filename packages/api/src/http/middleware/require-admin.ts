import type { MiddlewareHandler } from "hono";
import { errorBody } from "../errors";
import type { AppEnv } from "../types";

/**
 * Requires `loadSession` to have run first. 401s (unauthenticated) or 403s
 * (authenticated but not an admin) with our envelope.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json(errorBody("unauthorized", "Authentication required"), 401);
  }
  if (user.role !== "admin") {
    return c.json(errorBody("forbidden", "Admin role required"), 403);
  }
  await next();
};
