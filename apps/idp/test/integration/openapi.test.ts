import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type OpenApiOperation = {
  responses?: Record<string, unknown>;
};

type OpenApiSpec = {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
};

// The API surface as of the Phase 1 close-out. Growing (or shrinking) it is
// a conscious diff — if this assertion fails because you added/removed/
// renamed a route, update this literal array in the same change, not as a
// side effect of something else.
const EXPECTED_PATHS = [
  "/api/account/profile",
  "/api/account/sessions",
  "/api/account/sessions/{id}",
  "/api/admin/oauth-clients",
  "/api/admin/oauth-clients/{clientId}",
  "/api/admin/oauth-clients/{clientId}/rotate-secret",
  "/api/auth/email/resend",
  "/api/auth/email/verify",
  "/api/auth/password/change",
  "/api/auth/password/forgot",
  "/api/auth/password/reset",
  "/api/health/live",
  "/api/health/ready",
  "/api/oauth/consent",
  "/api/session",
  "/api/session/sign-in/password",
  "/api/session/sign-out",
  "/api/session/sign-out-all",
  "/api/setup/complete",
  "/api/setup/status",
];

// Operations that are intentionally never-erroring by design (documented
// with a single 200 response and nothing else): liveness/status reads with
// no auth, no body, and no way to fail short of the process being down.
// `GET /api/health/ready` is NOT in this list — it documents a 503 for the
// "misconfigured/unreachable" case. Adding an entry here is a conscious
// diff: it should only ever be a read-only endpoint with no failure mode.
const NO_ERROR_RESPONSE_OPERATIONS = new Set([
  "get /api/health/live",
  "get /api/setup/status",
  "get /api/session",
]);

async function fetchSpec(): Promise<OpenApiSpec> {
  const res = await SELF.fetch("http://localhost/api/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiSpec;
}

describe("GET /api/openapi.json", () => {
  it("emits openapi 3.1.0 (pinned to what doc31 actually generates)", async () => {
    const spec = await fetchSpec();
    expect(spec.openapi).toBe("3.1.0");
  });

  it("documents exactly the Phase 1 API surface (sorted path snapshot)", async () => {
    const spec = await fetchSpec();
    expect(Object.keys(spec.paths).sort()).toEqual(EXPECTED_PATHS);
  });

  it("documents at least one non-2xx response for every operation, except the known error-free reads", async () => {
    const spec = await fetchSpec();

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const key = `${method} ${path}`;
        const statuses = Object.keys(operation.responses ?? {});
        const hasNon2xx = statuses.some((status) => !status.startsWith("2"));

        if (NO_ERROR_RESPONSE_OPERATIONS.has(key)) {
          expect(hasNon2xx, `${key} was expected to stay error-free`).toBe(
            false,
          );
        } else {
          expect(
            hasNon2xx,
            `${key} documents no non-2xx response (responses: ${statuses.join(",") || "none"}). ` +
              "Either add one, or — if this operation genuinely cannot fail — " +
              "add it to NO_ERROR_RESPONSE_OPERATIONS with a reason.",
          ).toBe(true);
        }
      }
    }
  });
});

describe("GET /api/docs", () => {
  it("serves the docs page as same-origin HTML with no cross-origin script/link URLs", async () => {
    const res = await SELF.fetch("http://localhost/api/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    const srcAndHrefUrls = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(srcAndHrefUrls.length).toBeGreaterThan(0);
    for (const url of srcAndHrefUrls) {
      expect(url.startsWith("http://") || url.startsWith("https://")).toBe(
        false,
      );
    }
  });
});
