#!/usr/bin/env python3
from pathlib import Path
import py_compile
import shutil

PROCESSOR = Path("memex/process_queue_once.py")
WIKI_LOG = Path("memex/wiki_log.py")
LOG_QUERY = Path("memex/log_query.py")
MARKER = "KARPATHY_INDEX_LOG_CONTEXT"

if not PROCESSOR.exists(): raise SystemExit("ERROR: run from /data/projects/hedgedoc")
text = PROCESSOR.read_text(encoding="utf-8")
if MARKER in text: raise SystemExit("ERROR: Karpathy index/log context patch already appears applied")
wiki_log_text = (Path(__file__).parent / "memex/wiki_log.py").read_text(encoding="utf-8")
log_query_text = (Path(__file__).parent / "memex/log_query.py").read_text(encoding="utf-8")

def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1: raise SystemExit(f"ERROR: {label}: expected 1 match, found {count}; processor not written")
    text = text.replace(old, new, 1)

path_anchor = 'LOG_PATH = Path("memex/log.md")'
path_replacement = 'LOG_PATH = Path("memex/log.md")\n\n# KARPATHY_INDEX_LOG_CONTEXT\n# index.md is content-oriented memory; log.md is chronological operational\n# memory. Keep log context bounded so it does not crowd source evidence.\nfrom wiki_log import ensure_index_labels, recent_log_context\n\nRECENT_LOG_ENTRIES = max(\n    1, int(os.environ.get("MEMEX_RECENT_LOG_ENTRIES", "12"))\n)\nRECENT_LOG_MAX_CHARS = max(\n    1000, int(os.environ.get("MEMEX_RECENT_LOG_MAX_CHARS", "12000"))\n)\nrecent_log, recent_log_entry_count = recent_log_context(\n    LOG_PATH,\n    max_entries=RECENT_LOG_ENTRIES,\n    max_chars=RECENT_LOG_MAX_CHARS,\n)'
replace_once(path_anchor, path_replacement, "log context setup")
prompt_anchor = 'CURRENT MEMEX INDEX:\nUse this as navigation/context. The source documents below remain authoritative.\n\n{current_index}\n\nSOURCE DOCUMENTS:\n\n{prompt_docs}'
prompt_replacement = 'CURRENT MEMEX INDEX:\nUse this as navigation/context. The source documents below remain authoritative.\n\n{current_index}\n\nRECENT MEMEX LOG:\n{recent_log}\n\nThe RECENT MEMEX LOG is operational history, not source evidence.\nUse it to understand recent ingests, queries, revision checks, and lint results.\nDo not create or verify a trail or associated_with edge from log text alone.\nEvidence for maintained knowledge must come from the current index summaries\nand supplied source documents.\n\nSOURCE DOCUMENTS:\n\n{prompt_docs}'
replace_once(prompt_anchor, prompt_replacement, "live main-prompt anchor")
candidate_anchor = 'candidate_index = build_candidate_index()'
candidate_replacement = 'candidate_index = ensure_index_labels(build_candidate_index())'
replace_once(candidate_anchor, candidate_replacement, "candidate index normalization")
final_anchor = 'INDEX_PATH.write_text("\\n".join(_index).rstrip() + "\\n", encoding="utf-8")'
final_replacement = '_final_index = ensure_index_labels("\\n".join(_index).rstrip() + "\\n")\nINDEX_PATH.write_text(_final_index, encoding="utf-8")'
replace_once(final_anchor, final_replacement, "final index normalization")
log_anchor = '            f"- LLM associated_with accepted: {len(verified_llm_associations)}\\n"\n        f"- LLM called: yes\\n"'
log_replacement = '        f"- LLM associated_with accepted: {len(verified_llm_associations)}\\n"\n        f"- index read by LLM: yes\\n"\n        f"- recent log entries supplied to LLM: {recent_log_entry_count}\\n"\n        f"- LLM called: yes\\n"'
replace_once(log_anchor, log_replacement, "live ingest-log anchor")

compile(text, str(PROCESSOR), "exec")
compile(wiki_log_text, str(WIKI_LOG), "exec")
compile(log_query_text, str(LOG_QUERY), "exec")
backup = Path("/tmp/process_queue_once.py.before-karpathy-index-log-v3")
shutil.copy2(PROCESSOR, backup)

for target in (WIKI_LOG, LOG_QUERY):
    if target.exists(): shutil.copy2(target, Path("/tmp") / f"{target.name}.before-karpathy-index-log-v3")

WIKI_LOG.write_text(wiki_log_text, encoding="utf-8")
LOG_QUERY.write_text(log_query_text, encoding="utf-8")
LOG_QUERY.chmod(0o755)
PROCESSOR.write_text(text, encoding="utf-8")
py_compile.compile(str(WIKI_LOG), doraise=True)
py_compile.compile(str(LOG_QUERY), doraise=True)
py_compile.compile(str(PROCESSOR), doraise=True)

print("PATCHED:")
print("  memex/process_queue_once.py")
print("  memex/wiki_log.py")
print("  memex/log_query.py")
print("SYNTAX OK")
print("LIVE PROMPT ANCHOR: matched")
print("CANDIDATE INDEX NORMALIZATION: enabled")
print("FINAL INDEX NORMALIZATION: enabled")
print("RECENT LOG DEFAULT: 12 complete entries, max 12000 chars")
print("QUERY LOG FORMAT: ## [timestamp] query | subject")
print("PROCESSOR BACKUP:", backup)
