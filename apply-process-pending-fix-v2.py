#!/usr/bin/env python3
from pathlib import Path
import shutil, py_compile

path = Path("memex/process_queue_once.py")
if not path.exists():
    raise SystemExit("ERROR: run from /data/projects/hedgedoc")

text = path.read_text(encoding="utf-8")
original = text

def rep(old, new, label):
    global text
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"ERROR: {label}: expected 1 match, found {n}")
    text = text.replace(old, new, 1)


rep('rows = [\n    json.loads(x)\n    for x in QUEUE.read_text().splitlines()\n    if x.strip()\n]\n\npending = next(\n    (x for x in reversed(rows) if x.get("status") == "pending"),\n    None\n)\n', 'rows = [\n    json.loads(x)\n    for x in QUEUE.read_text().splitlines()\n    if x.strip()\n]\n\n# Latest queue state is authoritative. A source that was processed and later\n# cancelled must not be fed back into the maintained index/graph.\nlatest_by_alias = {}\nfor row in rows:\n    alias = row.get("alias")\n    if alias:\n        latest_by_alias[alias] = row\n\ncancelled_aliases = {\n    alias\n    for alias, row in latest_by_alias.items()\n    if row.get("status") == "cancelled"\n}\n\npending = next(\n    (x for x in reversed(rows) if x.get("status") == "pending"),\n    None\n)\n', 'change 1')

rep('def processed_revision(alias):\n    for row in reversed(rows):\n        if (\n            row.get("alias") == alias\n            and row.get("status") == "processed"\n            and row.get("sourceRevision")\n        ):\n            return row["sourceRevision"]\n    return None\n', 'def processed_revision(alias):\n    for row in reversed(rows):\n        if row.get("alias") != alias:\n            continue\n\n        if row.get("status") == "cancelled":\n            return None\n\n        if row.get("status") == "processed" and row.get("sourceRevision"):\n            return row["sourceRevision"]\n\n    return None\n', 'change 2')

rep('        alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]\n\n        if not alias or alias in {queued_alias, NODEBOOK}:\n            continue\n\n        index_sources.append({\n', '        alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]\n\n        if (\n            not alias\n            or alias in {queued_alias, NODEBOOK}\n            or alias in cancelled_aliases\n        ):\n            continue\n\n        index_sources.append({\n', 'change 3')

rep('new_nodebook = "\\n".join(body)\n\n# Keep the previous generated view so a failed lint cannot damage the graph.\nold_nodebook = api_get(f"{NODEBOOK}/content")\nbefore = json.loads(api_get(f"{NODEBOOK}/revisions"))\nbefore_uuid = max(before, key=lambda x: x["createdAt"])["uuid"]\n\nstatus = api_put(NODEBOOK, new_nodebook)\n\n# MEMEX_ORPHAN_LINT_GATE\n', 'new_nodebook = "\\n".join(body)\n\ndef build_candidate_index():\n    summary_by_id = {}\n\n    for item in result.get("documents", []):\n        if not isinstance(item, dict):\n            continue\n\n        try:\n            doc_id = int(item.get("id"))\n        except (TypeError, ValueError):\n            continue\n\n        summary = " ".join(str(item.get("summary", "")).split())\n        if summary:\n            summary_by_id[doc_id] = summary\n\n    public_base = __import__("os").environ.get(\n        "MEMEX_HEDGEDOC_BASE_URL",\n        "http://192.168.1.142:8180",\n    ).rstrip("/")\n\n    index_lines = [\n        "# Memex Index",\n        "",\n        "Content-oriented index maintained after successful Memex processing.",\n        "",\n        "## Sources",\n        "",\n    ]\n\n    for doc in docs:\n        summary = summary_by_id.get(\n            doc["id"],\n            doc.get("summary") or f"Source note: {doc[\'title\']}.",\n        )\n        url = f"{public_base}/n/{doc[\'alias\']}"\n        index_lines.append(f"- [{doc[\'title\']}]({url}) — {summary}")\n\n    index_lines.extend(["", "## Trails", ""])\n\n    doc_by_id = {doc["id"]: doc for doc in docs}\n\n    for trail in trails:\n        index_lines.append(f"### {trail[\'name\']}")\n\n        if trail.get("reason"):\n            index_lines.extend(["", trail["reason"]])\n\n        index_lines.append("")\n\n        for doc_id in trail["members"]:\n            doc = doc_by_id.get(doc_id)\n            if doc:\n                url = f"{public_base}/n/{doc[\'alias\']}"\n                index_lines.append(f"- [{doc[\'title\']}]({url})")\n\n        index_lines.append("")\n\n    return "\\n".join(index_lines).rstrip() + "\\n"\n\n\ncandidate_index = build_candidate_index()\n\n# Keep both previous generated outputs so a failed lint cannot damage the\n# accepted Memex state.\nold_index = current_index\nold_nodebook = api_get(f"{NODEBOOK}/content")\nbefore = json.loads(api_get(f"{NODEBOOK}/revisions"))\nbefore_uuid = max(before, key=lambda x: x["createdAt"])["uuid"]\n\n# Lint must validate the candidate index and candidate nodeBook together.\nINDEX_PATH.write_text(candidate_index, encoding="utf-8")\n\ntry:\n    status = api_put(NODEBOOK, new_nodebook)\nexcept Exception:\n    INDEX_PATH.write_text(old_index, encoding="utf-8")\n    raise\n\n# MEMEX_ORPHAN_LINT_GATE\n', 'change 4')

rep('if _lint_result.returncode != 0:\n    print("Lint failed; restoring previous nodeBook...")\n    api_put(NODEBOOK, old_nodebook)\n    raise SystemExit(\n        f"Memex lint rejected {queued_alias}; "\n        "previous nodeBook restored; queue item remains pending"\n    )\n', 'if _lint_result.returncode != 0:\n    print("Lint failed; restoring previous index and nodeBook...")\n    INDEX_PATH.write_text(old_index, encoding="utf-8")\n    api_put(NODEBOOK, old_nodebook)\n    raise SystemExit(\n        f"Memex lint rejected {queued_alias}; "\n        "previous nodeBook restored; queue item remains pending"\n    )\n', 'change 5')

backup = Path("/tmp/process_queue_once.py.before-process-pending-fix")
shutil.copy2(path, backup)
path.write_text(text, encoding="utf-8")
try:
    py_compile.compile(str(path), doraise=True)
except Exception:
    path.write_text(original, encoding="utf-8")
    raise
print("PATCHED")
print("SYNTAX OK")
print("BACKUP:", backup)
