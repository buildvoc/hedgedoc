#!/usr/bin/env python3
from pathlib import Path
import shutil
from datetime import datetime, timezone

ROOT = Path.cwd()
if not (ROOT / "frontend/src").exists():
    raise SystemExit("Run from /data/projects/hedgedoc")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
payload = Path(__file__).resolve().parent

def backup(path: Path):
    dst = path.with_name(path.name + f".before-memex-readonly-{stamp}")
    shutil.copy2(path, dst)
    print(f"backup: {dst}")

def install_file(rel: str):
    src = payload / rel
    dst = ROOT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        if src.exists() and dst.exists() and src.samefile(dst):
            print(f"already installed: {dst}")
            return
    except FileNotFoundError:
        pass
    if dst.exists():
        backup(dst)
    shutil.copy2(src, dst)
    print(f"installed: {dst}")

install_file("frontend/src/app/memex-index/page.tsx")
install_file("frontend/src/app/memex-log/page.tsx")

target = ROOT / "frontend/src/components/explore-page/explore-notes-section/explore-notes-section.tsx"
text = target.read_text(encoding="utf-8")

old = "{mode === Mode.MY_NOTES && memexFilter === 'pending' && <ProcessMemexQueueButton />}"
new = """{mode === Mode.MY_NOTES && memexFilter === 'pending' && (
          <div className='d-flex align-items-center gap-2 flex-wrap'>
            <ProcessMemexQueueButton />
            <a className='btn btn-outline-secondary btn-sm' href='/memex-index'>
              Index
            </a>
            <a className='btn btn-outline-secondary btn-sm' href='/memex-log'>
              Log
            </a>
          </div>
        )}"""

if new in text:
    print("explore pending links already patched")
elif old in text:
    backup(target)
    target.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {target}")
else:
    raise SystemExit("ERROR: Process Pending mount point not found")

print("PATCH OK")
