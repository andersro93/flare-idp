#!/usr/bin/env bun
// Copies the Scalar API Reference browser bundle out of node_modules and
// into apps/idp/public/vendor/scalar/, where the Worker's ASSETS binding
// serves it same-origin (see packages/api/src/http/app.ts's /api/docs
// handler, which references it via an external <script type="module" src>
// tag — a strict `script-src 'self'` CSP blocks INLINE scripts, so the
// bootstrap that calls `createApiReference` must be its own same-origin
// file, not inlined into the docs HTML). Run whenever @scalar/api-reference
// is bumped: `bun run vendor:scalar` from apps/idp.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const appRoot = path.resolve(here, "..");

// Bun's workspace install hoists @scalar/api-reference to the repo root
// node_modules, not apps/idp/node_modules — resolve it rather than assume a
// path.
const packageEntry = Bun.resolveSync("@scalar/api-reference", appRoot);
const source = path.join(
  packageEntry.slice(
    0,
    packageEntry.indexOf("@scalar/api-reference") +
      "@scalar/api-reference".length,
  ),
  "dist/browser",
);
const dest = path.join(appRoot, "public/vendor/scalar");

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

await cp(
  path.join(source, "standalone.esm.js"),
  path.join(dest, "standalone.esm.js"),
);
await cp(path.join(source, "chunks"), path.join(dest, "chunks"), {
  recursive: true,
});

// The /api/docs bootstrap: a same-origin external script (not inlined into
// the docs HTML) so it runs under a strict `script-src 'self'` CSP with no
// `'unsafe-inline'`.
const bootstrap = `import { createApiReference } from "/vendor/scalar/standalone.esm.js";
createApiReference("#app", { url: "/api/openapi.json" });
`;
await writeFile(path.join(dest, "bootstrap.js"), bootstrap);

console.log(`vendored @scalar/api-reference browser bundle into ${dest}`);
