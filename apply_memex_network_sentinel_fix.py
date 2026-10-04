#!/usr/bin/env python3
from pathlib import Path
import shutil
from datetime import datetime, timezone

ROOT = Path.cwd()
if not (ROOT / "memex/process_queue_once.py").exists():
    raise SystemExit("Run from /data/projects/hedgedoc")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

def patch_file(path: Path):
    text = path.read_text(encoding="utf-8")
    old = '''        "```memex",
        "```",'''
    new = '''        "```memex",
        "Memex Association Network",
        "```",'''
    if new in text:
        print(f"already patched: {path}")
        return
    if old not in text:
        raise SystemExit(f"ERROR: expected empty memex fence not found in {path}")
    backup = path.with_name(path.name + f".before-memex-sentinel-{stamp}")
    shutil.copy2(path, backup)
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {path}")
    print(f"backup:  {backup}")

patch_file(ROOT / "memex/process_queue_once.py")
patch_file(ROOT / "scripts/refresh-memex-network-host.py")
print("PATCH OK")
