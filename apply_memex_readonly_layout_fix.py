#!/usr/bin/env python3
from pathlib import Path
import shutil

ROOT = Path.cwd()
if not (ROOT / "frontend/src/app").exists():
    raise SystemExit("Run from /data/projects/hedgedoc")

pairs = [
    ("frontend/src/app/memex-index/page.tsx",
     "frontend/src/app/(editor)/memex-index/page.tsx"),
    ("frontend/src/app/memex-log/page.tsx",
     "frontend/src/app/(editor)/memex-log/page.tsx"),
]

for old_rel, new_rel in pairs:
    old = ROOT / old_rel
    new = ROOT / new_rel
    new.parent.mkdir(parents=True, exist_ok=True)

    if old.exists():
        if new.exists():
            new.unlink()
        shutil.move(str(old), str(new))
        print(f"moved: {old_rel} -> {new_rel}")
        try:
            old.parent.rmdir()
        except OSError:
            pass
    elif new.exists():
        print(f"already moved: {new_rel}")
    else:
        raise SystemExit(f"ERROR: missing both {old_rel} and {new_rel}")

print("PATCH OK")
