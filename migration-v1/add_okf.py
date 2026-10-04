import json, getpass, time, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import quote

BASE = "http://192.168.1.142:8180"
TOKEN = getpass.getpass("wiki-bot Bearer token: ")

notes = [
    json.loads(x)
    for x in Path("migration-v1/notes.jsonl").read_text().splitlines()
    if x.strip()
]

todo = [
    n for n in notes
    if (n.get("content") or "").strip()
    and not (n.get("content") or "").lstrip().startswith("---")
]

print("notes to update:", len(todo))

for i, n in enumerate(todo, 1):
    alias = n["shortid"]
    title = n.get("title") or "Untitled"
    created = n.get("createdAt") or ""

    # JSON quoted strings are valid YAML quoted scalars
    qtitle = json.dumps(title)

    frontmatter = f"""---
type: document
okf_type: Source
title: {qtitle}
description: ""
tags:
  - hedgedoc1
  - legacy-import
status: stable
created_at: "{created}"
sources:
  - "https://notes.buildvoc.co.uk/{alias}"
---

"""

    body = frontmatter + (n.get("content") or "")
    url = f"{BASE}/api/v2/notes/{quote(alias, safe='')}"

    while True:
        req = urllib.request.Request(
            url,
            data=body.encode(),
            method="PUT",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "text/markdown"
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print(f"[{i}/{len(todo)}] {r.status} {alias}")
                break

        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = int(e.headers.get("Retry-After", "245"))
                print(f"RATE LIMIT: waiting {wait}s")
                time.sleep(wait)
                continue
            print(f"[{i}/{len(todo)}] FAILED {e.code} {alias}")
            break

    time.sleep(3)
