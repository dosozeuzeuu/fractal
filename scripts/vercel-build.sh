#!/usr/bin/env bash
# Vercel build: the public site at /, the app (wallet, claim, receipt, terminal) at /app.html.
# Before the mainnet contracts exist (no contracts/deployments/4663.json), app pages show a launch screen.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf dist apps/web/dist apps/site/dist
# FRACTAL_NET=local builds against a local chain instead (for testing this pipeline).
NET="${FRACTAL_NET:-mainnet}"
CHAIN=$([ "$NET" = local ] && echo 31337 || echo 4663)
if [ -f "contracts/deployments/$CHAIN.json" ]; then
  if [ "$NET" = local ]; then node apps/web/scripts/config.mjs local /api/bundler; else node apps/web/scripts/config.mjs mainnet; fi
  (cd apps/web && npx tsc --noEmit && npx vite build)
else
  echo "No mainnet deployment yet: building app pages as launch screens."
  rm -f apps/web/public/config.json
  (cd apps/web && VITE_PREVIEW=1 npx vite build)
fi
(cd apps/site && npx vite build)
mkdir -p dist
cp -R apps/web/dist/. dist/
mv dist/index.html dist/app.html
cp -R apps/site/dist/assets/. dist/assets/
cp apps/site/dist/index.html dist/index.html
echo "dist ready: $(du -sh dist | cut -f1)"
