// Stand-in for packages/api/src/http/app.ts in the jsdom "unit" vitest
// project only. The real file eagerly builds a Better-Auth instance
// (`export const auth = createAuth(env)`) and imports `cloudflare:workers`
// — neither works, or needs to work, outside a workerd runtime. Nothing in
// the `unit` project exercises `app`/`auth`/`BETTER_AUTH_ALLOWLIST`; those
// are covered by the `integration` project (real Workers runtime via
// @cloudflare/vitest-plugin). This keeps @flare-idp/api's barrel import
// resolvable for the pure http/security modules the `unit` project tests.
//
// Exports every name `http/app.ts` exports: `app`, `auth`,
// `BETTER_AUTH_ALLOWLIST`, `CSRF_EXEMPT_PATHS` (values) and `AppType` (a
// type — erased at runtime, nothing to stub).
export const app = undefined as never;
export const auth = undefined as never;
export const BETTER_AUTH_ALLOWLIST = [] as never;
export const CSRF_EXEMPT_PATHS = [] as never;
