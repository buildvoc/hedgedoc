#!/usr/bin/env bash
set -Eeuo pipefail
HD=/data/projects/hedgedoc
WT="$HOME/hedgedoc-build-overlap"
LOG=/tmp/hedgedoc-readonly-build.log

cd "$HD"
tar -cf - frontend/src | tar -xf - -C "$WT"

cd "$WT/frontend"
rm -rf dist
nohup yarn build >"$LOG" 2>&1 &
echo "BUILD_PID=$!"
echo "LOG=$LOG"
