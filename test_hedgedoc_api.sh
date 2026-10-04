#!/usr/bin/env bash
set -euo pipefail

BASE="${HEDGEDOC_BASE:-http://192.168.1.142:8180}"
ALIAS="ios-terminal-test-$(date +%Y%m%d-%H%M%S)"

read -rsp "HedgeDoc API token: " TOKEN
echo

BODY="$(cat <<EON
---
type: Source
title: "iOS Terminal Test"
description: "HedgeDoc API test before installing the iOS Shortcut"
tags:
  - inbox
  - ios-share
  - terminal-test
status: draft
sources: []
---

# iOS Terminal Test

Created at $(date -Is)

https://example.com/
EON
)"

echo "Creating: ${BASE}/api/v2/notes/${ALIAS}"

HTTP_CODE="$(
  curl -sS \
    -o /tmp/hedgedoc-create-response.json \
    -w '%{http_code}' \
    -X POST \
    "${BASE}/api/v2/notes/${ALIAS}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: text/markdown" \
    --data-binary "${BODY}"
)"

echo
echo "HTTP ${HTTP_CODE}"
cat /tmp/hedgedoc-create-response.json
echo

if [[ "$HTTP_CODE" != "201" ]]; then
    echo
    echo "CREATE FAILED"
    exit 1
fi

echo
echo "=== Reading note back ==="

curl -fsS \
  "${BASE}/api/v2/notes/${ALIAS}/content" \
  -H "Authorization: Bearer ${TOKEN}"

echo
echo
echo "=== PASS ==="
echo "Open:"
echo "${BASE}/${ALIAS}"
