#!/usr/bin/env python3
from pathlib import Path
import shutil
import re

ROOT = Path(".")
PAGE = ROOT / "frontend/src/app/(editor)/trails/page.tsx"
ROUTE = ROOT / "frontend/src/app/memex-trail-overlap/route.ts"
COMPONENT = ROOT / "frontend/src/app/(editor)/trails/trail-overlap-review.tsx"

IMPORT_MARKER = "MEMEX_TRAIL_OVERLAP_REVIEW_IMPORT"
JSX_MARKER = "MEMEX_TRAIL_OVERLAP_REVIEW"

if not PAGE.exists():
    raise SystemExit("ERROR: run from /data/projects/hedgedoc; trails/page.tsx not found")

for required in (ROUTE, COMPONENT):
    if not required.exists():
        raise SystemExit(f"ERROR: ZIP source missing after extraction: {required}")

text = PAGE.read_text(encoding="utf-8")

if JSX_MARKER in text and "TrailOverlapReview" in text:
    print("PATCH ALREADY APPLIED")
    raise SystemExit(0)

original = text

# Keep 'use client' as the first directive. Put our import directly after it when
# present; otherwise place the import before the first existing import.
import_line = (
    "// MEMEX_TRAIL_OVERLAP_REVIEW_IMPORT\n"
    "import { TrailOverlapReview } from './trail-overlap-review'\n"
)

directive = re.search(r"(?m)^[ \t]*['\"]use client['\"][ \t]*;?[ \t]*\n", text)
if directive:
    insert_at = directive.end()
    text = text[:insert_at] + "\n" + import_line + text[insert_at:]
else:
    first_import = re.search(r"(?m)^import\b", text)
    if first_import:
        insert_at = first_import.start()
        text = text[:insert_at] + import_line + "\n" + text[insert_at:]
    else:
        text = import_line + "\n" + text

# Use the last component-level "return (" in the file. This avoids helper
# callbacks and early loading/error returns that appear earlier in the module.
returns = list(re.finditer(r"(?m)^[ \t]*return[ \t]*\(", text))
if not returns:
    raise SystemExit("ERROR: no component return (...) found; page not written")

return_match = returns[-1]
cursor = return_match.end()

while cursor < len(text) and text[cursor].isspace():
    cursor += 1

if cursor >= len(text) or text[cursor] != "<":
    raise SystemExit(
        "ERROR: main return does not begin with a JSX root element; page not written"
    )

# Find the end of the JSX root opening tag. Handle quoted attributes and
# JavaScript expressions so ">" inside callbacks/strings is not mistaken for
# the tag terminator.
if text.startswith("<>", cursor):
    opening_end = cursor + 2
else:
    i = cursor + 1
    quote = None
    escaped = False
    brace_depth = 0
    opening_end = None

    while i < len(text):
        ch = text[i]

        if quote is not None:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = None
        else:
            if ch in ("'", '"', "`"):
                quote = ch
            elif ch == "{":
                brace_depth += 1
            elif ch == "}":
                brace_depth = max(0, brace_depth - 1)
            elif ch == ">" and brace_depth == 0:
                opening_end = i + 1
                break
        i += 1

    if opening_end is None:
        raise SystemExit("ERROR: could not find JSX root opening tag end; page not written")

line_start = text.rfind("\n", 0, cursor) + 1
root_indent = re.match(r"[ \t]*", text[line_start:cursor]).group(0)
child_indent = root_indent + "  "

insertion = (
    "\n"
    f"{child_indent}{{/* MEMEX_TRAIL_OVERLAP_REVIEW */}}\n"
    f"{child_indent}<TrailOverlapReview />"
)

text = text[:opening_end] + insertion + text[opening_end:]

if text.count("TrailOverlapReview") != 2:
    raise SystemExit(
        "ERROR: unexpected TrailOverlapReview marker count; page not written"
    )

backup = Path("/tmp/trails-page.tsx.before-trail-overlap-review")
shutil.copy2(PAGE, backup)

try:
    PAGE.write_text(text, encoding="utf-8")
except Exception:
    shutil.copy2(backup, PAGE)
    raise

print("PATCHED:")
print("  frontend/src/app/(editor)/trails/page.tsx")
print("  frontend/src/app/(editor)/trails/trail-overlap-review.tsx")
print("  frontend/src/app/memex-trail-overlap/route.ts")
print("MODE: separate read-only LLM overlap review")
print("AUTO-MERGE: disabled")
print("PAGE BACKUP:", backup)
