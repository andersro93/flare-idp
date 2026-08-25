import { errorBodySchema } from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { newRouter } from "../http/app-shared";
import { errorBody } from "../http/errors";

export const healthRoutes = newRouter();

const okSchema = z.object({ status: z.literal("ok") });

const live = createRoute({
  method: "get",
  path: "/live",
  responses: {
    200: {
      description: "The Worker is running.",
      content: { "application/json": { schema: okSchema } },
    },
  },
});
healthRoutes.openapi(live, (c) => c.json({ status: "ok" as const }, 200));

const ready = createRoute({
  method: "get",
  path: "/ready",
  responses: {
    200: {
      description: "Every dependency the Worker needs answered.",
      content: { "application/json": { schema: okSchema } },
    },
    503: {
      description: "A dependency check failed.",
      content: { "application/json": { schema: errorBodySchema } },
    },
  },
});
healthRoutes.openapi(ready, async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    await c.env.KV.get("__health_probe__");
    return c.json({ status: "ok" as const }, 200);
  } catch {
    return c.json(errorBody("misconfigured", "A dependency check failed"), 503);
  }
});
