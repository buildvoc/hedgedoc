#!/usr/bin/env bash
set -Eeuo pipefail
cd /data/projects/hedgedoc

rm -f frontend/src/app/memex-index/page.tsx
rm -f frontend/src/app/memex-log/page.tsx
rmdir frontend/src/app/memex-index 2>/dev/null || true
rmdir frontend/src/app/memex-log 2>/dev/null || true

test -f 'frontend/src/app/(editor)/memex-index/page.tsx'
test -f 'frontend/src/app/(editor)/memex-log/page.tsx'

echo "CLEANUP OK"
./start_readonly_build.sh
