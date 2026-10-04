Memex Karpathy index/log conformance v2
========================================

The v1 transformer failed because it expected `{current_index}` and
`{prompt_docs}` to be adjacent. The already-applied `associated_with` patch
inserts association instructions between those prompt sections.

The v1 error occurred before the transformer wrote process_queue_once.py.
The ZIP extraction did already place memex/wiki_log.py and memex/log_query.py;
that is harmless. v2 validates and overwrites those helpers consistently.

v2 finds the main `prompt = f"""..."""` block and inserts RECENT MEMEX LOG
immediately before the single `{prompt_docs}` placeholder. It therefore
preserves the existing associated_with candidate instructions.

Apply:

  cd /data/projects/hedgedoc || exit 1
  unzip -o memex-karpathy-index-log-conformance-v2-2026-08-24.zip
  python3 apply-memex-karpathy-index-log-v2.py

Then:

  grep -nE \
    'KARPATHY_INDEX_LOG_CONTEXT|RECENT MEMEX LOG|recent log entries supplied' \
    memex/process_queue_once.py

Do not commit until one real pending source passes Process Pending.
