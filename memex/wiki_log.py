#!/usr/bin/env python3
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

_ENTRY_SPLIT = re.compile(r"(?=^## \[)", re.MULTILINE)

def _one_line(value: object, limit: int | None = None) -> str:
    text = " ".join(str(value).split())
    if limit is not None and len(text) > limit:
        return text[: max(0, limit - 1)].rstrip() + "…"
    return text

def ensure_index_labels(text: str) -> str:
    """Fill blank Markdown link labels with the canonical /n/<alias> target."""
    output = []
    for line in text.splitlines(keepends=True):
        marker = "- [] ("  # never matches; documents intended syntax below
        target = "- [](" 
        if target in line and "/n/" in line:
            start = line.find(target) + len(target)
            end = line.find(")", start)
            if end > start:
                url = line[start:end]
                if "/n/" in url:
                    alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]
                    alias = alias.strip()
                    if alias:
                        line = line.replace(target, f"- [{alias}](", 1)
        output.append(line)
    return "".join(output)

def recent_log_context(log_path: Path, *, max_entries: int = 12, max_chars: int = 12000) -> tuple[str, int]:
    if max_entries <= 0 or max_chars <= 0 or not log_path.exists():
        return "No prior Memex log entries.", 0
    text = log_path.read_text(encoding="utf-8")
    entries = [part.strip() for part in _ENTRY_SPLIT.split(text) if part.strip().startswith("## [")]
    chosen: list[str] = []
    used = 0
    for entry in reversed(entries[-max_entries:]):
        extra = len(entry) + (2 if chosen else 0)
        if chosen and used + extra > max_chars:
            break
        if not chosen and len(entry) > max_chars:
            heading, _, body = entry.partition("\n")
            room = max(0, max_chars - len(heading) - 2)
            entry = heading + "\n\n" + body[-room:]
            extra = len(entry)
        chosen.append(entry)
        used += extra
    chosen.reverse()
    return "\n\n".join(chosen), len(chosen)

def append_event(log_path: Path, event: str, subject: str, fields: Sequence[tuple[str, object | None]]) -> str:
    event = _one_line(event, 40) or "event"
    subject = _one_line(subject, 160) or "(untitled)"
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [f"## [{stamp}] {event} | {subject}", ""]
    for key, value in fields:
        if value is None:
            continue
        lines.append(f"- {_one_line(key, 80)}: {_one_line(value, 2000)}")
    payload = "\n".join(lines).rstrip() + "\n\n"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not log_path.exists() or log_path.stat().st_size == 0:
        payload = "# Memex Log\n\n" + payload
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o664)
    try:
        os.write(fd, payload.encode("utf-8"))
    finally:
        os.close(fd)
    return stamp

def append_query(log_path: Path, *, query: str, status: str = "answered", pages: Iterable[str] = (), answer_filed: str = "no", llm_called: str = "yes", via: str = "agent", summary: str = "") -> str:
    clean_query = _one_line(query, 2000)
    page_list = [_one_line(page, 300) for page in pages if _one_line(page, 300)]
    subject = _one_line(clean_query, 120) or "(empty query)"
    fields: list[tuple[str, object | None]] = [
        ("query", clean_query),
        ("status", status),
        ("pages read", len(page_list)),
        ("pages", ", ".join(page_list) if page_list else "none recorded"),
        ("answer filed", answer_filed),
        ("LLM called", llm_called),
        ("via", via),
        ("summary", summary or None),
    ]
    return append_event(log_path, "query", subject, fields)
