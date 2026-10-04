#!/usr/bin/env python3

import json
import os
import re
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timezone
from pathlib import Path

API = "http://127.0.0.1:3100/api/v2/notes"
MODEL_SETTINGS_PATH = Path(
    os.environ.get("MEMEX_MODEL_SETTINGS_PATH", "memex/model-settings.json")
)
RECOMMENDATIONS_FILE = Path(
    os.environ.get(
        "MEMEX_ASSOCIATION_RECOMMENDATIONS_FILE",
        "memex/association-recommendations.jsonl",
    )
)


def load_model_settings():
    settings = {}
    if MODEL_SETTINGS_PATH.exists():
        value = json.loads(MODEL_SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            settings = value

    def value(name, env_name, fallback):
        configured = settings.get(name)
        if configured not in (None, ""):
            return configured
        return os.environ.get(env_name, fallback)

    base_url = str(
        value("baseUrl", "MEMEX_OLLAMA_BASE_URL", "http://192.168.1.99:11434")
    ).rstrip("/")
    default_model = str(
        value("defaultModel", "MEMEX_MODEL", "gemma4:26b")
    )

    return {
        "ollama": f"{base_url}/api/chat",
        "defaultModel": default_model,
        "numCtx": int(value("numCtx", "MEMEX_NUM_CTX", 32768)),
        "maxPromptChars": int(
            value("maxPromptChars", "MEMEX_PROMPT_DOC_CHARS", 80000)
        ),
        "timeoutSeconds": int(
            value("timeoutSeconds", "MEMEX_TIMEOUT_SECONDS", 600)
        ),
        "temperature": float(value("temperature", "MEMEX_TEMPERATURE", 0.35)),
    }


MODEL_SETTINGS = load_model_settings()
OLLAMA = MODEL_SETTINGS["ollama"]
MODEL = MODEL_SETTINGS["defaultModel"]
NUM_CTX = MODEL_SETTINGS["numCtx"]
MAX_PROMPT_DOC_CHARS = MODEL_SETTINGS["maxPromptChars"]
TIMEOUT_SECONDS = MODEL_SETTINGS["timeoutSeconds"]
TEMPERATURE = MODEL_SETTINGS["temperature"]
NODEBOOK = "memex-network"

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


def sync_readonly_mirror(alias, path):
    try:
        api_put(alias, path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"WARNING: failed to sync {alias} revision mirror: {exc}")


def title_from_markdown(text, alias):
    m = re.search(r'^title:\s*["\']?(.*?)["\']?\s*$', text, re.M)
    if m:
        return m.group(1).strip()
    m = re.search(r'^#\s+(.+)$', text, re.M)
    return m.group(1).strip() if m else alias


# REVISION_AWARE_MEMEX
# Revision UUID is the cache key.

def parse_json_object(text):
    if not isinstance(text, str):
        raise ValueError("Ollama response content is not text")

    start = text.find("{")
    if start < 0:
        raise ValueError("Ollama response contained no JSON object")

    value, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(value, dict):
        raise ValueError("Ollama response JSON must be an object")
    return value


def append_association_recommendations(source_doc, proposals, queue_row):
    RECOMMENDATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)

    existing = []
    if RECOMMENDATIONS_FILE.exists():
        for raw in RECOMMENDATIONS_FILE.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            try:
                item = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                existing.append(item)

    def pair_key(source, target):
        return tuple(sorted((str(source).strip(), str(target).strip())))

    pending_keys = {
        (
            pair_key(item.get("source", ""), item.get("target", "")),
            str(item.get("sourceRevision", "")),
        )
        for item in existing
        if item.get("status") == "pending"
    }

    now = datetime.now(timezone.utc).isoformat()
    additions = []

    for proposal in proposals:
        target_alias = str(proposal.get("target", "")).strip()
        if not target_alias or target_alias == source_doc["alias"]:
            continue

        key = (
            pair_key(source_doc["alias"], target_alias),
            str(source_doc["revision"]),
        )
        if key in pending_keys:
            continue

        additions.append({
            "id": str(uuid.uuid4()),
            "source": source_doc["alias"],
            "sourceTitle": source_doc["title"],
            "target": target_alias,
            "targetTitle": str(proposal.get("targetTitle", target_alias)),
            "relation": "associated_with",
            "createdBy": "llm",
            "reason": proposal["reason"],
            "confidence": proposal["confidence"],
            "mainModel": MODEL,
            "recommendationSource": "main-model-candidate",
            "sourceRevision": source_doc["revision"],
            "snapshotRevision": queue_row.get("snapshotRevision"),
            "queueItemId": queue_row.get("id"),
            "recommendedAt": now,
            "status": "pending",
        })
        pending_keys.add(key)

    if additions:
        with RECOMMENDATIONS_FILE.open("a", encoding="utf-8") as fh:
            for item in additions:
                fh.write(json.dumps(item, separators=(",", ":")) + "\n")

    return {
        "added": len(additions),
        "pending": sum(
            1 for item in existing if item.get("status") == "pending"
        ) + len(additions),
    }


# Previously processed sources are represented by memex/index.md summaries.
INDEX_PATH = Path("memex/index.md")
LOG_PATH = Path("memex/log.md")

# KARPATHY_INDEX_LOG_CONTEXT
# index.md is content-oriented memory; log.md is chronological operational
# memory. Keep log context bounded so it does not crowd source evidence.
from wiki_log import ensure_index_labels, recent_log_context

RECENT_LOG_ENTRIES = max(
    1, int(os.environ.get("MEMEX_RECENT_LOG_ENTRIES", "12"))
)
RECENT_LOG_MAX_CHARS = max(
    1000, int(os.environ.get("MEMEX_RECENT_LOG_MAX_CHARS", "12000"))
)
recent_log, recent_log_entry_count = recent_log_context(
    LOG_PATH,
    max_entries=RECENT_LOG_ENTRIES,
    max_chars=RECENT_LOG_MAX_CHARS,
)

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

# Latest queue state is authoritative. A source that was processed and later
# cancelled must not be fed back into the maintained index/graph.
latest_by_alias = {}
for row in rows:
    alias = row.get("alias")
    if alias:
        latest_by_alias[alias] = row

cancelled_aliases = {
    alias
    for alias, row in latest_by_alias.items()
    if row.get("status") == "cancelled"
}

pending = next(
    (x for x in reversed(rows) if x.get("status") == "pending"),
    None
)

if not pending:
    raise SystemExit("No pending Memex queue item")

queued_alias = pending["alias"]

# Queue/run overrides take precedence over central model settings.
if pending.get("llmModel"):
    MODEL = str(pending["llmModel"])
if pending.get("numCtx"):
    NUM_CTX = int(pending["numCtx"])

# Canonical memex-network host is output, never a queued source.
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
        if row.get("alias") != alias:
            continue

        if row.get("status") == "cancelled":
            return None

        if row.get("status") == "processed" and row.get("sourceRevision"):
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

    sync_readonly_mirror("memex-log", LOG_PATH)

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

        if (
            not alias
            or alias in {queued_alias, NODEBOOK}
            or alias in cancelled_aliases
        ):
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

queued_text = f"""DOCUMENT {queued_doc['id']} — NEW OR REVISED SOURCE
TITLE: {queued_doc['title']}
REVISION: {queued_doc['revision']}

{queued_doc['content']}"""

parts = [queued_text]
used = len(queued_text)

for d in docs:
    if not d["cached"]:
        continue

    text = f"""DOCUMENT {d['id']} — INDEX SUMMARY ONLY
TITLE: {d['title']}
SUMMARY: {d['summary']}"""

    if used + len(text) > MAX_PROMPT_DOC_CHARS:
        break

    parts.append(text)
    used += len(text)

prompt_docs = "\n\n".join(parts)

trail_section = (
    current_index.split("## Trails", 1)[1]
    if "## Trails" in current_index
    else ""
)
existing_trail_count = len(
    re.findall(r"(?m)^###\s+\S", trail_section)
)
trail_mode = (
    "BOOTSTRAP: the current Memex index has no maintained trails. "
    "Reconstruct strong trails across the supplied corpus."
    if existing_trail_count == 0
    else f"MAINTENANCE: preserve and update the {existing_trail_count} "
         "existing maintained trails."
)

if existing_trail_count == 0:
    bootstrap_docs = []
    for doc in docs:
        summary = doc.get("summary", "").strip()
        if not summary:
            summary = f"Source note: {doc['title']}."
        bootstrap_docs.append(
            f"DOCUMENT {doc['id']}\n"
            f"TITLE: {doc['title']}\n"
            f"SUMMARY: {summary}"
        )

    bootstrap_prompt = f"""
You are rebuilding an EMPTY Memex trail catalogue from compact source memory.

Identify strong, useful conceptual trails shared by TWO OR MORE supplied
documents. Do not force unrelated documents into a trail.

Return JSON only:
{{
  "summary": "short explanation of the reconstructed trail structure",
  "documents": [
    {{
      "id": {queued_doc['id']},
      "summary": "one concise factual line describing the new/revised source"
    }}
  ],
  "trails": [
    {{
      "name": "specific relationship name",
      "reason": "concrete relationship supported by the supplied titles/summaries",
      "confidence": 0.0,
      "members": [1, 2]
    }}
  ],
  "associations": [
    {{
      "target": 2,
      "reason": "why the new/revised source may have a direct relationship with DOCUMENT 2",
      "confidence": 0.0
    }}
  ]
}}

Rules:
- Use numeric DOCUMENT IDs only.
- Every trail must have at least two documents.
- Prefer several precise trails over broad catch-all categories.
- Shared geography, chronology, title words, or generic subject alone is weak.
- A document may remain untrailed.
- "associations" concerns DOCUMENT {queued_doc['id']} only.
- Association suggestions go directly to human review; there is no automated verifier.
- Confidence is the main model's own confidence in the suggestion.
- Zero association candidates is valid.
- Do not return an empty trail list if any defensible multi-document
  relationship exists.

SOURCE MEMORY:

{chr(10).join(bootstrap_docs)}
"""
    bootstrap_payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": bootstrap_prompt}],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": TEMPERATURE,
            "num_ctx": min(NUM_CTX, 32768),
        },
    }).encode()
    bootstrap_req = urllib.request.Request(
        OLLAMA,
        data=bootstrap_payload,
        headers={"Content-Type": "application/json"},
    )
    print(
        "Memex trail bootstrap",
        len(docs),
        "documents...",
        f"model={MODEL}",
    )
    with urllib.request.urlopen(
        bootstrap_req,
        timeout=TIMEOUT_SECONDS,
    ) as bootstrap_response:
        bootstrap_outer = json.loads(bootstrap_response.read().decode())
    result = parse_json_object(
        bootstrap_outer.get("message", {}).get("content", "")
    )
else:
    prompt = f"""
    You are discovering meaningful Memex trails across source documents.

    A MEMEX TRAIL is a conceptual traversal through documents that share a
    meaningful relationship. It is NOT merely a category, date-sorted list,
    search result, or collection of everything about the same town.

    Review the supplied document context together.

    DOCUMENT {queued_doc['id']} is the NEW OR REVISED source.

    Documents marked INDEX SUMMARY ONLY were already processed. Their maintained
    summaries are compact Memex memory; their full HedgeDoc content does not need
    to be read again.

    Review the conceptual set, focusing new analysis on DOCUMENT {queued_doc['id']}.
    Reconsider existing trails only where the new/revised evidence warrants it.

    TRAIL MODE:
    {trail_mode}

    Return the COMPLETE maintained trail set, not only trails related to the new
    document. Preserve existing valid trails from the CURRENT MEMEX INDEX.

    In BOOTSTRAP mode, actively reconstruct all strong multi-document trails that
    are evident from the supplied titles and summaries. Do not return an empty
    trail set merely because some documents do not fit a trail.

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

    3. A document may remain outside every trail when no meaningful relationship
       to another supplied document is supported. Never invent a weak catch-all
       relationship merely to avoid an untrailed document.

    4. Every trail must contain at least 2 documents. In BOOTSTRAP mode, return at
       least one trail whenever any defensible multi-document relationship exists.

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

    The top-level JSON field "associations" is REQUIRED, even when it is empty.
    It contains candidate direct relationships from the NEW OR REVISED source only:

    "associations": [
      {{
        "target": 2,
        "reason": "why the new/revised source may be directly associated with DOCUMENT 2",
        "confidence": 0.0
      }}
    ]

    Association candidate rules:
    - The source is implicitly DOCUMENT {queued_doc['id']}; return only target IDs.
    - A target must be another supplied DOCUMENT.
    - Zero candidates is valid: return "associations": [].
    - Do not create a candidate merely because two documents share a trail,
      broad topic, place category, chronology, title words, or keywords.
    - Propose a candidate only when the supplied evidence gives a concrete reason
      for a direct relationship.
    - Include confidence from 0.0 to 1.0 for each suggestion.
    - Suggestions go directly to human review. There is no automated verifier
      and Process Pending does not create canonical association edges.

    CURRENT MEMEX INDEX:
    Use this as navigation/context. The source documents below remain authoritative.

    {current_index}

    RECENT MEMEX LOG:
    {recent_log}

    The RECENT MEMEX LOG is operational history, not source evidence.
    Use it to understand recent ingests, queries, revision checks, and lint results.
    Do not create a trail or associated_with suggestion from log text alone.
    Evidence for maintained knowledge must come from the current index summaries
    and supplied source documents.

    SOURCE DOCUMENTS:

    {prompt_docs}
    """

    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": TEMPERATURE,
            "num_ctx": NUM_CTX
        }
    }).encode()

    req = urllib.request.Request(
        OLLAMA,
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    print("Memex reviewing", len(docs), "documents...", f"model={MODEL}")

    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as r:
        response = json.loads(r.read().decode())

    ollama_content = response.get("message", {}).get("content", "")
    result = parse_json_object(ollama_content)

if existing_trail_count == 0 and not result.get("trails"):
    print(
        "No trails returned during bootstrap; retrying trail discovery...",
        f"model={MODEL}",
    )
    retry_prompt = f"""
You are rebuilding an empty Memex trail catalogue.

Using ONLY the supplied compact source memory below, identify every strong,
useful relationship shared by TWO OR MORE documents.

Return JSON only:
{{
  "trails": [
    {{
      "name": "specific relationship name",
      "reason": "concrete relationship supported by the supplied documents",
      "confidence": 0.0,
      "members": [1, 2]
    }}
  ]
}}

Rules:
- Use numeric DOCUMENT IDs only.
- Every trail needs at least two documents.
- Prefer several precise trails over broad catch-all categories.
- Shared geography, chronology, or generic subject alone is insufficient.
- A document may remain untrailed.
- Do not return an empty list if any defensible multi-document relationship
  exists.

SOURCE MEMORY:

{chr(10).join(bootstrap_docs)}
"""
    retry_payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": retry_prompt}],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": TEMPERATURE,
            "num_ctx": NUM_CTX,
        },
    }).encode()
    retry_req = urllib.request.Request(
        OLLAMA,
        data=retry_payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(
        retry_req,
        timeout=TIMEOUT_SECONDS,
    ) as retry_response:
        retry_outer = json.loads(retry_response.read().decode())
    retry_result = parse_json_object(
        retry_outer.get("message", {}).get("content", "")
    )
    if isinstance(retry_result.get("trails"), list):
        result["trails"] = retry_result["trails"]

valid_ids = {d["id"] for d in docs}
alias_to_id = {d["alias"]: d["id"] for d in docs}


def parse_existing_index_trails(index_text):
    if "## Trails" not in index_text:
        return []

    section = index_text.split("## Trails", 1)[1]
    parsed = []
    current = None

    def finish():
        nonlocal current
        if current:
            current["members"] = list(dict.fromkeys(current["members"]))
            if len(current["members"]) >= 2:
                parsed.append(current)
        current = None

    for raw in section.splitlines():
        line = raw.strip()

        if line.startswith("### "):
            finish()
            current = {
                "name": line[4:].strip() or "Untitled Trail",
                "reason": "",
                "confidence": 0,
                "members": [],
            }
            continue

        if current is None or not line:
            continue

        if line.startswith("- [") and "](" in line:
            url = line.split("](", 1)[1].split(")", 1)[0]
            if "/n/" in url:
                alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]
                doc_id = alias_to_id.get(alias)
                if doc_id is not None:
                    current["members"].append(doc_id)
            continue

        if not current["reason"]:
            current["reason"] = line

    finish()
    return parsed


existing_trails = parse_existing_index_trails(current_index)
returned_trails = []

for trail in result.get("trails", []):
    members = [
        int(x) for x in trail.get("members", [])
        if isinstance(x, int) and x in valid_ids
    ]

    members = list(dict.fromkeys(members))

    if len(members) >= 2:
        returned_trails.append({
            "name": str(trail.get("name", "Untitled Trail")).strip(),
            "reason": str(trail.get("reason", "")).strip(),
            "confidence": trail.get("confidence", 0),
            "members": members,
        })

# Existing maintained trails are non-destructive memory. Returned trails update
# same-named trails; omitted trails remain while they still have two active
# members. This prevents a zero/partial LLM trail response from wiping history.
trail_by_name = {
    re.sub(r"\s+", " ", trail["name"]).strip().casefold(): trail
    for trail in existing_trails
}

for trail in returned_trails:
    key = re.sub(r"\s+", " ", trail["name"]).strip().casefold()
    trail_by_name[key] = trail

trails = list(trail_by_name.values())

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

raw_association_candidates = result.get("associations", [])
if not isinstance(raw_association_candidates, list):
    raise ValueError(
        'Ollama response must contain top-level "associations" array'
    )

association_suggestions = []
seen_target_ids = set()

for item in raw_association_candidates:
    if not isinstance(item, dict):
        continue

    try:
        target_id = int(item.get("target"))
    except (TypeError, ValueError):
        continue

    if (
        target_id == queued_doc["id"]
        or target_id not in id_to_doc
        or target_id in seen_target_ids
    ):
        continue

    reason = " ".join(str(item.get("reason", "")).split())
    if not reason:
        continue

    try:
        confidence = float(item.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    target_doc = id_to_doc[target_id]
    seen_target_ids.add(target_id)
    association_suggestions.append({
        "target": target_doc["alias"],
        "targetTitle": target_doc["title"],
        "reason": reason,
        "confidence": confidence,
    })

print(
    "LLM association suggestions:",
    f"candidates={len(association_suggestions)}",
    "automated-verifier=disabled",
)

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
description: "The configured Memex model maintains trails after reviewing queued HedgeDoc revisions."
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
    "Main-model association suggestions become human-review recommendations after successful lint; no automated verifier is used.",
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

# The canonical Memex network note is a lightweight presentation host.
# Trail membership and direct source associations are loaded dynamically by
# Memex mode from /memex-trails and /memex-associations. A unique refresh
# marker changes on every run so HedgeDoc records a new revision.
host_refresh_at = datetime.now(timezone.utc).isoformat()
new_nodebook = "\n".join(
    [
        "# Memex Network",
        "",
        "```memex",
        "Memex Association Network",
        "```",
        "",
        f"<!-- memex-refresh:{queued_alias}:{host_refresh_at} -->",
        "",
    ]
)

def build_candidate_index():
    summary_by_id = {}

    for item in result.get("documents", []):
        if not isinstance(item, dict):
            continue

        try:
            doc_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue

        summary = " ".join(str(item.get("summary", "")).split())
        if summary:
            summary_by_id[doc_id] = summary

    public_base = __import__("os").environ.get(
        "MEMEX_HEDGEDOC_BASE_URL",
        "http://192.168.1.142:8180",
    ).rstrip("/")

    index_lines = [
        "# Memex Index",
        "",
        "Content-oriented index maintained after successful Memex processing.",
        "",
        "## Sources",
        "",
    ]

    for doc in docs:
        summary = summary_by_id.get(
            doc["id"],
            doc.get("summary") or f"Source note: {doc['title']}.",
        )
        url = f"{public_base}/n/{doc['alias']}"
        index_lines.append(f"- [{doc['title']}]({url}) — {summary}")

    index_lines.extend(["", "## Trails", ""])

    doc_by_id = {doc["id"]: doc for doc in docs}

    for trail in trails:
        index_lines.append(f"### {trail['name']}")

        if trail.get("reason"):
            index_lines.extend(["", trail["reason"]])

        index_lines.append("")

        for doc_id in trail["members"]:
            doc = doc_by_id.get(doc_id)
            if doc:
                url = f"{public_base}/n/{doc['alias']}"
                index_lines.append(f"- [{doc['title']}]({url})")

        index_lines.append("")

    return "\n".join(index_lines).rstrip() + "\n"


candidate_index = ensure_index_labels(build_candidate_index())

# Keep the previous index and canonical host so a failed lint cannot damage
# the accepted Memex state.
old_index = current_index
old_nodebook = api_get(f"{NODEBOOK}/content")
before = json.loads(api_get(f"{NODEBOOK}/revisions"))
before_uuid = max(before, key=lambda x: x["createdAt"])["uuid"]

# Lint validates the candidate index and canonical Memex host together.
INDEX_PATH.write_text(candidate_index, encoding="utf-8")

try:
    status = api_put(NODEBOOK, new_nodebook)
except Exception:
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    raise

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
    print("Lint failed; restoring previous index and Memex host...")
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    api_put(NODEBOOK, old_nodebook)
    raise SystemExit(
        f"Memex lint rejected {queued_alias}; "
        "previous nodeBook restored; queue item remains pending"
    )

# Main-model association suggestions become recommendations only after the
# candidate index/nodeBook state passes lint. There is no automated verifier.
# Canonical graph mutation remains a separate human Accept action.
try:
    recommendation_sync = append_association_recommendations(
        queued_doc,
        association_suggestions,
        pending,
    )
except Exception as exc:
    print(
        "Association recommendation write failed; restoring previous index and Memex host...",
        file=__import__("sys").stderr,
    )
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    api_put(NODEBOOK, old_nodebook)
    raise SystemExit(
        f"Memex association recommendation rejected {queued_alias}: {exc}; "
        "previous index/nodeBook restored; queue item remains pending"
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
print(
    "Association recommendations:",
    f"added={recommendation_sync['added']}",
    f"pending={recommendation_sync['pending']}",
)
print("association review store:", RECOMMENDATIONS_FILE)
print("main model:", MODEL)
print("association verifier: disabled; human review is authoritative")
print("trail mode:", trail_mode)
if existing_trail_count == 0:
    print("full maintenance prompt: skipped during empty-index bootstrap")


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

_final_index = ensure_index_labels("\n".join(_index).rstrip() + "\n")
INDEX_PATH.write_text(_final_index, encoding="utf-8")

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
        f"- LLM associated_with suggestions: {len(association_suggestions)}\n"
        f"- index read by LLM: yes\n"
        f"- recent log entries supplied to LLM: {recent_log_entry_count}\n"
        f"- LLM called: yes\n"
        f"- main model: `{MODEL}`\n"
        f"- association verifier: disabled; human review authoritative\n"
        f"- nodeBook: `{NODEBOOK}`\n"
        f"- summary: {_summary or 'No summary returned.'}\n\n"
    )

sync_readonly_mirror("memex-index", INDEX_PATH)
sync_readonly_mirror("memex-log", LOG_PATH)

print("index:", INDEX_PATH)
print("log:", LOG_PATH)
