#!/usr/bin/env python3
from __future__ import annotations
import argparse
import sys
from pathlib import Path
from wiki_log import append_query

def main() -> int:
    parser = argparse.ArgumentParser(description="Append a Karpathy-style query event to the Memex log.")
    parser.add_argument("query", nargs="*")
    parser.add_argument("--log", default="memex/log.md")
    parser.add_argument("--page", action="append", default=[])
    parser.add_argument("--status", default="answered", choices=["answered", "no-answer", "partial", "error"])
    parser.add_argument("--answer-file", default="no")
    parser.add_argument("--llm-called", default="yes", choices=["yes", "no"])
    parser.add_argument("--via", default="agent")
    parser.add_argument("--summary", default="")
    args = parser.parse_args()
    query = " ".join(args.query).strip()
    if not query and not sys.stdin.isatty():
        query = sys.stdin.read().strip()
    if not query:
        parser.error("provide query text as arguments or on stdin")
    stamp = append_query(Path(args.log), query=query, status=args.status, pages=args.page, answer_filed=args.answer_file, llm_called=args.llm_called, via=args.via, summary=args.summary)
    print(f"logged query at {stamp}")
    print("log:", args.log)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
