// Stand-in for packages/api/src/app.ts (the Phase 0 spike) in the jsdom
// "unit" vitest project only. The real file eagerly builds a Better-Auth
// instance (`export const auth = createAuth(env)`) and imports
// `cloudflare:workers` — neither works, or needs to work, outside a workerd
// runtime. Nothing in the `unit` project exercises `app`/`auth`; those are
// covered by the `integration` project (real Workers runtime via
// @cloudflare/vitest-plugin). This keeps @flare-idp/api's barrel import
// resolvable for the pure http/security modules the `unit` project tests.
//
// Task 5 deletes the spike and replaces app.ts with http/app.ts; the
// vitest.config.ts alias pointing here should be revisited then.
export const app = undefined as never;
export const auth = undefined as never;
