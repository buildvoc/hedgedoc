#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

HD = Path("/data/projects/hedgedoc")
QUEUE = HD / "memex/queue.jsonl"
PROCESS_ONCE = HD / "memex/process_queue_once.py"

def pending_count():
    if not QUEUE.exists():
        return 0

    count = 0
    for line in QUEUE.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("status") == "pending":
            count += 1
    return count

print("=== MEMEX QUEUE DRAIN START ===", flush=True)

while True:
    before = pending_count()

    if before == 0:
        print("=== MEMEX QUEUE DRAIN COMPLETE ===", flush=True)
        sys.exit(0)

    print(f"Pending before run: {before}", flush=True)

    result = subprocess.run(
        [sys.executable, str(PROCESS_ONCE)],
        cwd=str(HD),
        env=os.environ.copy(),
    )

    if result.returncode != 0:
        print(
            f"ERROR: process_queue_once.py exited {result.returncode}",
            flush=True,
        )
        sys.exit(result.returncode)

    after = pending_count()
    print(f"Pending after run: {after}", flush=True)

    if after >= before:
        print(
            "ERROR: queue made no progress; stopping to avoid loop",
            flush=True,
        )
        sys.exit(1)
