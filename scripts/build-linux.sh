#!/bin/sh
# Build deb, AppImage and tar.gz with electron-builder.
# Requires Node 18+ and network access to download Electron. No root.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
if [ ! -d node_modules/electron ]; then
  npm ci --no-audit --no-fund
fi
npm run vendor
npm test
npx electron-builder --linux deb AppImage tar.gz --x64
echo "Artifacts are in $ROOT/dist"
