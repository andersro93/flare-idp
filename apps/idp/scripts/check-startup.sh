#!/usr/bin/env bash
# S2: measure Worker bundle size and startup CPU for the Better-Auth stack.
# Usage: bun run check:startup   (from apps/idp)
set -euo pipefail
cd "$(dirname "$0")/.."
bunx vite build >/dev/null
worker_dir=$(ls -d dist/*/ | grep -v '^dist/client/' | head -1)
config="${worker_dir}wrangler.json"
echo "worker dir: $worker_dir"
# no_bundle worker: the entry (index.js) statically imports several chunks
# under assets/*.js, so the real shipped payload is the sum of every .js
# file under the worker dir, not just the top-level entry file.
raw=$(find "$worker_dir" -name '*.js' -exec cat {} + | wc -c)
gz=$(find "$worker_dir" -name '*.js' -exec cat {} + | gzip -c | wc -c)
echo "entry js raw bytes (all .js under $worker_dir): $raw"
echo "entry js gzip bytes (all .js under $worker_dir): $gz"
# Startup profile: reports CPU time spent at module evaluation (must stay well under the platform limit).
bunx wrangler check startup --config "$config" --outfile "../../.startup-profile.cpuprofile" || {
  echo "wrangler check startup failed (see output above)"; exit 1; }
echo "profile written to ../../.startup-profile.cpuprofile"
