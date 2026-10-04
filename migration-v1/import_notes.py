import json
import getpass
import urllib.request
import urllib.error
import time
from pathlib import Path
from urllib.parse import quote

BASE = "http://192.168.1.142:8180"
SOURCE = Path("migration-v1/notes.jsonl")
MANIFEST = Path("migration-v1/import-manifest.jsonl")

token = getpass.getpass("wiki-bot Bearer token: ")

notes = [
    json.loads(line)
    for line in SOURCE.read_text().splitlines()
    if line.strip()
]

counts = {
    "imported": 0,
    "exists": 0,
    "empty": 0,
    "failed": 0,
}

with MANIFEST.open("a") as log:
    for n, note in enumerate(notes, 1):
        alias = note.get("shortid") or str(note["id"])
        content = note.get("content")

        # Do not risk changing genuinely empty legacy notes.
        if not content:
            status = "empty"
            counts["empty"] += 1
            print(f"[{n:3}/{len(notes)}] EMPTY   {alias}")
            log.write(json.dumps({
                "id": note.get("id"),
                "alias": alias,
                "title": note.get("title"),
                "status": status
            }) + "\n")
            log.flush()
            continue

        url = f"{BASE}/api/v2/notes/{quote(alias, safe='')}"

        req = urllib.request.Request(
            url,
            data=content.encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "text/markdown",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                status = "imported"
                http = r.status
                counts["imported"] += 1

        except urllib.error.HTTPError as e:
            http = e.code

            if e.code == 409:
                status = "exists"
                counts["exists"] += 1
            else:
                status = "failed"
                counts["failed"] += 1

        except Exception as e:
            http = None
            status = "failed"
            counts["failed"] += 1

        print(
            f"[{n:3}/{len(notes)}] "
            f"{status.upper():8} "
            f"{alias} "
            f"{note.get('title') or ''}"
        )

        log.write(json.dumps({
            "id": note.get("id"),
            "alias": alias,
            "title": note.get("title"),
            "status": status,
            "http": http
        }) + "\n")
        log.flush()

        time.sleep(0.05)

print()
print("=== IMPORT SUMMARY ===")
for k, v in counts.items():
    print(f"{k:10}: {v}")

print()
print("manifest :", MANIFEST)
