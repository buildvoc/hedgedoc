Memex — Karpathy index.md / log.md conformance patch
======================================================

Reference:
https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f#indexing-and-logging

Reviewed supplied files
-----------------------
index.md
- 55 source catalog entries
- 15 trail headings
- title + link + one-line summary is already present for almost all sources
- 2 source entries have blank display titles; this patch prevents blank labels
  on the next successful index rebuild by falling back to the canonical alias

log.md
- 148 chronological entries
- 62 ingest entries
- 54 lint entries
- 32 revision-check entries
- 0 query entries
- about 50 KB total
- the newest 12 complete entries are about 4 KB

Patch behavior
--------------
1. process_queue_once.py reads recent memex/log.md before Gemma processing.
2. CURRENT MEMEX INDEX stays first in the LLM prompt.
3. A bounded RECENT MEMEX LOG follows the index and precedes source documents.
4. The prompt explicitly says log history is operational context, not evidence.
5. Defaults:
     MEMEX_RECENT_LOG_ENTRIES=12
     MEMEX_RECENT_LOG_MAX_CHARS=12000
6. Ingest records state:
     - index read by LLM: yes
     - recent log entries supplied to LLM: N
7. The index writer guarantees a nonblank source label.
8. memex/wiki_log.py provides append-only log helpers.
9. memex/log_query.py provides an explicit query logging hook using:
     ## [timestamp] query | subject

Scope note
----------
The current Memex stack does not expose a general "Ask the wiki" Q&A endpoint.
Therefore graph search/filter keystrokes are deliberately NOT logged as
Karpathy-style query events. Actual agent/CLI/API knowledge-query workflows
should call memex/log_query.py or import append_query() from wiki_log.py.

Apply
-----
Copy the ZIP into /data/projects/hedgedoc, then:

  cd /data/projects/hedgedoc || exit 1
  unzip -o memex-karpathy-index-log-conformance-2026-08-24.zip
  python3 apply-memex-karpathy-index-log.py

Validate
--------
  cd /data/projects/hedgedoc || exit 1

  python3 -m py_compile \
    memex/process_queue_once.py \
    memex/wiki_log.py \
    memex/log_query.py

  grep -nE \
    'KARPATHY_INDEX_LOG_CONTEXT|RECENT MEMEX LOG|recent log entries supplied' \
    memex/process_queue_once.py

Test the query logger without calling an LLM:

  python3 memex/log_query.py \
    "Which records directly document Willmer House?" \
    --llm-called no \
    --via validation \
    --status partial \
    --summary "Query-log hook validation only"

  grep '^## \[' memex/log.md | tail -5

Then process ONE real pending source through Process Pending. Its ingest entry
should contain:

  - index read by LLM: yes
  - recent log entries supplied to LLM: <N>

After the successful ingest:

  grep -n '^- \[\](' memex/index.md || echo "NO BLANK INDEX TITLES"

Do not commit runtime state files merely because of this code patch:
  memex/index.md
  memex/log.md
  memex/queue.jsonl

After successful validation, commit only code:

  git add \
    memex/process_queue_once.py \
    memex/wiki_log.py \
    memex/log_query.py

  git commit --only \
    memex/process_queue_once.py \
    memex/wiki_log.py \
    memex/log_query.py \
    -m "Align Memex index and log workflow with LLM wiki pattern"
