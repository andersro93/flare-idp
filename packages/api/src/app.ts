import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { createAuth } from "./auth";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health/live", (c) => c.json({ status: "ok" }));

// Module-level singleton: one init per isolate. Spike S2 measures its cost.
export const auth = createAuth(env as Env);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Unknown API paths must never fall through to the SPA/asset handler.
app.all("/api/*", (c) =>
  c.json({ error: { code: "not_found", message: "Not found" } }, 404),
);

app.get("*", async (c) => {
  // Responses from a binding fetch() carry immutable headers; re-wrap so
  // middleware added in Phase 1 can decorate SPA responses.
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, response);
});
