#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

QUEUE = Path("memex/queue.jsonl")
INDEX = Path("memex/index.md")
LOG = Path("memex/log.md")

API = "http://127.0.0.1:3100/api/v2"
TOKEN = os.environ.get("MEMEX_API_TOKEN", "")


def read_queue():
    if not QUEUE.exists():
        return []

    return [
        json.loads(line)
        for line in QUEUE.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def latest_by_alias(rows):
    latest = {}
    for row in rows:
        alias = row.get("alias")
        if alias:
            latest[alias] = row
    return latest


def find_nodebook(rows):
    for row in reversed(rows):
        nodebook = row.get("nodeBook")
        if nodebook:
            return nodebook
    return None


def api_get(alias):
    req = urllib.request.Request(
        f"{API}/notes/{alias}/content",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode("utf-8")


def api_put(alias, content):
    req = urllib.request.Request(
        f"{API}/notes/{alias}",
        data=content.encode(),
        method="PUT",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/markdown",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.status


def sync_readonly_mirror(alias, path):
    if not TOKEN:
        print(f"WARNING: MEMEX_API_TOKEN missing; {alias} revision mirror not synced")
        return
    try:
        api_put(alias, path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"WARNING: failed to sync {alias} revision mirror: {exc}")


def parse_index_sources(text):
    if "## Sources" not in text:
        return []

    section = text.split("## Sources", 1)[1]

    if "## Trails" in section:
        section = section.split("## Trails", 1)[0]

    aliases = []
    for line in section.splitlines():
        match = re.search(r"\]\([^)]*/n/([^?#)]+)", line)
        if match:
            aliases.append(match.group(1))

    return aliases


def parse_graph(content):
    graph_aliases = set()
    connected_aliases = set()
    edge_targets = set()

    blocks = re.split(r"(?=^# )", content, flags=re.MULTILINE)

    for block in blocks:
        alias_match = re.search(
            r"^alias:\s*([^;\n]+);",
            block,
            re.MULTILINE,
        )

        if not alias_match:
            continue

        alias = alias_match.group(1).strip()
        graph_aliases.add(alias)

        # Explicit trail membership means this page is semantically connected.
        if re.search(r"^trail:\s*[^;\n]+;", block, re.MULTILINE):
            connected_aliases.add(alias)

        targets = re.findall(
            r"^<[^>]+>.*?·\s*([^;\n]+);",
            block,
            re.MULTILINE,
        )

        if targets:
            connected_aliases.add(alias)

            for target in targets:
                target = target.strip()
                connected_aliases.add(target)
                edge_targets.add(target)

    return graph_aliases, connected_aliases, edge_targets


parser = argparse.ArgumentParser()
parser.add_argument(
    "--include-alias",
    action="append",
    default=[],
    help="Treat an alias as active during pre-completion lint.",
)
parser.add_argument(
    "--repair-orphans",
    action="store_true",
    help="Find orphan pages, queue one orphan-repair job, process it, then lint again.",
)
args = parser.parse_args()

rows = read_queue()
latest = latest_by_alias(rows)
nodebook = "memex-network"

errors = []
warnings = []

if not INDEX.exists():
    errors.append("memex/index.md is missing")
    index_text = ""
else:
    index_text = INDEX.read_text(encoding="utf-8")

index_aliases = parse_index_sources(index_text)
index_set = set(index_aliases)

# Latest queue state is authoritative.
active = {
    alias
    for alias, row in latest.items()
    if row.get("status") == "processed"
    and alias != nodebook
}

# During process_queue_once.py the new source is still pending when lint runs.
# Explicitly include it so an unconnected new source cannot pass the gate.
active.update(
    alias
    for alias in args.include_alias
    if alias and alias != nodebook
)

cancelled = {
    alias
    for alias, row in latest.items()
    if row.get("status") == "cancelled"
}

duplicates = sorted({
    alias
    for alias in index_aliases
    if index_aliases.count(alias) > 1
})

for alias in duplicates:
    errors.append(f"duplicate index source: {alias}")

if nodebook and nodebook in index_set:
    errors.append(f"nodeBook appears as source in index: {nodebook}")

for alias in sorted(index_set & cancelled):
    errors.append(f"cancelled source remains in index: {alias}")

# In structured Memex, active sources absent from index.md are hard orphans.

# Structured Memex no longer validates a generated CNL/nodeBook graph.
# /memex-network is only the presentation host. Every active source must be
# present in index.md, which is the maintained trail-membership state.
graph_aliases = set(index_set)
connected_aliases = set(index_set)
edge_targets = set()

orphans = sorted(active - index_set)
for alias in orphans:
    errors.append(f"orphan page: {alias}")

if not TOKEN:
    errors.append("MEMEX_API_TOKEN not loaded; cannot lint memex-network host")
else:
    try:
        content = api_get(nodebook)

        if "```memex" not in content:
            errors.append("memex-network is missing the canonical memex fence")

        if "```nodeBook" in content or "```nodebook" in content:
            errors.append("memex-network contains legacy generated nodeBook content")

        if nodebook in index_set:
            errors.append(f"Memex host appears as source in index: {nodebook}")

    except urllib.error.HTTPError as exc:
        errors.append(f"cannot read Memex host {nodebook}: HTTP {exc.code}")

    except Exception as exc:
        errors.append(f"cannot validate Memex host {nodebook}: {exc}")

status = "FAIL" if errors else "PASS"
stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

print("=== MEMEX LINT ===")
print("status:", status)
print("active sources:", len(active))
print("indexed sources:", len(index_set))
print("graph sources:", len(graph_aliases))
print("connected sources:", len(connected_aliases))
print("orphan pages:", len(orphans))

if errors:
    print("\nERRORS")
    for item in errors:
        print(" -", item)

if warnings:
    print("\nWARNINGS")
    for item in warnings:
        print(" -", item)

if not LOG.exists():
    LOG.write_text("# Memex Log\n\n", encoding="utf-8")

with LOG.open("a", encoding="utf-8") as fh:
    fh.write(
        f"## [{stamp}] lint | Memex orphan invariant\n\n"
        f"- status: {status}\n"
        f"- active sources: {len(active)}\n"
        f"- indexed sources: {len(index_set)}\n"
        f"- graph sources: {len(graph_aliases)}\n"
        f"- connected sources: {len(connected_aliases)}\n"
        f"- orphan pages: {len(orphans)}\n"
        f"- errors: {len(errors)}\n"
        f"- warnings: {len(warnings)}\n"
        f"- LLM called: no\n\n"
    )

sync_readonly_mirror("memex-log", LOG)

if args.repair_orphans and orphans:
    # Only auto-repair orphan failures. Other structural failures need
    # intervention before we let the LLM rewrite the graph.
    non_orphan_errors = [
        error
        for error in errors
        if not error.startswith("orphan page: ")
    ]

    if non_orphan_errors:
        print("\nOrphan repair not started because other lint errors exist.")
        sys.exit(1)

    import subprocess
    import uuid

    target = orphans[0]

    rows = read_queue()
    latest = latest_by_alias(rows)
    current = latest.get(target, {})

    if not (
        current.get("status") == "pending"
        and current.get("queueReason") == "orphan-repair"
    ):
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")

        repair = {
            "id": str(uuid.uuid4()),
            "alias": target,
            "queuedAt": now,
            "status": "pending",
            "queueReason": "orphan-repair",
            "repairTargets": orphans,
        }

        with QUEUE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(repair) + "\n")

        print(f"\nQueued orphan repair: {target}")
        print(f"Repair targets: {len(orphans)}")
    else:
        print(f"\nUsing existing orphan repair: {target}")

    processor = Path(__file__).with_name("process_queue_once.py")

    print("\n=== PROCESS ORPHAN REPAIR ===")
    result = subprocess.run(
        [sys.executable, str(processor)],
        cwd=str(Path(__file__).resolve().parents[1]),
    )

    if result.returncode != 0:
        print("\nOrphan repair failed; queue item remains pending.")
        sys.exit(result.returncode)

    print("\n=== VERIFY AFTER REPAIR ===")
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve())],
        cwd=str(Path(__file__).resolve().parents[1]),
    )

    sys.exit(result.returncode)

sys.exit(1 if errors else 0)
