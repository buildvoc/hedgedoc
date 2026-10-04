#!/usr/bin/env python3
from pathlib import Path
import py_compile
import shutil

ROOT = Path(".")
PROCESSOR = ROOT / "memex/process_queue_once.py"
WIKI_LOG = ROOT / "memex/wiki_log.py"
LOG_QUERY = ROOT / "memex/log_query.py"

MARKER = "KARPATHY_INDEX_LOG_CONTEXT"
PROMPT_MARKER = "RECENT MEMEX LOG:"

if not PROCESSOR.exists():
    raise SystemExit("ERROR: run from /data/projects/hedgedoc")

text = PROCESSOR.read_text(encoding="utf-8")

if MARKER in text or PROMPT_MARKER in text:
    raise SystemExit("ERROR: Karpathy index/log context patch already appears applied")

wiki_log_text = (Path(__file__).parent / "memex/wiki_log.py").read_text(encoding="utf-8")
log_query_text = (Path(__file__).parent / "memex/log_query.py").read_text(encoding="utf-8")

def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"ERROR: {label}: expected 1 match, found {count}; processor not written"
        )
    text = text.replace(old, new, 1)

# 1. Configure bounded recent-log memory.
path_anchor = 'LOG_PATH = Path("memex/log.md")'
path_replacement = """LOG_PATH = Path("memex/log.md")

# KARPATHY_INDEX_LOG_CONTEXT
# index.md is content-oriented memory; log.md is chronological operational
# memory. Keep log context bounded so it does not crowd source evidence.
from wiki_log import recent_log_context

RECENT_LOG_ENTRIES = max(
    1, int(os.environ.get("MEMEX_RECENT_LOG_ENTRIES", "12"))
)
RECENT_LOG_MAX_CHARS = max(
    1000, int(os.environ.get("MEMEX_RECENT_LOG_MAX_CHARS", "12000"))
)
recent_log, recent_log_entry_count = recent_log_context(
    LOG_PATH,
    max_entries=RECENT_LOG_ENTRIES,
    max_chars=RECENT_LOG_MAX_CHARS,
)"""
replace_once(path_anchor, path_replacement, "log context setup")

# 2. Patch the main f-string structurally. This deliberately does not assume
#    that {current_index} and {prompt_docs} are adjacent because the
#    associated_with patch inserts candidate instructions between them.
prompt_start = text.find('prompt = f"""')
if prompt_start < 0:
    raise SystemExit("ERROR: main prompt start not found; processor not written")

prompt_body_start = prompt_start + len('prompt = f"""')
prompt_end = text.find('"""', prompt_body_start)
if prompt_end < 0:
    raise SystemExit("ERROR: main prompt end not found; processor not written")

prompt_body = text[prompt_body_start:prompt_end]
placeholder = "{prompt_docs}"

if prompt_body.count(placeholder) != 1:
    raise SystemExit(
        f"ERROR: expected one {{prompt_docs}} inside main prompt; "
        f"found {prompt_body.count(placeholder)}; processor not written"
    )

insert = """RECENT MEMEX LOG:
{recent_log}

The RECENT MEMEX LOG is operational history, not source evidence.
Use it to understand recent ingests, queries, revision checks, and lint results.
Do not create or verify a trail or associated_with edge from log text alone.
Evidence for maintained knowledge must come from the current index summaries
and supplied source documents.

"""

relative_pos = prompt_body.find(placeholder)
absolute_pos = prompt_body_start + relative_pos
text = text[:absolute_pos] + insert + text[absolute_pos:]

# 3. Prevent blank display labels in rebuilt index.md.
title_anchor = """_url = f"{_public_base}/n/{_doc['alias']}"
        _index.append(f"- [{_doc['title']}]({_url}) — {_summary}")"""
title_replacement = """_url = f"{_public_base}/n/{_doc['alias']}"
        _title = " ".join(str(_doc.get("title") or _doc["alias"]).split())
        if not _title:
            _title = _doc["alias"]
        _index.append(f"- [{_title}]({_url}) — {_summary}")"""
replace_once(title_anchor, title_replacement, "index title fallback")

# 4. Record which persistent memory was supplied to the maintenance LLM.
assoc_anchor = """f"- LLM associated_with accepted: {len(verified_llm_associations)}\\n"
            f"- LLM called: yes\\n\""""

if assoc_anchor in text:
    assoc_replacement = """f"- LLM associated_with accepted: {len(verified_llm_associations)}\\n"
            f"- index read by LLM: yes\\n"
            f"- recent log entries supplied to LLM: {recent_log_entry_count}\\n"
            f"- LLM called: yes\\n\""""
    replace_once(assoc_anchor, assoc_replacement, "ingest memory log fields")
else:
    generic_anchor = """f"- trails: {len(trails)}\\n"
            f"- LLM called: yes\\n\""""
    generic_replacement = """f"- trails: {len(trails)}\\n"
            f"- index read by LLM: yes\\n"
            f"- recent log entries supplied to LLM: {recent_log_entry_count}\\n"
            f"- LLM called: yes\\n\""""
    replace_once(generic_anchor, generic_replacement, "ingest memory log fields")

# Validate every transformed file before writing processor changes.
compile(text, str(PROCESSOR), "exec")
compile(wiki_log_text, str(WIKI_LOG), "exec")
compile(log_query_text, str(LOG_QUERY), "exec")

backup_processor = Path("/tmp/process_queue_once.py.before-karpathy-index-log-v2")
shutil.copy2(PROCESSOR, backup_processor)

helper_backups = []
for target in (WIKI_LOG, LOG_QUERY):
    if target.exists():
        backup = Path("/tmp") / f"{target.name}.before-karpathy-index-log-v2"
        shutil.copy2(target, backup)
        helper_backups.append((target, backup))

try:
    WIKI_LOG.write_text(wiki_log_text, encoding="utf-8")
    LOG_QUERY.write_text(log_query_text, encoding="utf-8")
    LOG_QUERY.chmod(0o755)
    PROCESSOR.write_text(text, encoding="utf-8")

    py_compile.compile(str(WIKI_LOG), doraise=True)
    py_compile.compile(str(LOG_QUERY), doraise=True)
    py_compile.compile(str(PROCESSOR), doraise=True)
except Exception:
    shutil.copy2(backup_processor, PROCESSOR)
    for target, backup in helper_backups:
        shutil.copy2(backup, target)
    raise

print("PATCHED:")
print("  memex/process_queue_once.py")
print("  memex/wiki_log.py")
print("  memex/log_query.py")
print("SYNTAX OK")
print("PROMPT PATCH: structural {prompt_docs} insertion")
print("RECENT LOG DEFAULT: 12 complete entries, max 12000 chars")
print("QUERY LOG FORMAT: ## [timestamp] query | subject")
print("PROCESSOR BACKUP:", backup_processor)
