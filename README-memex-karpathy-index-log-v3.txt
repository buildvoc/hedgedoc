Memex Karpathy index/log conformance v3
========================================

v3 is built against the exact live processor anchors pasted on 2026-08-24.

v1 failed on an old prompt layout. v2 selected the first prompt in the file,
which is the separate full-content association verifier. Both failed before
process_queue_once.py was written.

v3 preserves the association verifier and patches the confirmed main prompt.
It supplies bounded recent log history, normalizes blank index labels before
lint and in the final index, records memory use in ingest logs, and installs
the query logging hook.

Apply:
  cd /data/projects/hedgedoc || exit 1
  unzip -o memex-karpathy-index-log-conformance-v3-2026-08-24.zip
  python3 apply-memex-karpathy-index-log-v3.py

Verify:
  grep -nE 'KARPATHY_INDEX_LOG_CONTEXT|RECENT MEMEX LOG|recent log entries supplied|ensure_index_labels' memex/process_queue_once.py

Then process ONE real pending source before committing.
