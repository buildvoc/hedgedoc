import json, re, getpass, time
import urllib.request, urllib.error
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
    if (n.get("content") or "").lstrip().startswith("---")
]

print("existing YAML notes:", len(todo))

for i, n in enumerate(todo, 1):
    alias = n["shortid"]
    content = n["content"]

    m = re.match(r'^(---\s*\n)(.*?)(\n---\s*\n?)', content, re.S)
    if not m:
        print("SKIP malformed frontmatter:", alias)
        continue

    fm = m.group(2)
    additions = []

    def missing(key):
        return not re.search(rf'(?m)^{re.escape(key)}\s*:', fm)

    # Preserve existing HedgeDoc type (e.g. document or slide)
    if missing("type"):
        additions.append("type: document")

    if missing("okf_type"):
        additions.append("okf_type: Source")

    if missing("title"):
        additions.append(f"title: {json.dumps(n.get('title') or 'Untitled')}")

    if missing("description"):
        additions.append('description: ""')

    if missing("status"):
        additions.append("status: stable")

    if missing("created_at"):
        additions.append(f'created_at: "{n.get("createdAt") or ""}"')

    if missing("sources"):
        additions += [
            "sources:",
            f'  - "https://notes.buildvoc.co.uk/{alias}"'
        ]

    if not additions:
        print(f"[{i}/{len(todo)}] already OKF {alias}")
        continue

    new_fm = fm.rstrip() + "\n" + "\n".join(additions)
    body = m.group(1) + new_fm + m.group(3) + content[m.end():]

    url = f"{BASE}/api/v2/notes/{quote(alias, safe='')}"

    while True:
        req = urllib.request.Request(
            url,
            data=body.encode("utf-8"),
            method="PUT",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Content-Type": "text/markdown",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print(f"[{i}/{len(todo)}] {r.status} {alias}")
                break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = int(e.headers.get("Retry-After", "245"))
                print(f"RATE LIMIT - waiting {wait}s")
                time.sleep(wait)
                continue
            print(f"[{i}/{len(todo)}] FAILED {e.code} {alias}")
            break

    time.sleep(3)

