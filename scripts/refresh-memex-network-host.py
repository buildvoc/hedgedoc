#!/usr/bin/env python3
import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

ALIAS = "memex-network"
BASE = (
    os.environ.get("MEMEX_HEDGEDOC_URL")
    or os.environ.get("HD_BASE_URL")
    or "http://127.0.0.1:8180"
).rstrip("/")
TOKEN = os.environ["MEMEX_API_TOKEN"]

def request(path, method="GET", body=None):
    headers = {"Authorization": f"Bearer {TOKEN}"}
    data = None
    if body is not None:
        data = body.encode("utf-8")
        headers["Content-Type"] = "text/markdown"
    req = urllib.request.Request(
        BASE + path, data=data, method=method, headers=headers
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode("utf-8"), response.status

def latest_revision():
    raw, _ = request(f"/api/v2/notes/{quote(ALIAS, safe='')}/revisions")
    rows = json.loads(raw)
    if not rows:
        return None
    return max(rows, key=lambda row: row["createdAt"])["uuid"]

stamp = datetime.now(timezone.utc).isoformat()
body = "\n".join(
    [
        "# Memex Network",
        "",
        "```memex",
        "Memex Association Network",
        "```",
        "",
        f"<!-- memex-refresh:manual:{stamp} -->",
        "",
    ]
)

before = latest_revision()
_, status = request(
    f"/api/v2/notes/{quote(ALIAS, safe='')}",
    method="PUT",
    body=body,
)
time.sleep(0.75)
after = latest_revision()

print("HTTP:", status)
print("previous revision:", before)
print("current revision:", after)

if before == after:
    raise SystemExit("ERROR: memex-network revision did not change")

print("revision changed: yes")
