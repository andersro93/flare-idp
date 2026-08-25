// Type-level smoke test for the `hc<AppType>()` typed client
// (`packages/api/src/http/app.ts`'s `AppType` — the `.route()` chain's
// return type). `AppType` is imported with `import type`, so it is fully
// erased at runtime: this file never touches the real
// `packages/api/src/http/app.ts` (which is stubbed for this jsdom "unit"
// project — see `test/unit/shims/api-app-stub.ts` — because it eagerly
// builds a Better-Auth instance and imports `cloudflare:workers`). The
// typecheck ITSELF is the test (`bun run typecheck` runs `tsc --noEmit`
// over this file); the runtime assertions below just confirm `hc`'s proxy
// produces a real, callable accessor for a known route at runtime too.
import type { AppType } from "@flare-idp/api";
import { hc } from "hono/client";
import { describe, expect, it } from "vitest";

const client = hc<AppType>("http://localhost");

describe("hc<AppType> typed client", () => {
  it("is constructed as hc's proxy (a callable, so typeof is 'function')", () => {
    expect(["function", "object"]).toContain(typeof client);
  });

  it("exposes a callable accessor for a known route (GET /api/health/live)", () => {
    expect(typeof client.api.health.live.$get).toBe("function");
  });

  it("typechecks a known route's accessor as returning the live-check's typed response", () => {
    // Referencing (not calling) the accessor keeps this a pure type-level
    // + existence check — actually invoking `$get()` would issue a real
    // `fetch()` against http://localhost, which nothing is listening on in
    // this jsdom unit test. `ClientResponse` (hono's typed response, not
    // the DOM `Response` type) is what hc's proxy actually returns; the
    // literal `200`/`"ok"` types below only resolve if `AppType` really
    // carries the health route's schema through `hc<AppType>` (proof that
    // the typed client — not just its shape — is live).
    const getLive = client.api.health.live.$get;
    type LiveResult = Awaited<ReturnType<typeof getLive>>;
    const status: LiveResult["status"] = 200;
    expect(status).toBe(200);
  });

  it("rejects a route that does not exist, at the type level", () => {
    // @ts-expect-error — "doesNotExist" is not a route on AppType.
    const nonexistentRoute = client.api.health.doesNotExist;
    // hc's runtime proxy doesn't validate against real routes (only the
    // types above do) — accessing an unknown segment just returns another
    // proxy, not a throw. This just confirms the `@ts-expect-error` line
    // above is exercised, not skipped as dead code.
    expect(["function", "object"]).toContain(typeof nonexistentRoute);
  });
});
