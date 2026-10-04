#!/usr/bin/env bash
set -Eeuo pipefail
LOG=/tmp/hedgedoc-readonly-build.log
if pgrep -af "yarn.*build" >/dev/null; then
  echo "BUILD RUNNING"
else
  echo "BUILD PROCESS NOT RUNNING"
fi
tail -n 12 "$LOG" 2>/dev/null || true
test -f "$HOME/hedgedoc-build-overlap/frontend/dist/frontend/server.js" && echo "BUILD OK" || echo "BUILD NOT READY"
