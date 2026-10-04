#!/usr/bin/env python3

from pathlib import Path

PROCESSOR = Path("memex/process_queue_once.py")
LINT = Path("memex/lint_memex.py")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one patch location, found {count}")
    return text.replace(old, new, 1)


processor = PROCESSOR.read_text(encoding="utf-8")
lint = LINT.read_text(encoding="utf-8")

processor_old_api = """def api_put(alias, content):
    req = urllib.request.Request(
        f"{API}/{alias}",
        data=content.encode(),
        method="PUT",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/markdown",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


"""
processor_new_api = processor_old_api + """def sync_readonly_mirror(alias, path):
    try:
        api_put(alias, path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"WARNING: failed to sync {alias} revision mirror: {exc}")


"""

processor = replace_once(
    processor,
    processor_old_api,
    processor_new_api,
    "process_queue_once api helper",
)

processor_old_unchanged = """            f"- LLM called: no\\n\\n"
        )

    raise SystemExit(
"""
processor_new_unchanged = """            f"- LLM called: no\\n\\n"
        )

    sync_readonly_mirror("memex-log", LOG_PATH)

    raise SystemExit(
"""
processor = replace_once(
    processor,
    processor_old_unchanged,
    processor_new_unchanged,
    "process_queue_once unchanged-revision sync",
)

processor_old_final = """        f"- summary: {_summary or 'No summary returned.'}\\n\\n"
    )

print("index:", INDEX_PATH)
print("log:", LOG_PATH)
"""
processor_new_final = """        f"- summary: {_summary or 'No summary returned.'}\\n\\n"
    )

sync_readonly_mirror("memex-index", INDEX_PATH)
sync_readonly_mirror("memex-log", LOG_PATH)

print("index:", INDEX_PATH)
print("log:", LOG_PATH)
"""
processor = replace_once(
    processor,
    processor_old_final,
    processor_new_final,
    "process_queue_once successful-ingest sync",
)

lint_old_api = """def api_get(alias):
    req = urllib.request.Request(
        f"{API}/notes/{alias}/content",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode("utf-8")


"""
lint_new_api = lint_old_api + """def api_put(alias, content):
    req = urllib.request.Request(
        f"{API}/notes/{alias}",
        data=content.encode(),
        method="PUT",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/markdown",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.status


def sync_readonly_mirror(alias, path):
    if not TOKEN:
        print(f"WARNING: MEMEX_API_TOKEN missing; {alias} revision mirror not synced")
        return
    try:
        api_put(alias, path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"WARNING: failed to sync {alias} revision mirror: {exc}")


"""
lint = replace_once(
    lint,
    lint_old_api,
    lint_new_api,
    "lint_memex api helper",
)

lint_old_log = """        f"- LLM called: no\\n\\n"
    )

if args.repair_orphans and orphans:
"""
lint_new_log = """        f"- LLM called: no\\n\\n"
    )

sync_readonly_mirror("memex-log", LOG)

if args.repair_orphans and orphans:
"""
lint = replace_once(
    lint,
    lint_old_log,
    lint_new_log,
    "lint_memex log sync",
)

PROCESSOR.write_text(processor, encoding="utf-8")
LINT.write_text(lint, encoding="utf-8")

print("patched:", PROCESSOR)
print("patched:", LINT)
