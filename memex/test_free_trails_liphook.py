import json
import os
import re
import time
import urllib.request
from datetime import datetime

HD_API = "http://127.0.0.1:3100/api/v2"
NB_PUBLIC = "http://192.168.1.142:8280"

OLLAMA = "http://192.168.1.99:11434"
MODEL = "gemma4:26b"

TOKEN = os.environ["MEMEX_API_TOKEN"]

ALIASES = [
    "liphook-car-boot-2026-09-20",
    "liphook-village-market-2026-09-20",
    "hollycombe-glow-night-2026-09-26",
    "back-to-land-girls-liphook-2026-10-04",
]


def get_content(alias):
    req = urllib.request.Request(
        f"{HD_API}/notes/{alias}/content",
        headers={"Authorization": f"Bearer {TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()


def create_note(alias, text):
    req = urllib.request.Request(
        f"{HD_API}/notes/{alias}",
        data=text.encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/markdown",
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


# ---------------------------------------------------------
# Load the ACTUAL current HedgeDoc content
# ---------------------------------------------------------

docs = []

for i, alias in enumerate(ALIASES, 1):
    text = get_content(alias)

    title = alias
    m = re.search(r'(?m)^title:\s*["\']?(.*?)["\']?\s*$', text)
    if m:
        title = m.group(1)

    docs.append({
        "id": i,
        "alias": alias,
        "title": title,
        "content": text,
    })


print("=== CONTENT GIVEN TO GEMMA ===")

for d in docs:
    print(
        f"{d['id']}. {d['alias']} | {d['title']} "
        f"({len(d['content']):,} chars)"
    )


# Do NOT give opaque aliases to Gemma.
# It returns numeric IDs; Python restores exact aliases.
llm_docs = [
    {
        "id": d["id"],
        "title": d["title"],
        "content": d["content"],
    }
    for d in docs
]


prompt = """Review the following documents as a Memex.

Create whatever trails you think are genuinely useful after reading
their content.

A trail is a meaningful associative path through documents.

You are free to decide:
- how many trails are useful
- what each trail means
- which documents belong to each trail
- the order of documents
- whether a document belongs to several trails
- whether some documents should not belong to a trail
- what kind of intellectual, thematic, temporal, practical, or other
  connection makes the trail useful

Do not create trails merely to use every document.
Do not force overlap.
Use your judgement.

Use ONLY the numeric document IDs supplied below.

Return JSON only:

{
  "trails": [
    {
      "name": "name chosen by you",
      "member_ids": [1, 2],
      "reason": "why this is a useful trail",
      "confidence": 0.0
    }
  ]
}

DOCUMENTS:
""" + json.dumps(llm_docs, ensure_ascii=False, indent=2)


print("\n=== FREE TRAIL DISCOVERY ===")
print("Model:", MODEL)
print("Documents:", len(docs))
print("Prompt chars:", f"{len(prompt):,}")
print("Sending...", flush=True)


payload = json.dumps({
    "model": MODEL,
    "messages": [
        {"role": "user", "content": prompt}
    ],
    "stream": False,
    "format": "json",
    "options": {
        "temperature": 0.35,
        "num_ctx": 32768
    }
}).encode()


req = urllib.request.Request(
    OLLAMA + "/api/chat",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST"
)

started = time.time()

with urllib.request.urlopen(req, timeout=900) as r:
    response = json.loads(r.read())

elapsed = time.time() - started
result = json.loads(response["message"]["content"])


print("\n=== GEMMA RESULT ===")
print("Time:", f"{elapsed:.1f}s")
print("Prompt tokens:", response.get("prompt_eval_count"))
print("Output tokens:", response.get("eval_count"))


# ---------------------------------------------------------
# Validate numeric IDs and restore exact aliases
# ---------------------------------------------------------

idmap = {d["id"]: d for d in docs}
trails = []

for t in result.get("trails", []):
    ids = []

    for raw in t.get("member_ids", []):
        try:
            n = int(raw)
        except (TypeError, ValueError):
            continue

        if n in idmap and n not in ids:
            ids.append(n)

    if len(ids) < 2:
        continue

    trails.append({
        "name": str(t.get("name") or "Untitled Trail").strip(),
        "ids": ids,
        "members": [idmap[n]["alias"] for n in ids],
        "reason": str(t.get("reason") or "").strip(),
        "confidence": t.get("confidence"),
    })


if not trails:
    raise SystemExit("Gemma chose no valid multi-document trails.")


for t in trails:
    print(f"\n{t['name']}")
    print("  confidence:", t["confidence"])
    print("  reason:", t["reason"])
    print("  path:", " -> ".join(t["members"]))


# ---------------------------------------------------------
# Render exactly what Gemma chose
# ---------------------------------------------------------

membership = {d["alias"]: [] for d in docs}
edges = {d["alias"]: [] for d in docs}

for t in trails:
    clean_name = (
        t["name"]
        .replace(";", ",")
        .replace("\n", " ")
    )

    for alias in t["members"]:
        membership[alias].append(clean_name)

    for a, b in zip(t["members"], t["members"][1:]):
        edge = (clean_name, b)
        if edge not in edges[a]:
            edges[a].append(edge)


names = {
    d["alias"]:
        f"{d['title']} · {d['alias']}"
        .replace(";", ",")
        .replace("<", "(")
        .replace(">", ")")
    for d in docs
}


lines = [
    "---",
    "okf_type: Index",
    'title: "Liphook Events — Free LLM Trail Test"',
    'description: "Gemma freely generated trails after reviewing the source content."',
    "tags:",
    "  - memex",
    "  - llm-test",
    "  - trails",
    "status: experimental",
    "---",
    "",
    "# Liphook Events — Free LLM Trail Test",
    "",
    f"`{MODEL}` reviewed the current content of {len(docs)} HedgeDoc notes.",
    "",
    "No canonical Memex associations or trails were modified.",
    "",
    "## LLM rationale",
    ""
]

for t in trails:
    lines += [
        f"### {t['name']}",
        "",
        t["reason"],
        "",
        f"Confidence: `{t['confidence']}`",
        ""
    ]


lines += [
    "## Graph",
    "",
    "```nodeBook"
]


for d in docs:
    alias = d["alias"]

    lines.append(f"# {names[alias]}")
    lines.append(f"alias: {alias};")

    for trail in membership[alias]:
        lines.append(f"trail: {trail};")

    for trail, target in edges[alias]:
        relation = re.sub(
            r"[^a-z0-9]+",
            "_",
            trail.lower()
        ).strip("_")

        lines.append(
            f"<{relation}> {names[target]};"
        )

    lines.append("")


lines += ["```", ""]

body = "\n".join(lines)

stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
alias = f"liphook-free-trails-{stamp}"

status = create_note(alias, body)

print("\n=== DONE ===")
print("HTTP:", status)
print("nodeBook:")
print(f"{NB_PUBLIC}/n/{alias}")
print("\nCanonical Memex files were NOT modified.")
