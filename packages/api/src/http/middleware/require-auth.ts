import type { MiddlewareHandler } from "hono";
import { errorBody } from "../errors";
import type { AppEnv } from "../types";

/** Requires `loadSession` to have run first. 401s with our envelope when unauthenticated. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json(errorBody("unauthorized", "Authentication required"), 401);
  }
  await next();
};
