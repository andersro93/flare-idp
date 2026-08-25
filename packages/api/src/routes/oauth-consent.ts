import {
  consentInfoSchema,
  consentPostSchema,
  errorBodySchema,
  OAUTH_SCOPES,
  type OAuthScope,
  SCOPE_DESCRIPTIONS,
} from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { APIError } from "better-auth";
import { mapAuthError } from "../auth/forward";
import { auth } from "../http/app";
import { newRouter } from "../http/app-shared";
import { AppError } from "../http/errors";
import { requireAuth } from "../http/middleware/require-auth";

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: errorBodySchema } },
  } as const;
}

const infoQuerySchema = z.object({
  client_id: z.string().min(1),
  // Space-separated scope string, exactly as it appears in the oauth query
  // the consent page receives (e.g. "openid profile"). Optional: with no
  // scope the response's `scopes` array is empty.
  scope: z.string().optional(),
});

const decisionResponseSchema = z.object({
  redirectTo: z.string(),
});

const infoRoute = createRoute({
  method: "get",
  path: "/",
  request: { query: infoQuerySchema },
  responses: {
    200: {
      description:
        "Public client info plus human-readable descriptions of the requested scopes (unknown scopes are silently filtered out).",
      content: { "application/json": { schema: consentInfoSchema } },
    },
    400: errorResponse("Missing or invalid query parameters."),
    401: errorResponse("Authentication required."),
    404: errorResponse("No such client."),
  },
});

const decisionRoute = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: { "application/json": { schema: consentPostSchema } },
    },
  },
  responses: {
    200: {
      description:
        "The consent decision was recorded. `redirectTo` is where the browser must go next: the client's redirect URI with an authorization code (accept) or with `error=access_denied` (deny).",
      content: { "application/json": { schema: decisionResponseSchema } },
    },
    400: errorResponse(
      "The request body failed validation, or `oauthQuery` was missing, expired, or had an invalid signature.",
    ),
    401: errorResponse("Authentication required."),
  },
});

// `.openapi()` calls MUST be chained directly off `newRouter()`'s result and
// the return captured (see account.ts for the full explanation of why); the
// `.use()` call below is a bare statement for the same reason.
const oauthConsentRoutesBase = newRouter();
oauthConsentRoutesBase.use("*", requireAuth);

export const oauthConsentRoutes = oauthConsentRoutesBase
  .openapi(infoRoute, async (c) => {
    const { client_id, scope } = c.req.valid("query");

    // `getOAuthClientPublic` (GET /oauth2/public-client, query
    // `{ client_id }`, sessionMiddleware) returns ONLY the public subset of
    // client fields (`client_id`, `client_name`, `client_uri`, `logo_uri`,
    // `contacts`, `tos_uri`, `policy_uri`) — no ownership check, no secret
    // (verified against @better-auth/oauth-provider's
    // getClientPublicEndpoint). Unknown or disabled client → NOT_FOUND.
    let client: Awaited<ReturnType<typeof auth.api.getOAuthClientPublic>>;
    try {
      client = await auth.api.getOAuthClientPublic({
        query: { client_id },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      // The plugin's NOT_FOUND carries only RFC-style `error_description`
      // (no `message`), which `mapAuthError` can't surface — substitute a
      // clean envelope message of our own.
      if (error instanceof APIError && error.status === "NOT_FOUND") {
        throw new AppError(404, "not_found", "No such client");
      }
      throw mapAuthError(error);
    }

    const requested = scope?.split(/\s+/).filter(Boolean) ?? [];
    const scopes = requested
      .filter((s): s is OAuthScope =>
        (OAUTH_SCOPES as readonly string[]).includes(s),
      )
      .map((id) => ({ id, description: SCOPE_DESCRIPTIONS[id] }));

    const dto: z.infer<typeof consentInfoSchema> = {
      client: { clientId: client.client_id },
      scopes,
    };
    if (client.client_name) dto.client.name = client.client_name;
    if (client.logo_uri) dto.client.logoUri = client.logo_uri;
    return c.json(dto, 200);
  })
  .openapi(decisionRoute, async (c) => {
    const body = c.req.valid("json");

    // The plugin's consent endpoint cannot be called as a plain
    // `auth.api.oauth2Consent()` server call: the `oauth_query` in the body
    // is picked up by a plugin-level BEFORE hook (signature check via
    // `verifyOAuthQueryParams`, then request-scoped `oAuthState.set`), which
    // only runs for a real Request travelling through `auth.handler` — so we
    // proxy one (spike S4 / plan Core contracts). `accept:
    // application/json` makes both the deny short-circuit and the
    // re-invoked authorize respond with `{ redirect: true, url }` JSON
    // instead of a 302.
    // NOTE: `oauth_query` is a signed bearer artifact (HMAC sig + exp; not
    // session-bound; resubmittable within its expiry) — plugin-inherent and
    // accepted; cross-site misuse is blocked by our CSRF origin guard.
    const target = new URL(c.req.url);
    target.pathname = "/api/auth/oauth2/consent";
    target.search = "";
    const proxied = new Request(target, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/json",
        accept: "application/json",
        cookie: c.req.raw.headers.get("cookie") ?? "",
        origin: new URL(c.req.url).origin,
      }),
      body: JSON.stringify({
        accept: body.accept,
        scope: body.scope?.join(" "),
        oauth_query: body.oauthQuery,
      }),
    });

    const res = await auth.handler(proxied);
    for (const cookie of res.headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    if (!res.ok) {
      // Missing/expired/garbled oauth_query, scope not originally
      // requested, etc. — all caller mistakes. Surface the upstream
      // description when present, parsing defensively (the body may be
      // RFC-shaped `{ error, error_description }`, envelope-less
      // `{ message }`, or not JSON at all).
      let message = "Consent request was rejected";
      try {
        const parsed = (await res.json()) as Record<string, unknown>;
        const detail =
          parsed.error_description ?? parsed.message ?? parsed.error;
        if (typeof detail === "string" && detail.length > 0) message = detail;
      } catch {
        // keep the generic message
      }
      throw new AppError(400, "invalid_request", message);
    }

    let payload: { redirect?: boolean; url?: string };
    try {
      payload = (await res.json()) as { redirect?: boolean; url?: string };
    } catch {
      payload = {};
    }
    if (typeof payload.url !== "string" || payload.url.length === 0) {
      // A 2xx without a redirect URL would mean an upstream contract change,
      // not a caller mistake.
      throw new AppError(500, "internal", "Unexpected consent response");
    }
    return c.json({ redirectTo: payload.url }, 200);
  });
