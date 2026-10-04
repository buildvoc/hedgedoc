#!/usr/bin/env python3

import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

API = "http://127.0.0.1:3100/api/v2/notes"
OLLAMA = "http://192.168.1.99:11434/api/chat"
MODEL = "gemma4:26b"
NODEBOOK = "liphook-free-trails-20260815-082925"

TOKEN = os.environ["MEMEX_API_TOKEN"]
QUEUE = Path("memex/queue.jsonl")


def api_get(path):
    req = urllib.request.Request(
        f"{API}/{path}",
        headers={"Authorization": f"Bearer {TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()


def api_put(alias, content):
    req = urllib.request.Request(
        f"{API}/{alias}",
        data=content.encode(),
        method="PUT",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/markdown",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def title_from_markdown(text, alias):
    m = re.search(r'^title:\s*["\']?(.*?)["\']?\s*$', text, re.M)
    if m:
        return m.group(1).strip()
    m = re.search(r'^#\s+(.+)$', text, re.M)
    return m.group(1).strip() if m else alias


# REVISION_AWARE_MEMEX
# Revision UUID is the cache key.
# Previously processed sources are represented by memex/index.md summaries.
INDEX_PATH = Path("memex/index.md")
LOG_PATH = Path("memex/log.md")

current_index = (
    INDEX_PATH.read_text(encoding="utf-8")
    if INDEX_PATH.exists()
    else "# Memex Index\n\nNo indexed sources yet."
)

rows = [
    json.loads(x)
    for x in QUEUE.read_text().splitlines()
    if x.strip()
]

pending = next(
    (x for x in reversed(rows) if x.get("status") == "pending"),
    None
)

if not pending:
    raise SystemExit("No pending Memex queue item")

queued_alias = pending["alias"]

# Generated nodeBook is output, never input.
if queued_alias == NODEBOOK:
    now = datetime.now(timezone.utc).isoformat()
    pending["status"] = "processed"
    pending["processedAt"] = now
    pending["ignoredReason"] = "nodebook-output"
    pending["nodeBook"] = NODEBOOK
    QUEUE.write_text("".join(json.dumps(x) + "\n" for x in rows))
    raise SystemExit("Ignoring generated nodeBook queue entry")


def processed_revision(alias):
    for row in reversed(rows):
        if (
            row.get("alias") == alias
            and row.get("status") == "processed"
            and row.get("sourceRevision")
        ):
            return row["sourceRevision"]
    return None


# Fetch only revision metadata first.
revisions = json.loads(api_get(f"{queued_alias}/revisions"))

if not revisions:
    raise RuntimeError(f"No revisions returned for {queued_alias}")

latest = max(revisions, key=lambda x: x["createdAt"])
latest_revision = latest["uuid"]
previous_revision = processed_revision(queued_alias)

# Exact same revision already processed: no content fetch, no Gemma.
if previous_revision == latest_revision and pending.get("queueReason") != "orphan-repair":
    now = datetime.now(timezone.utc).isoformat()

    for row in rows:
        if row.get("id") == pending["id"]:
            row["status"] = "processed"
            row["processedAt"] = now
            row["sourceRevision"] = latest_revision
            row["ignoredReason"] = "unchanged-revision"
            row["nodeBook"] = NODEBOOK

    QUEUE.write_text(
        "".join(json.dumps(x) + "\n" for x in rows)
    )

    if not LOG_PATH.exists():
        LOG_PATH.write_text("# Memex Log\n\n", encoding="utf-8")

    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(
            f"## [{now}] revision check | {queued_alias}\n\n"
            f"- revision: `{latest_revision}`\n"
            f"- unchanged: yes\n"
            f"- LLM called: no\n\n"
        )

    raise SystemExit(
        f"Unchanged HedgeDoc ignored: {queued_alias} "
        f"({latest_revision}); LLM not called"
    )


# Parse only the Sources section of the maintained index.
source_section = ""

if "## Sources" in current_index:
    source_section = current_index.split("## Sources", 1)[1]
    if "## Trails" in source_section:
        source_section = source_section.split("## Trails", 1)[0]

index_sources = []

for line in source_section.splitlines():
    line = line.strip()

    if not line.startswith("- [") or "](" not in line or ") — " not in line:
        continue

    try:
        title = line[3:line.index("](")]
        rest = line[line.index("](") + 2:]
        url, summary = rest.split(") — ", 1)

        if "/n/" not in url:
            continue

        alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]

        if not alias or alias in {queued_alias, NODEBOOK}:
            continue

        index_sources.append({
            "alias": alias,
            "title": title.strip(),
            "summary": summary.strip(),
        })
    except ValueError:
        continue


# Existing knowledge comes from compact index summaries.
docs = []
seen_aliases = set()

for item in index_sources:
    alias = item["alias"]

    if alias in seen_aliases:
        continue

    seen_aliases.add(alias)

    docs.append({
        "id": len(docs) + 1,
        "alias": alias,
        "title": item["title"],
        "revision": processed_revision(alias) or "",
        "content": (
            "INDEX SUMMARY ONLY — previously processed source.\n"
            + item["summary"]
        ),
        "summary": item["summary"],
        "cached": True,
    })


# Only the new/revised HedgeDoc gets a full content fetch.
content = api_get(f"{queued_alias}/content")

queued_doc = {
    "id": len(docs) + 1,
    "alias": queued_alias,
    "title": title_from_markdown(content, queued_alias),
    "revision": latest_revision,
    "content": content,
    "summary": "",
    "cached": False,
}

docs.append(queued_doc)

prompt_docs = "\n\n".join(
    (
        f"""DOCUMENT {d['id']} — INDEX SUMMARY ONLY
TITLE: {d['title']}
SUMMARY: {d['summary']}"""
        if d["cached"]
        else
        f"""DOCUMENT {d['id']} — NEW OR REVISED SOURCE
TITLE: {d['title']}
REVISION: {d['revision']}

{d['content']}"""
    )
    for d in docs
)

prompt = f"""
You are discovering meaningful Memex trails across source documents.

A MEMEX TRAIL is a conceptual traversal through documents that share a
meaningful relationship. It is NOT merely a category, date-sorted list,
search result, or collection of everything about the same town.

Review all {len(docs)} documents together.

DOCUMENT {queued_doc['id']} is the NEW OR REVISED source.

Documents marked INDEX SUMMARY ONLY were already processed. Their maintained
summaries are compact Memex memory; their full HedgeDoc content does not need
to be read again.

Review the conceptual set, focusing new analysis on DOCUMENT {queued_doc['id']}.
Reconsider existing trails only where the new/revised evidence warrants it.

Return the COMPLETE maintained trail set, not only trails related to the new
document. Preserve existing valid trails from the CURRENT MEMEX INDEX.
Every document must occur in at least one returned trail.

DISCOVER TRAILS USING DISTINCT CONCEPTUAL LENSES, for example:
- shared activity or purpose
- shared venue or setting
- shared audience or community
- related cultural form
- related market/commercial activity
- related organisation or participants
- thematic or functional relationship
- meaningful sequence or progression supported by the source content

IMPORTANT TRAIL RULES:

1. Prefer MULTIPLE useful trails when the documents support different
   relationships.

2. Documents MAY belong to several trails when each membership expresses
   a genuinely different relationship.

3. NO ORPHANS. Every document MUST belong to at least one meaningful trail.
   Never invent a weak catch-all relationship merely to satisfy this rule.
   Find the strongest defensible conceptual connection to another document.

4. Every trail must contain at least 2 documents.

5. Do NOT create a catch-all trail simply because documents are:
   - local events
   - in Liphook
   - upcoming
   - in the same month or date range
   - sorted chronologically

6. Chronology alone is NOT a meaningful Memex relationship.
   Do not create trails such as "Upcoming Events Aug-Oct" merely to connect
   otherwise unrelated documents.

7. Order members according to the conceptual traversal of that trail.
   Use chronological order ONLY when time itself is essential to the
   relationship.

8. Prefer a smaller precise trail over a broad vague trail.

9. Trail names must describe the actual relationship.
   Good examples:
   - Community Markets and Sales
   - Outdoor Cinema Experiences
   - Live Performance and Cultural Events

   Bad examples:
   - Upcoming Local Events
   - Liphook Events
   - August to October Events
   - General Activities

10. Do not invent relationships unsupported by the source documents.

11. Before returning the answer, internally compare possible overlapping
    trails and discard weak, redundant, catch-all, or chronology-only trails.

Return JSON only:

{{
  "summary": "short explanation of the conceptual structure discovered",
  "documents": [
    {{
      "id": 1,
      "summary": "one concise factual line describing this source"
    }}
  ],
  "trails": [
    {{
      "name": "specific conceptual trail name",
      "reason": "the concrete relationship shared by these documents",
      "confidence": 0.0,
      "members": [1, 2, 3]
    }}
  ]
}}

CRITICAL:
Use ONLY numeric DOCUMENT IDs in members.
Never reproduce aliases.
Do not output your analysis.
Do not force every document into a trail.
In "documents", return a summary for the NEW OR REVISED SOURCE.
Do not rewrite summaries merely because a document is INDEX SUMMARY ONLY.

CURRENT MEMEX INDEX:
Use this as navigation/context. The source documents below remain authoritative.

{current_index}

SOURCE DOCUMENTS:

{prompt_docs}
"""

payload = json.dumps({
    "model": MODEL,
    "messages": [{"role": "user", "content": prompt}],
    "stream": False,
    "format": "json",
    "options": {
        "temperature": 0.35,
        "num_ctx": 32768
    }
}).encode()

req = urllib.request.Request(
    OLLAMA,
    data=payload,
    headers={"Content-Type": "application/json"},
)

print("Gemma reviewing", len(docs), "documents...")

with urllib.request.urlopen(req, timeout=600) as r:
    response = json.loads(r.read().decode())

result = json.loads(response["message"]["content"])

valid_ids = {d["id"] for d in docs}

trails = []

for trail in result.get("trails", []):
    members = [
        int(x) for x in trail.get("members", [])
        if isinstance(x, int) and x in valid_ids
    ]

    members = list(dict.fromkeys(members))

    if len(members) >= 2:
        trails.append({
            "name": str(trail.get("name", "Untitled Trail")).strip(),
            "reason": str(trail.get("reason", "")).strip(),
            "confidence": trail.get("confidence", 0),
            "members": members,
        })

# Build membership and traversal edges
memberships = {d["id"]: [] for d in docs}
edges = {d["id"]: [] for d in docs}

for trail in trails:
    name = trail["name"]
    relation = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')

    for doc_id in trail["members"]:
        memberships[doc_id].append(name)

    for a, b in zip(trail["members"], trail["members"][1:]):
        edges[a].append((relation, b))

id_to_doc = {d["id"]: d for d in docs}

graph = []

for d in docs:
    graph.append(f"# {d['title']} · {d['alias']}")
    graph.append(f"alias: {d['alias']};")

    for trail in memberships[d["id"]]:
        graph.append(f"trail: {trail};")

    for relation, target_id in edges[d["id"]]:
        target = id_to_doc[target_id]
        graph.append(
            f"<{relation}> {target['title']} · {target['alias']};"
        )

    graph.append("")

frontmatter = """---
okf_type: Index
title: "Liphook Events — Free LLM Trail Test"
description: "Gemma freely maintains trails after reviewing queued HedgeDoc revisions."
tags:
  - memex
  - llm-test
  - trails
status: experimental
---"""

body = [
    frontmatter,
    "",
    "# Liphook Events — Free LLM Trail Test",
    "",
    f"Updated from Memex queue using `{MODEL}`.",
    "",
    f"Queued source: `{queued_alias}`",
    f"Source revision: `{queued_doc['revision']}`",
    "",
    "Canonical Memex association and trail files were not modified.",
    "",
    "## LLM review",
    "",
    result.get("summary", ""),
    "",
]

for trail in trails:
    body += [
        f"### {trail['name']}",
        "",
        trail["reason"],
        "",
        f"Confidence: `{trail['confidence']}`",
        "",
    ]

body += [
    "## Graph",
    "",
    "```nodeBook",
    *graph,
    "```",
    "",
]

new_nodebook = "\n".join(body)

# Keep the previous generated view so a failed lint cannot damage the graph.
old_nodebook = api_get(f"{NODEBOOK}/content")
before = json.loads(api_get(f"{NODEBOOK}/revisions"))
before_uuid = max(before, key=lambda x: x["createdAt"])["uuid"]

status = api_put(NODEBOOK, new_nodebook)

# MEMEX_ORPHAN_LINT_GATE
# The generated index/nodeBook must satisfy the no-orphan invariant before
# this queue item is allowed to become processed.
_lint_script = Path(__file__).with_name("lint_memex.py")
_lint_result = __import__("subprocess").run(
    [
        __import__("sys").executable,
        str(_lint_script),
        "--include-alias",
        queued_alias,
    ],
    cwd=str(Path(__file__).resolve().parents[1]),
    text=True,
    capture_output=True,
)

if _lint_result.stdout:
    print(_lint_result.stdout, end="")

if _lint_result.stderr:
    print(_lint_result.stderr, end="", file=__import__("sys").stderr)

if _lint_result.returncode != 0:
    print("Lint failed; restoring previous nodeBook...")
    api_put(NODEBOOK, old_nodebook)
    raise SystemExit(
        f"Memex lint rejected {queued_alias}; "
        "previous nodeBook restored; queue item remains pending"
    )

# Mark queue entry processed
now = datetime.now(timezone.utc).isoformat()

for row in rows:
    if row.get("id") == pending["id"]:
        row["status"] = "processed"
        row["processedAt"] = now
        row["sourceRevision"] = queued_doc["revision"]
        row["nodeBook"] = NODEBOOK

QUEUE.write_text(
    "".join(json.dumps(x) + "\n" for x in rows)
)

after = json.loads(api_get(f"{NODEBOOK}/revisions"))
after_uuid = max(after, key=lambda x: x["createdAt"])["uuid"]

print()
print("=== DONE ===")
print("HTTP:", status)
print("source:", queued_alias)
print("source revision:", queued_doc["revision"])
print("trails:", len(trails))
print("nodeBook:", f"http://192.168.1.142:8280/n/{NODEBOOK}")
print("previous nodeBook revision:", before_uuid)
print("current nodeBook revision:", after_uuid)
print("queue status: processed")
print("Canonical Memex files were NOT modified.")


# MEMEX_INDEX_LOG_MAINTENANCE
import os as _os
from datetime import datetime as _datetime, timezone as _timezone

_summary_by_id = {}
for _item in result.get("documents", []):
    if not isinstance(_item, dict):
        continue
    try:
        _id = int(_item.get("id"))
    except (TypeError, ValueError):
        continue
    _summary = " ".join(str(_item.get("summary", "")).split())
    if _summary:
        _summary_by_id[_id] = _summary

_public_base = _os.environ.get(
    "MEMEX_HEDGEDOC_BASE_URL",
    "http://192.168.1.142:8180"
).rstrip("/")

_index = [
    "# Memex Index",
    "",
    "Content-oriented index maintained after successful Memex processing.",
    "",
    "## Sources",
    "",
]

for _doc in docs:
    _summary = _summary_by_id.get(
        _doc["id"],
        _doc.get("summary") or f"Source note: {_doc['title']}."
    )
    _url = f"{_public_base}/n/{_doc['alias']}"
    _index.append(f"- [{_doc['title']}]({_url}) — {_summary}")

_index.extend(["", "## Trails", ""])

_doc_by_id = {d["id"]: d for d in docs}

for _trail in trails:
    _index.append(f"### {_trail['name']}")
    if _trail.get("reason"):
        _index.append("")
        _index.append(_trail["reason"])
    _index.append("")
    for _id in _trail["members"]:
        _doc = _doc_by_id.get(_id)
        if _doc:
            _url = f"{_public_base}/n/{_doc['alias']}"
            _index.append(f"- [{_doc['title']}]({_url})")
    _index.append("")

INDEX_PATH.write_text("\n".join(_index).rstrip() + "\n", encoding="utf-8")

if not LOG_PATH.exists():
    LOG_PATH.write_text("# Memex Log\n\n", encoding="utf-8")

_stamp = _datetime.now(_timezone.utc).isoformat(timespec="seconds")
_summary = " ".join(str(result.get("summary", "")).split())

with LOG_PATH.open("a", encoding="utf-8") as _fh:
    _fh.write(
        f"## [{_stamp}] ingest | {queued_alias}\n\n"
        f"- revision: `{queued_doc['revision']}`\n"
        f"- cached index sources: {sum(1 for d in docs if d.get('cached'))}\n"
        f"- full HedgeDocs read: {sum(1 for d in docs if not d.get('cached'))}\n"
        f"- documents represented: {len(docs)}\n"
        f"- trails: {len(trails)}\n"
        f"- LLM called: yes\n"
        f"- nodeBook: `{NODEBOOK}`\n"
        f"- summary: {_summary or 'No summary returned.'}\n\n"
    )

print("index:", INDEX_PATH)
print("log:", LOG_PATH)
