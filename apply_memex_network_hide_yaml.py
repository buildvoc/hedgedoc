#!/usr/bin/env python3
from pathlib import Path
import shutil
from datetime import datetime, timezone

ROOT = Path.cwd()
if not (ROOT / "memex/process_queue_once.py").exists():
    raise SystemExit("Run from /data/projects/hedgedoc")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

OLD = '''        "---",
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
'''

NEW = '''        "# Memex Network",
'''

OLD_REFRESH = '''        "---",
        "okf_type: Index",
        'title: "Memex Network"',
        'description: "Canonical Memex presentation host; trail and association data are loaded dynamically."',
        "tags:",
        "  - memex",
        "status: stable",
        f'updated: "{stamp}"',
        "---",
        "",
        "# Memex Network",
'''

NEW_REFRESH = '''        "# Memex Network",
'''

def patch(path: Path, old: str, new: str):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        if new in text:
            print(f"already patched: {path}")
            return
        raise SystemExit(f"ERROR: expected canonical-host block not found in {path}")
    backup = path.with_name(path.name + f".before-hide-yaml-{stamp}")
    shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {path}")
    print(f"backup:  {backup}")

patch(ROOT / "memex/process_queue_once.py", OLD, NEW)
patch(ROOT / "scripts/refresh-memex-network-host.py", OLD_REFRESH, NEW_REFRESH)
print("PATCH OK")
