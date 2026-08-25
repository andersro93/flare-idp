import { errorBodySchema } from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { newRouter } from "../http/app-shared";
import { errorBody } from "../http/errors";

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

// The `.openapi()` calls MUST be chained directly off `newRouter()` and the
// result captured (not called as bare statements on a `const` bound
// earlier) — `OpenAPIHono#openapi()` returns a NEW, more-refined-Schema
// type; calling it without capturing the return leaves the ORIGINAL
// binding's static type unchanged (still `Schema = {}`). That's harmless
// at runtime (the route is still registered — `.openapi()` mutates in
// place too) but silently erases this route file's contribution to
// `AppType`, which is what `hc<AppType>` types itself from — every path
// registered this way resolves to `unknown` for typed client callers. See
// `apps/idp/test/unit/hc-client.test.ts`.
export const healthRoutes = newRouter()
  .openapi(live, (c) => c.json({ status: "ok" as const }, 200))
  .openapi(ready, async (c) => {
    try {
      await c.env.DB.prepare("SELECT 1").first();
      await c.env.KV.get("__health_probe__");
      return c.json({ status: "ok" as const }, 200);
    } catch {
      return c.json(
        errorBody("misconfigured", "A dependency check failed"),
        503,
      );
    }
  });
