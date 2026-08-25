import { SELF } from "cloudflare:test";
import { errorBodySchema } from "@flare-idp/shared";
import { describe, expect, it } from "vitest";

function expectStrictHeaders(res: Response) {
  const csp = res.headers.get("content-security-policy");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("security headers", () => {
  it("the SPA shell carries strict CSP + HSTS + nosniff + frame-ancestors none", async () => {
    const res = await SELF.fetch("http://localhost/");
    expectStrictHeaders(res);
  });

  it("/api/health/live carries strict CSP + HSTS + nosniff + frame-ancestors none", async () => {
    const res = await SELF.fetch("http://localhost/api/health/live");
    expectStrictHeaders(res);
  });

  it("/api/docs carries the relaxed style-src variant", async () => {
    const res = await SELF.fetch("http://localhost/api/docs");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it("an unknown /api/* path returns the 404 envelope", async () => {
    const res = await SELF.fetch("http://localhost/api/x");
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});
