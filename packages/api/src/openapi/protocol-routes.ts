import { errorBodySchema } from "@flare-idp/shared";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";

/**
 * Hand-written OpenAPI 3.1 documentation for the OIDC/OAuth 2.1 PROTOCOL
 * endpoints. These are served by the identity core (the Better-Auth
 * `oauth-provider` plugin, mounted behind the method-aware allowlist in
 * `http/app.ts`), NOT by our facade — they are not `.openapi()` routes and
 * are deliberately absent from `AppType`. Their error responses use the RFC
 * 6749 shape (`error` / `error_description`), never the facade's error
 * envelope. Registration happens through `OpenAPIHono`'s zod-to-openapi
 * registry (`app.openAPIRegistry.registerPath`), whose `RouteConfig` accepts
 * raw OpenAPI `SchemaObject`s alongside zod schemas — `doc31` reads the
 * registry at request time, so these merge into `/api/openapi.json`
 * untouched.
 *
 * Everything documented here mirrors OBSERVED behavior pinned by
 * `apps/idp/test/integration/oidc-flow.test.ts` (see the Task 5 ledger
 * entries): authorize delivers most protocol errors as 302 redirects back to
 * the `redirect_uri`; token errors are RFC JSON; the token endpoint's rate
 * limit answers 429 with an RFC-shaped body and `Retry-After`.
 */

type Registry = OpenAPIHono["openAPIRegistry"];

// `@hono/zod-openapi` re-exports `RouteConfig` but not the building-block
// schema types from `@asteasolutions/zod-to-openapi` / `openapi3-ts`
// (transitive dependencies this package intentionally does not declare),
// and `openapi3-ts` ships THREE versioned `SchemaObject` variants that make
// extracted unions unassignable across positions. These minimal structural
// types cover exactly what this file uses and are assignable to every
// variant.
type RawSchema = {
  type?: "object" | "string" | "integer" | "boolean" | "array";
  enum?: string[];
  description?: string;
  required?: string[];
  properties?: Record<string, RawSchema>;
  items?: RawSchema;
  additionalProperties?: boolean;
};
type RawParameter = {
  name: string;
  in: "query";
  required: boolean;
  description: string;
  schema: RawSchema;
};
type ResponseConfig = Exclude<
  RouteConfig["responses"][string],
  { $ref: string }
>;

const TAG = "oidc-protocol";

const SERVED_BY_CORE =
  "Served by the identity core (Better-Auth oauth-provider plugin), not the facade. " +
  "Errors use the RFC 6749 shape (`error`, `error_description`) — never the facade's error envelope.";

/** RFC 6749 §5.2 error body — the ONLY error shape these endpoints emit. */
const rfcErrorSchema: RawSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "string",
      description:
        "RFC 6749 error code, e.g. invalid_request, invalid_client, invalid_grant, unauthorized_client, invalid_scope, temporarily_unavailable.",
    },
    error_description: { type: "string" },
    error_uri: { type: "string" },
  },
};

function rfcError(description: string): ResponseConfig {
  return {
    description,
    content: { "application/json": { schema: rfcErrorSchema } },
  };
}

const tokenResponseSchema: RawSchema = {
  type: "object",
  required: ["access_token", "token_type"],
  properties: {
    access_token: { type: "string" },
    token_type: { type: "string", description: 'Lowercase "bearer".' },
    expires_in: { type: "integer", description: "Access-token TTL, seconds." },
    refresh_token: {
      type: "string",
      description:
        "Present only when the offline_access scope was granted. Rotates on every refresh grant; reusing a rotated-out token invalidates the family (400 invalid_grant).",
    },
    id_token: {
      type: "string",
      description:
        "JWT, present for openid-scoped user grants (never for client_credentials). Verify against /.well-known/jwks.json; iss is the bare origin.",
    },
    scope: { type: "string", description: "Space-separated granted scopes." },
  },
};

function queryParam(
  name: string,
  required: boolean,
  description: string,
  schema: RawSchema = { type: "string" },
): RawParameter {
  return { name, in: "query", required, description, schema };
}

/** Authorize inputs, shared verbatim between the GET query and POST form. */
const authorizeFields: ReadonlyArray<{
  name: string;
  required: boolean;
  description: string;
  schema?: RawSchema;
}> = [
  {
    name: "response_type",
    required: true,
    description: "Only the authorization-code flow is supported.",
    schema: { type: "string", enum: ["code"] },
  },
  { name: "client_id", required: true, description: "OAuth client id." },
  {
    name: "redirect_uri",
    required: true,
    description: "Must exactly match a registered redirect URI.",
  },
  {
    name: "scope",
    required: false,
    description:
      "Space-separated subset of the client's registered scopes (openid, profile, email, offline_access). offline_access is required for a refresh_token to be issued.",
  },
  {
    name: "state",
    required: false,
    description: "Opaque RP value, echoed on every redirect back.",
  },
  {
    name: "nonce",
    required: false,
    description: "Echoed as the id_token `nonce` claim.",
  },
  {
    name: "code_challenge",
    required: true,
    description:
      "PKCE challenge — mandatory (OAuth 2.1). Omitting it produces an error redirect (error=invalid_request).",
  },
  {
    name: "code_challenge_method",
    required: true,
    description: "S256 only.",
    schema: { type: "string", enum: ["S256"] },
  },
  {
    name: "prompt",
    required: false,
    description: "OIDC prompt hint (e.g. consent, login, none).",
  },
];

const authorizeResponses: RouteConfig["responses"] = {
  302: {
    description:
      "Every browser-navigation outcome is a redirect: no session → the login page (/sign-in); consent required → the consent page (/oauth/consent?...); success, including trusted skip_consent clients → redirect_uri with `code` and `state`; and MOST protocol errors also arrive as a redirect to redirect_uri with `error`, `error_description` and `state` query parameters (observed: missing PKCE → error=invalid_request). Note: fetch-style requests (accept: application/json) receive 200 `{ redirect: true, url }` JSON instead of the 302.",
    headers: {
      Location: {
        description: "Redirect target (see the outcome list above).",
        schema: { type: "string" },
      },
    },
  },
  400: rfcError(
    "The request could not be safely redirected — e.g. unknown client_id or an unregistered redirect_uri (RFC 6749 forbids redirecting those).",
  ),
};

const authorizeDescriptionSuffix = ` ${SERVED_BY_CORE} Protocol errors are usually DELIVERED VIA THE 302 (error params on the redirect_uri), not as an error status.`;

const routes: RouteConfig[] = [
  {
    method: "get",
    path: "/.well-known/openid-configuration",
    tags: [TAG],
    summary: "OIDC discovery document",
    description: `OpenID Connect discovery metadata. The issuer is the bare origin (APP_URL); the protocol endpoints it advertises live under /api/auth/oauth2/*. scopes_supported lists only user-delegated scopes (machine scopes are not advertised). ${SERVED_BY_CORE}`,
    responses: {
      200: {
        description: "Discovery metadata (RFC 8414 / OIDC Discovery 1.0).",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["issuer"],
              properties: {
                issuer: {
                  type: "string",
                  description: "Bare origin — no /api/auth suffix.",
                },
                authorization_endpoint: { type: "string" },
                token_endpoint: { type: "string" },
                userinfo_endpoint: { type: "string" },
                jwks_uri: { type: "string" },
                scopes_supported: {
                  type: "array",
                  items: { type: "string" },
                },
                response_types_supported: {
                  type: "array",
                  items: { type: "string" },
                },
                grant_types_supported: {
                  type: "array",
                  items: { type: "string" },
                },
                code_challenge_methods_supported: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              additionalProperties: true,
            },
          },
        },
      },
    },
  },
  {
    method: "get",
    path: "/.well-known/jwks.json",
    tags: [TAG],
    summary: "JSON Web Key Set",
    description: `Public signing keys for id_token / JWT verification (rewrites internally to /api/auth/jwks). ${SERVED_BY_CORE}`,
    responses: {
      200: {
        description: "JWK Set (RFC 7517).",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["keys"],
              properties: {
                keys: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["kty"],
                    properties: {
                      kty: { type: "string" },
                      kid: { type: "string" },
                      alg: { type: "string" },
                      use: { type: "string" },
                    },
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    method: "get",
    path: "/api/auth/oauth2/authorize",
    tags: [TAG],
    summary: "Authorization endpoint (browser navigation)",
    description: `Starts the authorization-code + PKCE flow; RPs send the user's browser here with a GET.${authorizeDescriptionSuffix}`,
    parameters: authorizeFields.map((f) =>
      queryParam(f.name, f.required, f.description, f.schema),
    ),
    responses: authorizeResponses,
  },
  {
    method: "post",
    path: "/api/auth/oauth2/authorize",
    tags: [TAG],
    summary: "Authorization endpoint (form POST variant)",
    description: `Same contract as the GET variant with the parameters form-encoded in the body. Unlike token/introspect/revoke this endpoint is NOT exempt from the cross-site origin guard — browsers must send it same-origin; RPs should use GET.${authorizeDescriptionSuffix}`,
    request: {
      body: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: authorizeFields
                .filter((f) => f.required)
                .map((f) => f.name),
              properties: Object.fromEntries(
                authorizeFields.map((f) => [
                  f.name,
                  {
                    ...(f.schema ?? { type: "string" }),
                    description: f.description,
                  },
                ]),
              ),
            },
          },
        },
      },
    },
    responses: {
      ...authorizeResponses,
      403: {
        description:
          "Cross-site browser POST rejected by the origin guard. This one response comes from the Worker's guard in FRONT of the core, so it uses the facade's error envelope, not the RFC shape.",
        content: { "application/json": { schema: errorBodySchema } },
      },
    },
  },
  {
    method: "post",
    path: "/api/auth/oauth2/token",
    tags: [TAG],
    summary: "Token endpoint",
    description: `Exchanges an authorization code (with PKCE code_verifier), refresh token, or client credentials for tokens. Confidential clients authenticate with HTTP Basic (client_secret_basic) or client_secret/client_id in the body (client_secret_post); public clients send client_id only. Exempt from the cross-site origin guard (server-to-server). Rate limited per IP (30/min) in front of the core. ${SERVED_BY_CORE}`,
    security: [{ oauthClientBasic: [] }, {}],
    request: {
      body: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["grant_type"],
              properties: {
                grant_type: {
                  type: "string",
                  enum: [
                    "authorization_code",
                    "refresh_token",
                    "client_credentials",
                  ],
                },
                code: {
                  type: "string",
                  description:
                    "authorization_code grant: the code from the authorize redirect. Single-use — replay → 400 invalid_grant.",
                },
                redirect_uri: {
                  type: "string",
                  description:
                    "authorization_code grant: must match the authorize request.",
                },
                code_verifier: {
                  type: "string",
                  description: "authorization_code grant: PKCE verifier.",
                },
                refresh_token: {
                  type: "string",
                  description:
                    "refresh_token grant. Rotated on every use; reuse of a rotated-out token → 400 invalid_grant.",
                },
                scope: {
                  type: "string",
                  description:
                    "client_credentials grant: requested machine scopes (must be within the client's configured clientCredentialsScopes).",
                },
                client_id: {
                  type: "string",
                  description:
                    "Required when not using Basic auth (public clients / client_secret_post).",
                },
                client_secret: {
                  type: "string",
                  description: "client_secret_post authentication.",
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Tokens issued. client_credentials grants carry no id_token or refresh_token.",
        content: { "application/json": { schema: tokenResponseSchema } },
      },
      400: rfcError(
        "invalid_grant (code replay, rotated refresh-token reuse, bad PKCE verifier), invalid_request, invalid_scope, or unauthorized_client (e.g. client_credentials without configured machine scopes).",
      ),
      401: rfcError("invalid_client — client authentication failed."),
      429: {
        description:
          "Per-IP rate limit exceeded (30/min). RFC-shaped body — `error: temporarily_unavailable` — because RP libraries parse `error`, not the facade envelope.",
        headers: {
          "Retry-After": {
            description: "Seconds until the window resets.",
            schema: { type: "string" },
          },
        },
        content: { "application/json": { schema: rfcErrorSchema } },
      },
    },
  },
  ...(["get", "post"] as const).map(
    (method): RouteConfig => ({
      method,
      path: "/api/auth/oauth2/userinfo",
      tags: [TAG],
      summary: `UserInfo endpoint${method === "post" ? " (POST variant)" : ""}`,
      description: `Returns claims about the user the access token was issued for, per granted scope, plus the custom \`role\` claim. ${SERVED_BY_CORE}`,
      security: [{ oauthBearer: [] }],
      responses: {
        200: {
          description: "Claims for the token's user and scopes.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sub"],
                properties: {
                  sub: { type: "string" },
                  role: {
                    type: "string",
                    description: "Custom claim (user | admin).",
                  },
                  name: { type: "string" },
                  email: { type: "string" },
                  email_verified: { type: "boolean" },
                  picture: { type: "string" },
                },
                additionalProperties: true,
              },
            },
          },
        },
        400: rfcError(
          "invalid_scope — observed for client_credentials (machine) access tokens, which carry no user-delegated scopes.",
        ),
        401: rfcError("Missing, expired, or invalid bearer token."),
      },
    }),
  ),
  {
    method: "post",
    path: "/api/auth/oauth2/introspect",
    tags: [TAG],
    summary: "Token introspection (RFC 7662)",
    description: `Client-authenticated token metadata lookup. Unknown, expired, or revoked tokens answer 200 with \`active: false\` — not an error. Exempt from the cross-site origin guard (server-to-server). ${SERVED_BY_CORE}`,
    security: [{ oauthClientBasic: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["token"],
              properties: {
                token: { type: "string" },
                token_type_hint: {
                  type: "string",
                  enum: ["access_token", "refresh_token"],
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: "Introspection result.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["active"],
              properties: {
                active: { type: "boolean" },
                scope: { type: "string" },
                client_id: { type: "string" },
                sub: { type: "string" },
                exp: { type: "integer" },
                iat: { type: "integer" },
                token_type: { type: "string" },
              },
              additionalProperties: true,
            },
          },
        },
      },
      401: rfcError("invalid_client — client authentication failed."),
    },
  },
  {
    method: "post",
    path: "/api/auth/oauth2/revoke",
    tags: [TAG],
    summary: "Token revocation (RFC 7009)",
    description: `Revokes an access or refresh token issued to the authenticated client. Per RFC 7009 an already-invalid token still answers 200. Exempt from the cross-site origin guard (server-to-server). ${SERVED_BY_CORE}`,
    security: [{ oauthClientBasic: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["token"],
              properties: {
                token: { type: "string" },
                token_type_hint: {
                  type: "string",
                  enum: ["access_token", "refresh_token"],
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: "Token revoked (or was already invalid)." },
      401: rfcError("invalid_client — client authentication failed."),
    },
  },
];

/**
 * Registers the protocol path items (and the client-auth / bearer security
 * schemes they reference) into the given OpenAPI registry. Called once from
 * `http/app.ts` — before `doc31`'s handler ever generates the document.
 */
export function registerOidcProtocolRoutes(registry: Registry): void {
  registry.registerComponent("securitySchemes", "oauthClientBasic", {
    type: "http",
    scheme: "basic",
    description:
      "OAuth client authentication: client_id:client_secret (client_secret_basic). client_secret_post via the form body is also accepted where documented.",
  });
  registry.registerComponent("securitySchemes", "oauthBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Access token issued by the token endpoint.",
  });
  for (const route of routes) {
    registry.registerPath(route);
  }
}
