import { env } from "cloudflare:workers";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { createAuth } from "../auth/auth";
import { accountRoutes } from "../routes/account";
import { emailVerificationRoutes } from "../routes/email-verification";
import { healthRoutes } from "../routes/health";
import { passwordRoutes } from "../routes/password";
import { sessionRoutes } from "../routes/session";
import { setupRoutes } from "../routes/setup";
import { API_VERSION } from "../version";
import { newRouter } from "./app-shared";
import { validateEnv } from "./env";
import { errorBody, handleApiError } from "./errors";
import { logEvent, logFailedApiRequests } from "./log";
import { loadSession } from "./middleware/session";
import { corsOriginFor, rejectCrossSiteMutations } from "./security/origin";

// Module-level singleton: one Better-Auth instance per isolate, built from
// the live Worker environment (`cloudflare:workers`'s `env`, not a per-request
// binding) so it is created once and reused across requests within the
// isolate.
export const auth = createAuth(env);

const app = newRouter();

function strictContentSecurityPolicy() {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
  };
}

// Registered BEFORE the global strict `secureHeaders` below on purpose: Hono
// middleware unwinds in REVERSE registration order after `next()`, and
// `secureHeaders` sets each header with `.set()` (last write wins) in that
// unwind phase. Registering the relaxed, /api/docs-scoped instance first
// makes it the outermost layer, so its `.set()` calls run LAST on
// /api/docs requests and win over the global strict policy; every other
// path never matches this middleware at all, so the strict policy applies
// there unopposed.
app.use(
  "/api/docs",
  secureHeaders({
    contentSecurityPolicy: {
      ...strictContentSecurityPolicy(),
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  }),
);
app.use(
  "*",
  secureHeaders({ contentSecurityPolicy: strictContentSecurityPolicy() }),
);

app.use(
  "/api/*",
  cors({
    origin: (origin, c) => corsOriginFor(c.env, origin) || undefined,
    credentials: true,
  }),
);

app.use("/api/*", rejectCrossSiteMutations);

// A misconfigured environment must never reach `loadSession` (which would
// otherwise try to build a broken Better-Auth call chain per request) or any
// route handler. `/api/health/live` is exempt so liveness checks work even
// while the Worker is misconfigured.
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health/live") {
    return next();
  }
  const result = validateEnv(c.env);
  if (!result.ok) {
    logEvent("error", "misconfigured", { problems: result.problems });
    return c.json(errorBody("misconfigured", "Service is misconfigured"), 503);
  }
  return next();
});

app.use("/api/*", logFailedApiRequests);

app.use(
  "/api/*",
  loadSession(() => auth),
);

// `.route()` chain ONLY here — this is what `AppType` (the `hc` typed
// client's generic) is built from. Later tasks append `.route()` lines;
// nothing after this block should be chained into `routes`.
const routes = app
  .route("/api/health", healthRoutes)
  .route("/api/setup", setupRoutes)
  .route("/api/session", sessionRoutes)
  .route("/api/auth/password", passwordRoutes)
  .route("/api/auth/email", emailVerificationRoutes)
  .route("/api/account", accountRoutes);
export type AppType = typeof routes;

// Better-Auth's own HTTP handler is mounted for an ALLOWLIST of exact paths
// only — everything else under /api/auth/* falls through to the /api/*
// 404 envelope below. Growing this list is a conscious diff (see
// allowlist.test.ts).
export const BETTER_AUTH_ALLOWLIST = ["/api/auth/jwks"] as const;

app.on(["GET", "POST"], "/api/auth/*", (c, next) => {
  if ((BETTER_AUTH_ALLOWLIST as readonly string[]).includes(c.req.path)) {
    return auth.handler(c.req.raw);
  }
  return next();
});

app.get("/.well-known/jwks.json", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/api/auth/jwks";
  return auth.handler(new Request(url, c.req.raw));
});

app.doc31("/api/openapi.json", {
  openapi: "3.1.0",
  info: { title: "flare-idp", version: API_VERSION },
});

// `@scalar/hono-api-reference`'s `Scalar()` helper injects the browser
// bundle as a plain `<script src="...">` (no `type="module"`) — see its
// `getScriptTags` helper (`@scalar/client-side-rendering`). The vendored
// bundle (`standalone.esm.js`) is an ES module and errors as a classic
// script, so this hand-renders the docs page instead. The bootstrap that
// calls `createApiReference` lives in its own vendored, same-origin file
// (`/vendor/scalar/bootstrap.js`, written by `apps/idp/scripts/vendor-scalar.ts`)
// referenced via an external `<script src>` — NOT inlined here — because our
// strict `script-src 'self'` CSP (relaxed only for `style-src` on this
// route) blocks inline script bodies outright.
app.get("/api/docs", (c) =>
  c.html(
    `<!doctype html><html><head><title>flare-idp API</title><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/></head><body><div id="app"></div><script type="module" src="/vendor/scalar/bootstrap.js"></script></body></html>`,
  ),
);

app.all("/api/*", (c) => c.json(errorBody("not_found", "Not found"), 404));

app.get("*", async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(response.body, response);
});

app.onError(handleApiError);

export { app };
