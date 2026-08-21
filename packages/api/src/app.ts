import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health/live", (c) => c.json({ status: "ok" }));

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
