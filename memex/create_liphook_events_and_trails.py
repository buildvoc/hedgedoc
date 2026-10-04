import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HD_API = "http://127.0.0.1:3100/api/v2"
HD_PUBLIC = "http://192.168.1.142:8180"
NB_PUBLIC = "http://192.168.1.142:8280"

OLLAMA = "http://192.168.1.99:11434"
MODEL = "gemma4:26b"

TOKEN = os.environ.get("MEMEX_API_TOKEN")
if not TOKEN:
    raise SystemExit("MEMEX_API_TOKEN is not set")

EVENTS = [
    {
        "alias": "liphook-car-boot-2026-09-20",
        "title": "Community Car Boot Sale — 20 September 2026",
        "content": """---
okf_type: Source
title: "Community Car Boot Sale — 20 September 2026"
description: "Upcoming community event in the Liphook area."
tags:
  - liphook
  - local-events
  - community
  - 2026
status: upcoming
event_date: 2026-09-20
---

# Community Car Boot Sale

**Date:** Sunday, 20 September 2026  
**Area:** Liphook

Upcoming local community car boot sale around Liphook.

## Sources

- [Liphook events at TicketSource](https://www.ticketsource.com/whats-on/liphook)
- [Liphook Millennium Centre](https://www.ticketsource.com/liphookmillenniumcentre)
"""
    },
    {
        "alias": "liphook-village-market-2026-09-20",
        "title": "Liphook Village Market — 20 September 2026",
        "content": """---
okf_type: Source
title: "Liphook Village Market — 20 September 2026"
description: "Upcoming village market in the Liphook area."
tags:
  - liphook
  - local-events
  - market
  - 2026
status: upcoming
event_date: 2026-09-20
---

# Liphook Village Market

**Date:** Sunday, 20 September 2026  
**Area:** Liphook

Upcoming Liphook Village Market.

## Sources

- [Liphook events at TicketSource](https://www.ticketsource.com/whats-on/liphook)
- [Liphook Millennium Centre](https://www.ticketsource.com/liphookmillenniumcentre)
"""
    },
    {
        "alias": "hollycombe-glow-night-2026-09-26",
        "title": "Glow Night - Festival of Mechanical Music",
        "content": """---
okf_type: Source
title: "Glow Night - Festival of Mechanical Music"
description: "Glow Night at Hollycombe Steam in the Country."
tags:
  - liphook
  - local-events
  - hollycombe
  - mechanical-music
  - 2026
status: upcoming
event_date: 2026-09-26
event_time: "16:00"
---

# Glow Night - Festival of Mechanical Music

**Date:** Saturday, 26 September 2026  
**Time:** 4:00 PM  
**Venue:** Hollycombe Steam in the Country

Festival of Mechanical Music Glow Night.

## Source

- [Hollycombe — Glow Night](https://www.hollycombe.co.uk/events/glow-night-2609)
"""
    },
    {
        "alias": "back-to-land-girls-liphook-2026-10-04",
        "title": "Back to the Land Girls by Badapple Theatre",
        "content": """---
okf_type: Source
title: "Back to the Land Girls by Badapple Theatre"
description: "Badapple Theatre performance at the Liphook Millennium Centre."
tags:
  - liphook
  - local-events
  - theatre
  - millennium-centre
  - 2026
status: upcoming
event_date: 2026-10-04
event_time: "19:30"
---

# Back to the Land Girls by Badapple Theatre

**Date:** Sunday, 4 October 2026  
**Time:** 7:30 PM  
**Venue:** Liphook Millennium Centre

Theatrical performance by Badapple Theatre.

## Sources

- [Liphook events at TicketSource](https://www.ticketsource.com/whats-on/liphook)
- [Liphook Millennium Centre](https://www.ticketsource.com/liphookmillenniumcentre)
"""
    },
]


def hd_request(path, content):
    req = urllib.request.Request(
        HD_API + path,
        data=content.encode("utf-8"),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/markdown",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


# ---------------------------------------------------------
# 1. CREATE SOURCE NOTES
# ---------------------------------------------------------

new_docs = []

print("=== CREATE HEDGEDOC NOTES ===", flush=True)

for event in EVENTS:
    status, response = hd_request(
        "/notes/" + event["alias"],
        event["content"]
    )

    if status == 201:
        new_docs.append(event)
        print("CREATED", event["alias"], "|", event["title"], flush=True)

    elif status == 409:
        print("EXISTS ", event["alias"], "- excluded from this LLM run", flush=True)

    else:
        print("FAILED ", event["alias"], "HTTP", status, flush=True)
        print(response[:500], flush=True)

    time.sleep(0.5)


print()
print("New docs created:", len(new_docs), flush=True)

if len(new_docs) < 2:
    raise SystemExit(
        "Need at least 2 newly-created docs for trail discovery. "
        "Existing notes are deliberately NOT included."
    )


# ---------------------------------------------------------
# 2. LLM TRAILS — NEW DOCS ONLY
#
# Use numeric IDs so Gemma cannot corrupt HedgeDoc aliases.
# ---------------------------------------------------------

llm_docs = []

for i, doc in enumerate(new_docs, 1):
    llm_docs.append({
        "id": i,
        "title": doc["title"],
        "content": re.sub(r"\s+", " ", doc["content"])[:2500],
    })


prompt = """Create Memex trails using ONLY the newly-created documents below.

A trail is an ordered associative path through documents, not simply a
topic cluster or partition.

Rules:
- Use ONLY numeric document IDs supplied below.
- Never invent an ID.
- Create 1 to 3 useful trails.
- Each trail must contain at least 2 documents.
- A document MAY occur in more than one trail when genuinely useful.
- Do not force overlap.
- Do not force unrelated documents into the same trail.
- Ordering should represent a useful reading, temporal, thematic, or
  reasoning path.
- For dated events, chronology is useful where it makes semantic sense.

Return JSON only:

{
  "trails": [
    {
      "name": "Trail title",
      "member_ids": [1, 2, 3],
      "reason": "Why this ordered path is useful",
      "confidence": 0.95
    }
  ]
}

NEWLY CREATED DOCUMENTS:
""" + json.dumps(llm_docs, ensure_ascii=False, indent=2)


print()
print("=== GEMMA TRAIL DISCOVERY ===", flush=True)
print("Model:", MODEL, flush=True)
print("Ollama:", OLLAMA, flush=True)
print("Documents sent:", len(llm_docs), flush=True)
print("Prompt chars:", f"{len(prompt):,}", flush=True)


payload = json.dumps({
    "model": MODEL,
    "messages": [
        {"role": "user", "content": prompt}
    ],
    "stream": False,
    "format": "json",
    "options": {
        "temperature": 0.15,
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
    ollama_result = json.loads(r.read())

elapsed = time.time() - started

raw = ollama_result["message"]["content"]
result = json.loads(raw)

print("Completed:", f"{elapsed:.1f}s", flush=True)
print("Prompt tokens:", ollama_result.get("prompt_eval_count"), flush=True)
print("Output tokens:", ollama_result.get("eval_count"), flush=True)


# ---------------------------------------------------------
# 3. VALIDATE LLM OUTPUT
# ---------------------------------------------------------

id_to_doc = {
    i: doc
    for i, doc in enumerate(new_docs, 1)
}

validated = []

for trail in result.get("trails", []):
    ids = []

    for value in trail.get("member_ids", []):
        try:
            value = int(value)
        except (TypeError, ValueError):
            continue

        if value in id_to_doc and value not in ids:
            ids.append(value)

    if len(ids) < 2:
        continue

    validated.append({
        "name": str(trail.get("name") or "Untitled Trail").strip(),
        "member_ids": ids,
        "members": [id_to_doc[i]["alias"] for i in ids],
        "reason": str(trail.get("reason") or "").strip(),
        "confidence": trail.get("confidence"),
    })


if not validated:
    raise SystemExit("Gemma produced no valid trails; nodeBook not created.")


print()
print("=== VALIDATED TRAILS ===")

for trail in validated:
    print(
        f"- {trail['name']}: "
        f"{len(trail['members'])} docs "
        f"(confidence {trail['confidence']})"
    )
    print("  " + " -> ".join(trail["members"]))


# Save isolated result; DO NOT modify canonical trails.jsonl.
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

out = Path(f"memex/liphook-event-trails-{stamp}.json")
out.write_text(
    json.dumps(
        {
            "created_docs": [
                {
                    "alias": d["alias"],
                    "title": d["title"]
                }
                for d in new_docs
            ],
            "trails": validated,
            "model": MODEL,
        },
        indent=2,
        ensure_ascii=False
    ) + "\n"
)

print("Saved:", out)


# ---------------------------------------------------------
# 4. BUILD DEDICATED NODEBOOK
# ---------------------------------------------------------

memberships = {
    doc["alias"]: []
    for doc in new_docs
}

edges = {
    doc["alias"]: []
    for doc in new_docs
}

for trail in validated:
    name = trail["name"].replace(";", ",").replace("\n", " ").strip()

    for alias in trail["members"]:
        if name not in memberships[alias]:
            memberships[alias].append(name)

    # Preserve LLM trail ordering as adjacency edges.
    for a, b in zip(trail["members"], trail["members"][1:]):
        if b not in edges[a]:
            edges[a].append(b)


node_names = {}

for doc in new_docs:
    title = (
        doc["title"]
        .replace("\n", " ")
        .replace(";", ",")
        .replace("<", "(")
        .replace(">", ")")
        .strip()
    )
    node_names[doc["alias"]] = f"{title} · {doc['alias']}"


lines = [
    "---",
    "okf_type: Index",
    'title: "Liphook Local Events — LLM Memex Trails"',
    'description: "Trails generated only from newly-created Liphook event notes."',
    "tags:",
    "  - memex",
    "  - trails",
    "  - liphook",
    "  - local-events",
    "status: experimental",
    "---",
    "",
    "# Liphook Local Events — LLM Memex Trails",
    "",
    f"Generated with `{MODEL}` from **{len(new_docs)} newly-created HedgeDoc notes only**.",
    "",
    "```nodeBook"
]


for doc in new_docs:
    alias = doc["alias"]

    lines.append(f"# {node_names[alias]}")
    lines.append(f"alias: {alias};")

    for trail_name in memberships[alias]:
        lines.append(f"trail: {trail_name};")

    for target in edges[alias]:
        lines.append(f"<next_in_trail> {node_names[target]};")

    lines.append("")


lines += ["```", ""]

nodebook_body = "\n".join(lines)

nodebook_alias = f"liphook-event-trails-{stamp}"

status, response = hd_request(
    "/notes/" + nodebook_alias,
    nodebook_body
)

if status != 201:
    raise SystemExit(
        f"Failed to create nodeBook note: HTTP {status}\n{response[:500]}"
    )


print()
print("=== DONE ===")
print("New source notes:")

for doc in new_docs:
    print(f"  {HD_PUBLIC}/n/{doc['alias']}")

print()
print("New nodeBook:")
print(f"  {NB_PUBLIC}/n/{nodebook_alias}")
print()
print("Canonical memex/trails.jsonl was NOT modified.")
