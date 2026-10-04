import json
import getpass
import time
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import quote

BASE = "http://192.168.1.142:8180"
DIR = Path("migration-v1")
TOKEN = getpass.getpass("wiki-bot Bearer token: ")

notes = {
    n["shortid"]: n
    for n in (
        json.loads(x)
        for x in (DIR / "notes.jsonl").read_text().splitlines()
        if x.strip()
    )
    if n.get("shortid")
}

manifest = [
    json.loads(x)
    for x in (DIR / "import-manifest.jsonl").read_text().splitlines()
    if x.strip()
]

failed = []
seen = set()

for row in reversed(manifest):
    alias = row.get("alias")
    if alias in seen:
        continue
    seen.add(alias)
    if row.get("status") == "failed":
        failed.append(alias)

failed.reverse()

print("Failed notes to retry:", len(failed))

out = DIR / "retry-manifest.jsonl"

with out.open("a") as log:
    for i, alias in enumerate(failed, 1):
        note = notes[alias]
        content = note.get("content") or ""

        url = f"{BASE}/api/v2/notes/{quote(alias, safe='')}"

        while True:
            req = urllib.request.Request(
                url,
                data=content.encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {TOKEN}",
                    "Content-Type": "text/markdown",
                },
            )

            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    status = "imported"
                    http = r.status
                    break

            except urllib.error.HTTPError as e:
                http = e.code

                if http == 409:
                    status = "exists"
                    break

                if http == 429:
                    wait = int(e.headers.get("Retry-After", "245"))
                    print(f"[{i}/{len(failed)}] RATE LIMIT — waiting {wait}s")
                    time.sleep(wait)
                    continue

                status = "failed"
                break

            except Exception as e:
                print(f"[{i}/{len(failed)}] ERROR {alias}: {e}")
                time.sleep(10)
                continue

        print(f"[{i:3}/{len(failed)}] {status.upper():8} {alias}")

        log.write(json.dumps({
            "alias": alias,
            "id": note.get("id"),
            "title": note.get("title"),
            "status": status,
            "http": http
        }) + "\n")
        log.flush()

        # ~20 requests/minute to avoid the 4-minute rate window
        time.sleep(3)

print("\n=== RETRY COMPLETE ===")
