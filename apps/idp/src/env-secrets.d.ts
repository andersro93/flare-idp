// `wrangler types` only types secrets (AUTH_SECRET, SETUP_SECRET) when a
// local `.dev.vars` exists — it does not in CI. Secrets typing must not
// depend on local `.dev.vars`, so declare them here; this merges with the
// generated `Env` / `Cloudflare.Env` in worker-configuration.d.ts via
// TypeScript interface merging.
//
// SETUP_SECRET is required (not optional) here: when a local `.dev.vars`
// *is* present, `wrangler types` generates it as `string`, and TS interface
// merging rejects a property whose type differs (`string` vs
// `string | undefined`) across declarations.
interface Env {
  AUTH_SECRET: string;
  SETUP_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    AUTH_SECRET: string;
    SETUP_SECRET: string;
  }
}
