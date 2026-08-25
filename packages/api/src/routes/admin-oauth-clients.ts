import { dbFor, recordAuditEvent } from "@flare-idp/db";
import {
  errorBodySchema,
  OAUTH_SCOPES,
  oauthClientCreateSchema,
  oauthClientDtoSchema,
  oauthClientPatchSchema,
} from "@flare-idp/shared";
import { createRoute, z } from "@hono/zod-openapi";
import { callAuth, mapAuthError } from "../auth/forward";
import { auth } from "../http/app";
import { newRouter } from "../http/app-shared";
import { AppError } from "../http/errors";
import { requireAdmin } from "../http/middleware/require-admin";
import { requireAuth } from "../http/middleware/require-auth";
import { clientAddress } from "../http/security/rate-limit";

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: errorBodySchema } },
  } as const;
}

// ---------------------------------------------------------------------------
// Client policy (plan Core contracts, BINDING) — enforced BEFORE any
// Better-Auth call, each violation a 400 `invalid_request` with a specific
// message. Better-Auth (checkOAuthClient / validateClientRedirectUri) also
// validates redirect URIs, scopes and grant types server-side, but with
// generic RFC-shaped messages not meant for our envelope — this is the
// friendlier, facade-specific layer the plan calls for.
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
  "client_credentials",
]);
const ALLOWED_AUTH_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "none",
]);

/** Returns whether `raw` is https, or http on an exact loopback host; throws otherwise. */
function checkRedirectUri(raw: string): { loopback: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(
      400,
      "invalid_request",
      `redirect_uris: "${raw}" is not a valid URL`,
    );
  }
  if (url.protocol === "https:") return { loopback: false };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return { loopback: true };
  }
  throw new AppError(
    400,
    "invalid_request",
    `redirect_uris: "${raw}" must use https, or http on a loopback host (localhost, 127.0.0.1, [::1])`,
  );
}

type ClientPolicyInput = {
  redirectUris?: string[];
  scope?: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
  applicationType?: "web" | "native";
};

/**
 * Validates whichever fields are present (create passes all of them; patch
 * passes only what the caller provided) and returns the possibly-forced
 * `applicationType` — any loopback redirect URI forces "native", overriding
 * whatever the caller sent (Better-Auth's own default "web" application type
 * rejects loopback redirect URIs outright).
 *
 * The `client_credentials` + `none` cross-field check only fires when BOTH
 * fields are present in the same call: on create both are required by
 * `oauthClientCreateSchema`, so it always fires; on patch it only catches a
 * request that sets both incompatible fields at once — a patch that changes
 * just one of the two relies on Better-Auth's own server-side validation of
 * the merged record.
 */
function applyClientPolicy(
  input: ClientPolicyInput,
): "web" | "native" | undefined {
  let forceNative = false;

  if (input.redirectUris !== undefined) {
    if (input.redirectUris.length === 0) {
      throw new AppError(
        400,
        "invalid_request",
        "redirect_uris must not be empty",
      );
    }
    for (const uri of input.redirectUris) {
      if (checkRedirectUri(uri).loopback) forceNative = true;
    }
  }

  if (input.scope !== undefined) {
    const unknown = input.scope.filter(
      (s) => !(OAUTH_SCOPES as readonly string[]).includes(s),
    );
    if (unknown.length > 0) {
      throw new AppError(
        400,
        "invalid_request",
        `scope: unknown scope(s): ${unknown.join(", ")}`,
      );
    }
  }

  if (input.grantTypes !== undefined) {
    const unknown = input.grantTypes.filter((g) => !ALLOWED_GRANT_TYPES.has(g));
    if (unknown.length > 0) {
      throw new AppError(
        400,
        "invalid_request",
        `grant_types: unsupported grant type(s): ${unknown.join(", ")}`,
      );
    }
  }

  if (
    input.tokenEndpointAuthMethod !== undefined &&
    !ALLOWED_AUTH_METHODS.has(input.tokenEndpointAuthMethod)
  ) {
    throw new AppError(
      400,
      "invalid_request",
      `token_endpoint_auth_method: unsupported value "${input.tokenEndpointAuthMethod}"`,
    );
  }

  if (
    input.grantTypes?.includes("client_credentials") &&
    input.tokenEndpointAuthMethod === "none"
  ) {
    throw new AppError(
      400,
      "invalid_request",
      "client_credentials grant requires a confidential client (token_endpoint_auth_method other than none)",
    );
  }

  return forceNative ? "native" : input.applicationType;
}

// ---------------------------------------------------------------------------
// DTO mapping — Better-Auth's `auth.api.*` client calls all return the OAuth
// 2.0 Dynamic Client Registration shape (snake_case field names: `client_id`,
// `client_name`, `redirect_uris`, `token_endpoint_auth_method`,
// `grant_types`, `scope` (space-joined), `skip_consent`, `application_type`,
// `disabled`, `client_id_issued_at` (unix seconds)) — see
// `schemaToOAuth`/`oauthToSchema` in
// `@better-auth/oauth-provider/dist/authorize-*.mjs`. Mapped field-by-field,
// never spread, so a future upstream field addition can't leak through
// un-reviewed (e.g. `client_secret`, which read paths already strip
// server-side, but nothing here should rely on that alone).
// ---------------------------------------------------------------------------

type OAuthClientRow = Awaited<ReturnType<typeof auth.api.getOAuthClient>>;

function toDto(client: OAuthClientRow) {
  return {
    clientId: client.client_id,
    name: client.client_name,
    redirectUris: client.redirect_uris ?? [],
    tokenEndpointAuthMethod: client.token_endpoint_auth_method,
    grantTypes: client.grant_types,
    scope: client.scope,
    skipConsent: client.skip_consent,
    applicationType: client.application_type ?? undefined,
    disabled: client.disabled,
    createdAt:
      client.client_id_issued_at !== undefined
        ? new Date(client.client_id_issued_at * 1000)
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const paramsSchema = z.object({ clientId: z.string().min(1) });

const listResponseSchema = z.object({
  clients: z.array(oauthClientDtoSchema),
});
const createResponseSchema = z.object({
  client: oauthClientDtoSchema,
  clientSecret: z.string().optional(),
});
const rotateResponseSchema = z.object({ clientSecret: z.string() });

const listRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      description: "OAuth clients.",
      content: { "application/json": { schema: listResponseSchema } },
    },
    401: errorResponse("Authentication required."),
    403: errorResponse("Admin role required."),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: { "application/json": { schema: oauthClientCreateSchema } },
    },
  },
  responses: {
    201: {
      description:
        "Client created. `clientSecret` is returned once here and never again (omitted for public clients).",
      content: { "application/json": { schema: createResponseSchema } },
    },
    400: errorResponse(
      "The request body failed validation, or violated client policy.",
    ),
    401: errorResponse("Authentication required."),
    403: errorResponse("Admin role required."),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{clientId}",
  request: { params: paramsSchema },
  responses: {
    200: {
      description: "The client.",
      content: { "application/json": { schema: oauthClientDtoSchema } },
    },
    401: errorResponse("Authentication required."),
    403: errorResponse("Admin role required."),
    404: errorResponse("No such client."),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{clientId}",
  request: {
    params: paramsSchema,
    body: {
      content: { "application/json": { schema: oauthClientPatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Client updated.",
      content: { "application/json": { schema: oauthClientDtoSchema } },
    },
    400: errorResponse(
      "The request body failed validation, or violated client policy.",
    ),
    401: errorResponse("Authentication required."),
    403: errorResponse("Admin role required."),
    404: errorResponse("No such client."),
  },
});

const rotateRoute = createRoute({
  method: "post",
  path: "/{clientId}/rotate-secret",
  request: { params: paramsSchema },
  responses: {
    200: {
      description: "A freshly generated client secret, replacing the old one.",
      content: { "application/json": { schema: rotateResponseSchema } },
    },
    401: errorResponse("Authentication required."),
    403: errorResponse("Admin role required."),
    404: errorResponse("No such client."),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{clientId}",
  request: { params: paramsSchema },
  responses: {
    204: { description: "Client deleted." },
    401: errorResponse("Authentication required."),
    403: errorResponse("Admin role required."),
    404: errorResponse("No such client."),
  },
});

// NOTE on the `auth.api.getOAuthClient(s)` / `adminUpdateOAuthClient` /
// `rotateClientSecret` / `deleteOAuthClient` calls below: `clientPrivileges`
// is intentionally unset (see auth.ts), but that does NOT make these calls
// privilege-free for any admin — the plugin still resolves the calling
// session and enforces ROW OWNERSHIP (`client.userId === session.user.id`),
// independent of `requireAdmin` above. `adminCreateOAuthClient` stamps the
// new row's `userId` with the creating admin's own session user id, so
// every client any one admin creates stays fully manageable through this
// facade by that SAME admin — fine today, since exactly one admin exists.
// If a second admin account ever lands (Phase 6), a client created by admin
// A will 401 (ownership mismatch, not a 403) when admin B tries to
// get/patch/rotate/delete it here. The fix then is the plugin's
// `clientReference` mechanism (map every client to a shared reference id
// instead of a per-user `userId`, e.g. "the org" or "the admin group") so
// clients become globally admin-managed — NOT `clientPrivileges`, which
// only gates the action itself and does not bypass the ownership check.

// `.openapi()` calls MUST be chained directly off `newRouter()`'s result and
// the return captured (see account.ts for the full explanation of why); the
// `.use()` calls below are bare statements for the same reason.
const adminOauthClientRoutesBase = newRouter();
adminOauthClientRoutesBase.use("*", requireAuth);
adminOauthClientRoutesBase.use("*", requireAdmin);

export const adminOauthClientRoutes = adminOauthClientRoutesBase
  .openapi(listRoute, async (c) => {
    let rows: Awaited<ReturnType<typeof auth.api.getOAuthClients>>;
    try {
      rows = await auth.api.getOAuthClients({ headers: c.req.raw.headers });
    } catch (error) {
      throw mapAuthError(error);
    }
    return c.json({ clients: (rows ?? []).map(toDto) }, 200);
  })
  .openapi(createRouteDef, async (c) => {
    const body = c.req.valid("json");
    const applicationType = applyClientPolicy({
      redirectUris: body.redirectUris,
      scope: body.scope,
      grantTypes: body.grantTypes,
      tokenEndpointAuthMethod: body.tokenEndpointAuthMethod,
      applicationType: body.applicationType,
    });

    const created = await callAuth(c, () =>
      auth.api.adminCreateOAuthClient({
        body: {
          client_name: body.name,
          redirect_uris: body.redirectUris,
          token_endpoint_auth_method: body.tokenEndpointAuthMethod,
          grant_types: body.grantTypes,
          response_types: ["code"],
          scope: body.scope.join(" "),
          skip_consent: body.skipConsent,
          application_type: applicationType,
        },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );

    const user = c.get("user");
    const db = dbFor(c.env.DB);
    // Never the secret — only the client id and name.
    await recordAuditEvent(db, {
      event: "oauth_client.created",
      actorUserId: user?.id ?? null,
      actorIp: clientAddress(c.req.raw.headers),
      target: created.client_id,
      details: JSON.stringify({
        clientId: created.client_id,
        name: created.client_name,
      }),
    });

    const dto = toDto(created);
    const response: { client: typeof dto; clientSecret?: string } = {
      client: dto,
    };
    // Public clients (token_endpoint_auth_method "none") have no secret.
    if (created.client_secret) response.clientSecret = created.client_secret;
    return c.json(response, 201);
  })
  .openapi(getRoute, async (c) => {
    const { clientId } = c.req.valid("param");
    let client: OAuthClientRow;
    try {
      client = await auth.api.getOAuthClient({
        query: { client_id: clientId },
        headers: c.req.raw.headers,
      });
    } catch (error) {
      throw mapAuthError(error);
    }
    return c.json(toDto(client), 200);
  })
  .openapi(patchRoute, async (c) => {
    const { clientId } = c.req.valid("param");
    const body = c.req.valid("json");
    // `tokenEndpointAuthMethod` is not part of `oauthClientPatchSchema` (see
    // its doc comment) so it's never passed through here.
    const applicationType = applyClientPolicy({
      redirectUris: body.redirectUris,
      scope: body.scope,
      grantTypes: body.grantTypes,
      applicationType: body.applicationType,
    });

    // Build `update` with ONLY the keys the caller actually provided.
    // `adminUpdateOAuthClient` merges this object onto the STORED client
    // (`{ ...stored, ...updates }`) and then re-runs full client validation
    // (`applyOAuthClientRegistrationDefaults` + `checkOAuthClient`) against
    // the merged result — an explicit `key: undefined` for an omitted field
    // is still an own property, so a naive "always send all six keys" object
    // would overwrite every unpatched field to `undefined`, which
    // `applyOAuthClientRegistrationDefaults` then re-defaults (e.g.
    // `grant_types` back to `["authorization_code"]`), silently discarding
    // the client's real stored values and potentially failing validation
    // (e.g. the redirect-URI-required check) on a patch that never touched
    // those fields. `application_type` is included whenever the computed
    // value is defined — either the caller patched it directly (no
    // `redirectUris` in the body at all) or a loopback URI in a patched
    // `redirectUris` forced it to `"native"` (`applyClientPolicy` only ever
    // returns a value here in one of those two cases — never a stale
    // leftover from a previous, unrelated patch).
    const update: Record<string, unknown> = {};
    if (body.name !== undefined) update.client_name = body.name;
    if (body.redirectUris !== undefined)
      update.redirect_uris = body.redirectUris;
    if (body.grantTypes !== undefined) update.grant_types = body.grantTypes;
    if (body.scope !== undefined) update.scope = body.scope.join(" ");
    if (body.skipConsent !== undefined) update.skip_consent = body.skipConsent;
    if (applicationType !== undefined) {
      update.application_type = applicationType;
    }

    const updated = await callAuth(c, () =>
      auth.api.adminUpdateOAuthClient({
        body: { client_id: clientId, update },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );

    const user = c.get("user");
    const db = dbFor(c.env.DB);
    // Changed field NAMES only — never values (could include future
    // sensitive metadata).
    await recordAuditEvent(db, {
      event: "oauth_client.updated",
      actorUserId: user?.id ?? null,
      actorIp: clientAddress(c.req.raw.headers),
      target: clientId,
      details: JSON.stringify({ clientId, fields: Object.keys(body) }),
    });

    return c.json(toDto(updated), 200);
  })
  .openapi(rotateRoute, async (c) => {
    const { clientId } = c.req.valid("param");

    const rotated = await callAuth(c, () =>
      auth.api.rotateClientSecret({
        body: { client_id: clientId },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );

    if (!rotated.client_secret) {
      // Better-Auth only rotates confidential clients (it 400s beforehand
      // for `none`/no-secret clients) — a rotation response with no secret
      // would mean an upstream contract change, not a caller mistake.
      throw new AppError(
        500,
        "internal",
        "Client secret rotation returned no secret",
      );
    }

    const user = c.get("user");
    const db = dbFor(c.env.DB);
    await recordAuditEvent(db, {
      event: "oauth_client.secret_rotated",
      actorUserId: user?.id ?? null,
      actorIp: clientAddress(c.req.raw.headers),
      target: clientId,
      details: JSON.stringify({ clientId }),
    });

    return c.json({ clientSecret: rotated.client_secret }, 200);
  })
  .openapi(deleteRoute, async (c) => {
    const { clientId } = c.req.valid("param");

    await callAuth(c, () =>
      auth.api.deleteOAuthClient({
        body: { client_id: clientId },
        headers: c.req.raw.headers,
        returnHeaders: true,
      }),
    );

    const user = c.get("user");
    const db = dbFor(c.env.DB);
    await recordAuditEvent(db, {
      event: "oauth_client.deleted",
      actorUserId: user?.id ?? null,
      actorIp: clientAddress(c.req.raw.headers),
      target: clientId,
      details: JSON.stringify({ clientId }),
    });

    return c.body(null, 204);
  });
