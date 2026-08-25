import { SELF } from "cloudflare:test";
import { errorBodySchema } from "@flare-idp/shared";
import { describe, expect, it } from "vitest";

function expectStrictHeaders(res: Response) {
  const csp = res.headers.get("content-security-policy");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self'");
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

  it("/api/docs has no inline <script> body — every script tag loads from a src= (required under script-src 'self')", async () => {
    const res = await SELF.fetch("http://localhost/api/docs");
    const html = await res.text();
    const scriptTags = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      const openTag = tag.slice(0, tag.indexOf(">") + 1);
      expect(openTag).toMatch(/\ssrc=/);
      const body = tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("<"));
      expect(body.trim()).toBe("");
    }
  });

  it("an unknown /api/* path returns the 404 envelope", async () => {
    const res = await SELF.fetch("http://localhost/api/x");
    expect(res.status).toBe(404);
    const body = errorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("not_found");
  });
});
