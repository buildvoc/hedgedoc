Use the Python patcher if git apply --check fails because the local file has unrelated edits.

Recommended:
  cd /data/projects/hedgedoc
  python3 apply-process-pending-fix-v2.py

Alternative:
  git apply --check process-pending-cancelled-transaction-fix-v2-2026-08-23.patch
  git apply process-pending-cancelled-transaction-fix-v2-2026-08-23.patch

Then:
  python3 -m py_compile memex/process_queue_once.py
