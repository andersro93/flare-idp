import { OpenAPIHono } from "@hono/zod-openapi";
import { errorBody } from "./errors";
import type { AppEnv } from "./types";

export type { AppEnv, AppVariables, SessionRecord, SessionUser } from "./types";

/**
 * Every route file (`src/routes/*.ts`) builds its own `OpenAPIHono` via this
 * factory rather than chaining `.use().openapi()` on a shared instance (that
 * chain hits a typing bug upstream). Every instance shares the same
 * `defaultHook`: a zod validation failure becomes our `invalid_request`
 * envelope, first-issue message included so the response says what was
 * wrong.
 */
export function newRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const message = issue
          ? issue.path.length
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message
          : "Invalid request";
        return c.json(errorBody("invalid_request", message), 400);
      }
    },
  });
}
