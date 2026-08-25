#!/usr/bin/env bun
// Copies the Scalar API Reference browser bundle out of node_modules and
// into apps/idp/public/vendor/scalar/, where the Worker's ASSETS binding
// serves it same-origin (see packages/api/src/http/app.ts's /api/docs
// handler, which imports it as an ES module). Run whenever
// @scalar/api-reference is bumped: `bun run vendor:scalar` from apps/idp.
import { cp, mkdir, rm } from "node:fs/promises";
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

console.log(`vendored @scalar/api-reference browser bundle into ${dest}`);
