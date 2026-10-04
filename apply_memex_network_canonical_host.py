#!/usr/bin/env python3
from pathlib import Path
import re
import shutil
from datetime import datetime, timezone

ROOT = Path.cwd()
if not (ROOT / "memex/process_queue_once.py").exists():
    raise SystemExit("Run this from /data/projects/hedgedoc")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

def backup(path: Path):
    dst = path.with_name(path.name + f".before-memex-host-{stamp}")
    shutil.copy2(path, dst)
    print(f"backup: {dst}")

def replace_once(text, old, new, label):
    if old not in text:
        if new in text:
            print(f"already patched: {label}")
            return text
        raise SystemExit(f"ERROR: expected source not found for {label}")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"ERROR: expected one match for {label}, found {count}")
    print(f"patch: {label}")
    return text.replace(old, new, 1)

# 1) Process Pending -> canonical memex-network host.
p = ROOT / "memex/process_queue_once.py"
text = p.read_text(encoding="utf-8")
original = text

text = replace_once(
    text,
    'NODEBOOK = "liphook-free-trails-20260815-082925"',
    'NODEBOOK = "memex-network"',
    "process_queue_once NODEBOOK alias",
)

old_assign = 'new_nodebook = "\\n".join(body)'
new_assign = r'''# The canonical Memex network note is a lightweight presentation host.
# Trail membership and direct source associations are loaded dynamically by
# Memex mode from /memex-trails and /memex-associations. A unique refresh
# marker changes on every run so HedgeDoc records a new revision.
host_refresh_at = datetime.now(timezone.utc).isoformat()
new_nodebook = "\n".join(
    [
        "---",
        "okf_type: Index",
        'title: "Memex Network"',
        'description: "Canonical Memex presentation host; trail and association data are loaded dynamically."',
        "tags:",
        "  - memex",
        "status: stable",
        f'updated: "{host_refresh_at}"',
        "---",
        "",
        "# Memex Network",
        "",
        "```memex",
        "```",
        "",
        f"<!-- memex-refresh:{queued_alias}:{host_refresh_at} -->",
        "",
    ]
)'''
text = replace_once(
    text,
    old_assign,
    new_assign,
    "process_queue_once canonical memex host body",
)

text = text.replace(
    "# Generated nodeBook is output, never input.",
    "# Canonical memex-network host is output, never a queued source.",
)
text = text.replace(
    "# Keep both previous generated outputs so a failed lint cannot damage the\n# accepted Memex state.",
    "# Keep the previous index and canonical host so a failed lint cannot damage\n# the accepted Memex state.",
)
text = text.replace(
    "# Lint must validate the candidate index and candidate nodeBook together.",
    "# Lint validates the candidate index and canonical Memex host together.",
)
text = text.replace(
    'print("Lint failed; restoring previous index and nodeBook...")',
    'print("Lint failed; restoring previous index and Memex host...")',
)
text = text.replace(
    'f"previous nodeBook restored; queue item remains pending"',
    'f"previous Memex host restored; queue item remains pending"',
)
text = text.replace(
    '"Association sync failed; restoring previous index and nodeBook...",',
    '"Association sync failed; restoring previous index and Memex host...",',
)

if text != original:
    backup(p)
    p.write_text(text, encoding="utf-8")

# 2) Lint -> structured index membership + canonical memex fence.
p = ROOT / "memex/lint_memex.py"
text = p.read_text(encoding="utf-8")
original = text

text = replace_once(
    text,
    "nodebook = find_nodebook(rows)",
    'nodebook = "memex-network"',
    "lint canonical host alias",
)

old_missing = '''for alias in sorted(active - index_set):
    warnings.append(f"active source missing from index: {alias}")
'''
new_missing = '''# In structured Memex, active sources absent from index.md are hard orphans.
'''
text = replace_once(
    text,
    old_missing,
    new_missing,
    "lint active source membership",
)

pattern = re.compile(
    r'graph_aliases = set\(\)\nconnected_aliases = set\(\)\n\n'
    r'if not nodebook:.*?'
    r'if "orphans" not in locals\(\):\n    orphans = sorted\(active\)\n',
    re.S,
)

replacement = r'''# Structured Memex no longer validates a generated CNL/nodeBook graph.
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
'''

m = pattern.search(text)
if not m:
    if "Structured Memex no longer validates a generated CNL/nodeBook graph." in text:
        print("already patched: lint structured validation")
    else:
        raise SystemExit("ERROR: legacy lint graph-validation block not found")
else:
    print("patch: lint structured validation")
    text = text[:m.start()] + replacement + text[m.end():]

if text != original:
    backup(p)
    p.write_text(text, encoding="utf-8")

# 3) Disable legacy watcher in either startup layer.
outer = ROOT / "start-hedgedoc-nodebook-dev.sh"
if outer.exists():
    text = outer.read_text(encoding="utf-8")
    original = text
    watcher = '''if [[ -n "${MEMEX_API_TOKEN:-}" ]]; then
    echo "=== Starting Memex watcher ==="
    cd "$HD"
    python3 -u scripts/memex-watch.py &
    PIDS+=("$!")
else
    echo "MEMEX_API_TOKEN not set - Memex watcher not started"
fi
'''
    if watcher in text:
        text = text.replace(
            watcher,
            '''echo "=== Legacy Memex watcher disabled ==="
echo "memex-network is maintained as a structured Memex presentation host"
''',
            1,
        )
        print("patch: disable watcher in combined service")
    else:
        print("watcher block absent in combined service (ok)")
    if text != original:
        backup(outer)
        outer.write_text(text, encoding="utf-8")

inner = ROOT / "start-hedgedoc-wiki-dev.sh"
if inner.exists():
    text = inner.read_text(encoding="utf-8")
    original = text
    prefix = '''# Memex Mermaid watcher
set -a
. ./.env
set +a
mkdir -p memex
python3 scripts/memex-watch.py >> memex/watch.log 2>&1 &
MEMEX_WATCH_PID=$!
trap 'kill "$MEMEX_WATCH_PID" 2>/dev/null || true' EXIT
'''
    if prefix in text:
        text = text.replace(prefix, "", 1)
        print("patch: disable watcher in HedgeDoc startup")
    else:
        print("watcher prefix absent in HedgeDoc startup (ok)")
    if text != original:
        backup(inner)
        inner.write_text(text, encoding="utf-8")

# 4) Install one-shot host refresher.
src = ROOT / "scripts/refresh-memex-network-host.py"
payload = Path(__file__).resolve().parent / "scripts/refresh-memex-network-host.py"
if payload.resolve() != src.resolve():
    if src.exists():
        backup(src)
    shutil.copy2(payload, src)
    src.chmod(0o755)
    print(f"installed: {src}")

print()
print("PATCH OK")
