import { appOrigin, corsOriginFor } from "@flare-idp/api";
import { describe, expect, it } from "vitest";

const production = {
  APP_URL: "https://idp.example.com",
  ENVIRONMENT: "production",
};
const development = {
  APP_URL: "http://localhost:8787",
  ENVIRONMENT: "development",
};

describe("origin policy", () => {
  it("derives the app origin from APP_URL", () => {
    expect(appOrigin(production)).toBe("https://idp.example.com");
    expect(appOrigin({ APP_URL: "nope" })).toBeNull();
  });

  it("only grants credentialed CORS to the app's own origin", () => {
    expect(corsOriginFor(production, "https://idp.example.com")).toBe(
      "https://idp.example.com",
    );
    expect(corsOriginFor(production, "https://evil.example")).toBe("");
    expect(corsOriginFor(production, "https://sub.idp.example.com")).toBe("");
    expect(corsOriginFor(production, "http://localhost:5173")).toBe("");
    expect(corsOriginFor(production, undefined)).toBe("");
  });

  it("allows localhost origins only in development", () => {
    expect(corsOriginFor(development, "http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(corsOriginFor(development, "http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(corsOriginFor(development, "https://evil.example")).toBe("");
  });
});

describe("rejectCrossSiteMutations", () => {
  async function run(opts: {
    method?: string;
    origin?: string;
    referer?: string;
    fetchSite?: string;
  }): Promise<Response> {
    const { Hono } = await import("hono");
    const { rejectCrossSiteMutations } = await import("@flare-idp/api");
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", rejectCrossSiteMutations);
    app.all("*", (c) => c.json({ ok: true }));

    const headers = new Headers();
    if (opts.origin) headers.set("origin", opts.origin);
    if (opts.referer) headers.set("referer", opts.referer);
    if (opts.fetchSite) headers.set("sec-fetch-site", opts.fetchSite);

    return app.request(
      "/",
      { method: opts.method ?? "POST", headers },
      production as unknown as Env,
    );
  }

  it("passes safe methods regardless of origin", async () => {
    const res = await run({ method: "GET", origin: "https://evil.example" });
    expect(res.status).toBe(200);
  });

  it("passes same-origin mutations", async () => {
    const res = await run({ origin: "https://idp.example.com" });
    expect(res.status).toBe(200);
  });

  it("rejects mutations with a foreign Origin using our error envelope", async () => {
    const res = await run({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "forbidden", message: "Cross-site request rejected" },
    });
  });

  it("rejects cross-site sec-fetch-site without a matching origin", async () => {
    const res = await run({ fetchSite: "cross-site" });
    expect(res.status).toBe(403);
  });

  it("passes mutations with no Origin/Referer (server-to-server, curl)", async () => {
    const res = await run({});
    expect(res.status).toBe(200);
  });
});
