#!/usr/bin/env bash
set -Eeuo pipefail
HD=/data/projects/hedgedoc
WT="$HOME/hedgedoc-build-overlap"
LOG=/tmp/hedgedoc-readonly-build.log

test -f "$WT/frontend/dist/frontend/server.js" || {
  echo "BUILD NOT READY"
  tail -n 12 "$LOG" 2>/dev/null || true
  exit 1
}

cd "$HD"
sudo systemctl stop hedgedoc-nodebook.service
rm -rf frontend/dist.prev-readonly
mv frontend/dist frontend/dist.prev-readonly
cp -a "$WT/frontend/dist" frontend/dist
sudo systemctl start hedgedoc-nodebook.service

sleep 10
systemctl is-active hedgedoc-nodebook.service
curl -s -o /dev/null -w "index=%{http_code}\n" http://192.168.1.142:8180/memex-index
curl -s -o /dev/null -w "log=%{http_code}\n" http://192.168.1.142:8180/memex-log
