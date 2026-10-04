#!/usr/bin/env python3
from pathlib import Path
import re
import shutil

PAGE = Path("frontend/src/app/(editor)/trails/page.tsx")
MARKER = "{/* MEMEX_TRAIL_OVERLAP_REVIEW */}"
COMPONENT = "<TrailOverlapReview />"
IMPORT = "import { TrailOverlapReview } from './trail-overlap-review'"

if not PAGE.exists():
    raise SystemExit("ERROR: run from /data/projects/hedgedoc")

text = PAGE.read_text(encoding="utf-8")

if IMPORT not in text:
    raise SystemExit("ERROR: TrailOverlapReview import missing; page not written")

marker_count = text.count(MARKER)
component_count = text.count(COMPONENT)

if marker_count != 1 or component_count != 1:
    raise SystemExit(
        f"ERROR: expected exactly one current overlap-review placement; "
        f"marker={marker_count} component={component_count}; page not written"
    )

# Remove the misplaced JSX pair wherever v1 put it. Preserve surrounding JSX.
text = re.sub(
    r'(?m)^[ \t]*\{/\* MEMEX_TRAIL_OVERLAP_REVIEW \*/\}[ \t]*\n'
    r'^[ \t]*<TrailOverlapReview />[ \t]*\n?',
    '',
    text,
    count=1,
)

# Locate multiline JSX return blocks. The page-level return is the shallowest
# indentation return in the module; if several have that indentation, choose
# the last one (after any same-level early-return blocks).
returns = []
for match in re.finditer(r'(?m)^([ \t]*)return[ \t]*\(', text):
    indent = match.group(1)
    cursor = match.end()
    while cursor < len(text) and text[cursor].isspace():
        cursor += 1
    if cursor < len(text) and text[cursor] == '<':
        width = 0
        for ch in indent:
            width += 4 if ch == '\t' else 1
        returns.append((width, match.start(), match.end(), cursor, indent))

if not returns:
    raise SystemExit("ERROR: no multiline JSX return blocks found; page not written")

min_width = min(item[0] for item in returns)
candidates = [item for item in returns if item[0] == min_width]
_, _, _, cursor, return_indent = candidates[-1]

# Find end of the page root opening JSX tag, respecting quoted strings and
# {...} expressions inside attributes.
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
        raise SystemExit("ERROR: could not find page root opening tag; page not written")

child_indent = return_indent + "  "
insertion = (
    "\n"
    f"{child_indent}{MARKER}\n"
    f"{child_indent}{COMPONENT}"
)

text = text[:opening_end] + insertion + text[opening_end:]

# Safety checks:
# - import exactly once
# - JSX review exactly once
# - placement is shallow, not inside source-link/map callback indentation
if text.count(IMPORT) != 1:
    raise SystemExit("ERROR: import count changed unexpectedly; page not written")
if text.count(MARKER) != 1 or text.count(COMPONENT) != 1:
    raise SystemExit("ERROR: corrected JSX count is not exactly one; page not written")

marker_match = re.search(
    r'(?m)^([ \t]*)\{/\* MEMEX_TRAIL_OVERLAP_REVIEW \*/\}$',
    text,
)
if marker_match is None:
    raise SystemExit("ERROR: corrected marker not found; page not written")

marker_width = sum(4 if ch == '\t' else 1 for ch in marker_match.group(1))
if marker_width > min_width + 4:
    raise SystemExit(
        f"ERROR: corrected marker still too deeply nested "
        f"(return indent={min_width}, marker indent={marker_width}); page not written"
    )

backup = Path("/tmp/trails-page.tsx.before-trail-overlap-placement-fix")
shutil.copy2(PAGE, backup)
PAGE.write_text(text, encoding="utf-8")

line_no = text[: marker_match.start()].count("\n") + 1

print("PATCHED:")
print("  frontend/src/app/(editor)/trails/page.tsx")
print("FIX: moved TrailOverlapReview out of per-source <a> callback")
print("PLACEMENT: page-level JSX root")
print("OVERLAP REVIEW INSTANCES: 1")
print("MARKER LINE:", line_no)
print("PAGE BACKUP:", backup)
