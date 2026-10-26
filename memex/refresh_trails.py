#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get("MEMEX_HEDGEDOC_ROOT", "/data/projects/hedgedoc"))
INDEX_PATH = Path(
    os.environ.get("MEMEX_INDEX_PATH", str(ROOT / "memex" / "index.md"))
)
MODEL_SETTINGS_PATH = Path(
    os.environ.get(
        "MEMEX_MODEL_SETTINGS_PATH",
        str(ROOT / "memex" / "model-settings.json"),
    )
)
BACKUP_ROOT = Path(
    os.environ.get("MEMEX_BACKUP_DIR", "/backups/builds")
)
HEDGEDOC_NOTES_API = os.environ.get(
    "MEMEX_HEDGEDOC_API_BASE",
    "http://127.0.0.1:3100/api/v2/notes",
).rstrip("/")
INDEX_MIRROR_ALIAS = os.environ.get(
    "MEMEX_INDEX_MIRROR_ALIAS", "memex-index"
)


TRAIL_SHORTLIST_SIZE = max(
    6, int(os.environ.get("MEMEX_TRAIL_SHORTLIST_SIZE", "16"))
)
TRAIL_SHORTLIST_RECENT = max(
    0, int(os.environ.get("MEMEX_TRAIL_SHORTLIST_RECENT", "4"))
)
TRAIL_SHORTLIST_CONTEXT_CHARS = max(
    1800, int(os.environ.get("MEMEX_TRAIL_SHORTLIST_CONTEXT_CHARS", "4200"))
)
TRAIL_CACHE_ANCHOR_CHARS = max(
    12000, int(os.environ.get("MEMEX_TRAIL_CACHE_ANCHOR_CHARS", "32000"))
)

TRAIL_STOP_WORDS = {
    "about", "above", "after", "again", "against", "also", "among",
    "because", "before", "being", "below", "between", "both", "could",
    "does", "during", "each", "either", "every", "first", "from",
    "have", "into", "itself", "more", "most", "much", "only", "other",
    "over", "same", "should", "since", "some", "such", "than", "that",
    "their", "them", "there", "these", "they", "this", "those", "through",
    "under", "until", "upon", "used", "using", "very", "were", "what",
    "when", "where", "which", "while", "with", "within", "would",
    "source", "document", "summary", "information", "page", "pages",
}

SOURCE_LINE_RE = re.compile(
    r"^- \[(.*)\]\(([^)]*/(?:n|p|s)/([^?#)]+)[^)]*)\)(?: — (.*))?$"
)


def out(line=""):
    print(line, flush=True)


def sha256_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def compact_whitespace(value):
    return " ".join(str(value or "").split())


def load_model_settings():
    settings = {}
    if MODEL_SETTINGS_PATH.exists():
        parsed = json.loads(MODEL_SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            settings = parsed

    provider = str(
        settings.get("provider")
        or os.environ.get("MEMEX_LLM_BACKEND", "ollama")
    ).strip().lower()

    if provider not in {"ollama", "llamacpp"}:
        raise RuntimeError(f"Unsupported Memex provider: {provider}")

    def value(name, env_name, fallback):
        configured = settings.get(name)
        if configured not in (None, ""):
            return configured
        return os.environ.get(env_name, fallback)

    if provider == "llamacpp":
        base_url = str(
            value(
                "baseUrl",
                "MEMEX_LLAMACPP_BASE_URL",
                "http://192.168.1.99:8080/v1",
            )
        ).rstrip("/")
        model = str(
            value("defaultModel", "MEMEX_LLAMACPP_MODEL", "memex")
        )
    else:
        base_url = str(
            value(
                "baseUrl",
                "MEMEX_OLLAMA_BASE_URL",
                "http://192.168.1.99:11434",
            )
        ).rstrip("/")
        model = str(
            value("defaultModel", "MEMEX_MODEL", "gemma4:26b")
        )

    return {
        "provider": provider,
        "baseUrl": base_url,
        "model": model,
        "numCtx": int(value("numCtx", "MEMEX_NUM_CTX", 65536)),
        "maxPromptChars": int(
            value("maxPromptChars", "MEMEX_PROMPT_DOC_CHARS", 80000)
        ),
        "timeoutSeconds": int(
            value("timeoutSeconds", "MEMEX_TIMEOUT_SECONDS", 600)
        ),
        "temperature": float(
            value("temperature", "MEMEX_TEMPERATURE", 0.35)
        ),
        "maxTokens": int(
            os.environ.get("MEMEX_TRAIL_REFRESH_MAX_TOKENS", "8192")
        ),
    }


def llm_chat(settings, prompt, system_prompt):
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    if settings["provider"] == "ollama":
        endpoint = f'{settings["baseUrl"]}/api/chat'
        payload = {
            "model": settings["model"],
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": settings["temperature"],
                "num_ctx": settings["numCtx"],
            },
        }
    else:
        endpoint = f'{settings["baseUrl"]}/chat/completions'
        payload = {
            "model": settings["model"],
            "messages": messages,
            "stream": False,
            "temperature": settings["temperature"],
            "max_tokens": settings["maxTokens"],
            "reasoning_effort": "none",
            "cache_prompt": True,
            "id_slot": 0,
        }

    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(
            request, timeout=settings["timeoutSeconds"]
        ) as response:
            outer = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        peg_failure = (
            settings["provider"] == "llamacpp"
            and exc.code == 500
            and "does not match the expected peg-gemma4 format" in detail
        )

        if not peg_failure:
            raise RuntimeError(
                f'LLM HTTP {exc.code}: {detail[:800]}'
            ) from exc

        out("llama.cpp template parse failed; using apply-template fallback")
        base = settings["baseUrl"].rstrip("/")
        server_root = base[:-3] if base.endswith("/v1") else base

        template_request = urllib.request.Request(
            f"{server_root}/apply-template",
            data=json.dumps({"messages": messages}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )

        with urllib.request.urlopen(
            template_request, timeout=settings["timeoutSeconds"]
        ) as response:
            template_outer = json.loads(response.read().decode("utf-8"))

        raw_prompt = template_outer.get("prompt")
        if not isinstance(raw_prompt, str) or not raw_prompt:
            raise RuntimeError("llama.cpp apply-template returned no prompt")

        completion_request = urllib.request.Request(
            f"{server_root}/completion",
            data=json.dumps(
                {
                    "prompt": raw_prompt,
                    "stream": False,
                    "temperature": settings["temperature"],
                    "n_predict": settings["maxTokens"],
                    "cache_prompt": True,
                    "id_slot": 0,
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )

        with urllib.request.urlopen(
            completion_request, timeout=settings["timeoutSeconds"]
        ) as response:
            completion_outer = json.loads(
                response.read().decode("utf-8")
            )

        content = completion_outer.get("content", "")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("llama.cpp fallback returned no content")
        return content

    if settings["provider"] == "ollama":
        content = outer.get("message", {}).get("content", "")
    else:
        usage = outer.get("usage") or {}
        prompt_details = usage.get("prompt_tokens_details") or {}
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        cached_tokens = int(prompt_details.get("cached_tokens") or 0)
        reuse = (100.0 * cached_tokens / prompt_tokens) if prompt_tokens else 0.0
        out(
            f"KV_CACHE prompt_tokens={prompt_tokens} "
            f"cached_tokens={cached_tokens} reuse={reuse:.1f}%"
        )
        choices = outer.get("choices") or []
        if not choices:
            raise RuntimeError("llama.cpp response contained no choices")
        content = choices[0].get("message", {}).get("content", "")

    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("LLM returned empty content")
    return content


def source_section(index_markdown):
    if "## Sources" not in index_markdown:
        raise RuntimeError("memex/index.md has no ## Sources section")

    remainder = index_markdown.split("## Sources", 1)[1]
    return remainder.split("## Trails", 1)[0]


def parse_sources(index_markdown):
    result = []
    seen = set()

    for line in source_section(index_markdown).splitlines():
        match = SOURCE_LINE_RE.match(line)
        if not match:
            continue

        alias = urllib.parse.unquote(match.group(3))
        if not alias or alias in seen:
            continue

        seen.add(alias)
        result.append(
            {
                "alias": alias,
                "title": compact_whitespace(match.group(1)),
                "href": match.group(2),
                "summary": compact_whitespace(match.group(4) or ""),
            }
        )

    if not result:
        raise RuntimeError("No Memex sources parsed from index")
    return result


def current_trail_count(index_markdown):
    if "## Trails" not in index_markdown:
        return 0
    section = index_markdown.split("## Trails", 1)[1]
    return len(re.findall(r"^###\s+.+$", section, re.M))


def extract_json_object(raw):
    stripped = raw.strip()
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.I)
    stripped = re.sub(r"\s*```$", "", stripped)

    start = stripped.find("{")
    if start < 0:
        raise ValueError("response contains no JSON object")

    decoder = json.JSONDecoder()
    value, _ = decoder.raw_decode(stripped[start:])
    if not isinstance(value, dict):
        raise ValueError("response root must be an object")
    return value


def fit_text(value, budget):
    value = str(value or "").replace("\x00", "")
    if len(value) <= budget:
        return value, False
    if budget < 1000:
        return value[:budget], True
    marker = "\n\n...[source content truncated to fit model context]...\n\n"
    usable = max(1, budget - len(marker))
    head = int(usable * 0.72)
    tail = usable - head
    return value[:head] + marker + value[-tail:], True


def normalize_name(value):
    return re.sub(r"[^a-z0-9]+", " ", compact_whitespace(value).casefold()).strip()


def work_file(index_hash, settings):
    model_key = sha256_text(
        f'{settings["provider"]}\n{settings["model"]}'
    )[:12]
    return BACKUP_ROOT / (
        f"memex-trail-refresh-work-kv3-{index_hash[:16]}-{model_key}.json"
    )


def atomic_json_write(path, value):
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def new_work_state(index_markdown, sources, settings):
    return {
        "version": 3,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "indexHash": sha256_text(index_markdown),
        "sourceSectionHash": sha256_text(source_section(index_markdown)),
        "sourceCount": len(sources),
        "provider": settings["provider"],
        "model": settings["model"],
        "nextSourceId": 1,
        "reviewedSourceIds": [],
        "profiles": {},
        "trails": [],
        "nextTrailId": 1,
        "finalized": False,
        "finalTrails": [],
    }


def load_or_create_work_state(path, index_markdown, sources, settings):
    expected = new_work_state(index_markdown, sources, settings)
    if not path.exists():
        return expected

    value = json.loads(path.read_text(encoding="utf-8"))
    required = {
        "version": 3,
        "indexHash": expected["indexHash"],
        "sourceSectionHash": expected["sourceSectionHash"],
        "sourceCount": expected["sourceCount"],
        "provider": expected["provider"],
        "model": expected["model"],
    }
    if any(value.get(key) != expected_value for key, expected_value in required.items()):
        raise RuntimeError(
            f"Existing resumable work state is incompatible: {path}"
        )
    return value


def build_cache_anchor(sources, budget):
    """Stable prefix shared by every per-source call for llama.cpp KV reuse."""
    header = (
        "STATIC MEMEX SOURCE CATALOGUE CACHE ANCHOR\n"
        "This catalogue is context only. Do not treat it as the current source.\n"
        "IDs are application IDs; never reproduce aliases.\n"
    )
    lines = [header]
    used = len(header)
    for source_id, source in enumerate(sources, 1):
        title = compact_whitespace(source.get("title"))[:100]
        summary = compact_whitespace(source.get("summary"))[:140]
        line = f"S{source_id}\t{title}"
        if summary:
            line += f"\t{summary}"
        line += "\n"
        if used + len(line) > budget:
            break
        lines.append(line)
        used += len(line)
    anchor = "".join(lines).rstrip()
    return anchor


def compact_trail_context(trails, sources, budget):
    if not trails:
        return "No candidate trails exist yet."

    by_id = {source_id: source for source_id, source in enumerate(sources, 1)}
    reason_limits = [180, 120, 80, 40, 0]
    member_title_limits = [4, 2, 0]

    for reason_limit in reason_limits:
        for title_limit in member_title_limits:
            lines = []
            for trail in trails:
                members = list(dict.fromkeys(trail.get("sourceIds") or []))
                reason = compact_whitespace(trail.get("reason"))[:reason_limit]
                line = f'T{trail["id"]}\t{compact_whitespace(trail.get("name"))[:100]}'
                if reason:
                    line += f'\t{reason}'
                line += "\tSOURCE_IDS:" + ",".join(map(str, members[:32]))
                if title_limit:
                    titles = [
                        by_id[source_id]["title"][:70]
                        for source_id in members[:title_limit]
                        if source_id in by_id
                    ]
                    if titles:
                        line += "\tMEMBERS:" + " | ".join(titles)
                lines.append(line)
            text = "\n".join(lines)
            if len(text) <= budget:
                return text

    raise RuntimeError(
        f"Candidate trail context exceeds {budget} characters; "
        "reduce trail count before continuing"
    )


def compact_review_trail_context(trails, budget):
    """Render only the live data the model needs to choose a candidate trail."""
    if not trails:
        return "No candidate trails exist yet."

    # Membership/source-ID detail is used application-side by shortlist scoring.
    # Keeping it out of the LLM suffix reduces uncached prompt evaluation without
    # changing the stable cache anchor or truncating source content.
    reason_limits = [180, 140, 100, 70, 40, 0]
    for reason_limit in reason_limits:
        lines = []
        for trail in trails:
            name = compact_whitespace(trail.get("name"))[:100]
            reason = compact_whitespace(trail.get("reason"))[:reason_limit]
            line = f'T{trail["id"]}\t{name}'
            if reason:
                line += f'\t{reason}'
            lines.append(line)
        text = "\n".join(lines)
        if len(text) <= budget:
            return text

    raise RuntimeError(
        f"Candidate review context exceeds {budget} characters; "
        "reduce shortlist size before continuing"
    )


def trail_terms(value):
    words = set()
    for raw in re.findall(r"[A-Za-z0-9][A-Za-z0-9_-]{2,}", str(value or "").casefold()):
        word = raw.strip("_-")
        if len(word) < 4 or word in TRAIL_STOP_WORDS or word.isdigit():
            continue
        words.add(word)
    return words


def shortlist_candidate_trails(state, source_id, source, source_content, sources):
    trails = state.get("trails") or []
    if len(trails) <= TRAIL_SHORTLIST_SIZE:
        return list(trails)

    source_terms = trail_terms(
        f'{source.get("title", "")} {source.get("summary", "")} {source_content[:24000]}'
    )
    profiles = state.get("profiles") or {}
    source_by_id = {index: item for index, item in enumerate(sources, 1)}
    scored = []

    for trail in trails:
        trail_id = int(trail["id"])
        name_terms = trail_terms(trail.get("name"))
        reason_terms = trail_terms(trail.get("reason"))
        member_terms = set()
        theme_terms = set()

        for member_id in list(dict.fromkeys(trail.get("sourceIds") or []))[-6:]:
            member = source_by_id.get(int(member_id))
            if member:
                member_terms.update(trail_terms(member.get("title")))
                member_terms.update(trail_terms(member.get("summary")))
            profile = profiles.get(str(member_id)) or {}
            theme_terms.update(trail_terms(" ".join(profile.get("themes") or [])))

        score = (
            10 * len(source_terms & name_terms)
            + 5 * len(source_terms & reason_terms)
            + 3 * len(source_terms & theme_terms)
            + 2 * len(source_terms & member_terms)
        )
        scored.append((score, trail_id, trail))

    chosen = []
    chosen_ids = set()
    relevance_slots = max(0, TRAIL_SHORTLIST_SIZE - TRAIL_SHORTLIST_RECENT)

    for score, trail_id, trail in sorted(
        scored, key=lambda item: (-item[0], -item[1])
    ):
        if len(chosen) >= relevance_slots:
            break
        if score <= 0:
            continue
        chosen.append(trail)
        chosen_ids.add(trail_id)

    for trail in sorted(trails, key=lambda item: int(item["id"]), reverse=True):
        trail_id = int(trail["id"])
        if trail_id in chosen_ids:
            continue
        chosen.append(trail)
        chosen_ids.add(trail_id)
        if len(chosen) >= TRAIL_SHORTLIST_SIZE:
            break

    return sorted(chosen, key=lambda item: int(item["id"]))


def parse_int_list(value, valid_ids, limit):
    if isinstance(value, str):
        value = re.findall(r"\d+", value)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        value = [value]
    elif not isinstance(value, list):
        return []

    result = []
    seen = set()
    for raw in value:
        if isinstance(raw, bool) or raw is None:
            continue
        try:
            item = int(raw)
        except (TypeError, ValueError):
            continue
        if item not in valid_ids or item in seen:
            continue
        seen.add(item)
        result.append(item)
        if len(result) >= limit:
            break
    return result


def validate_source_decision(value, existing_trails):
    profile = compact_whitespace(value.get("profile"))[:420]
    if len(profile) < 20:
        raise ValueError("profile must contain at least 20 characters")

    raw_themes = value.get("themes")
    themes = []
    if isinstance(raw_themes, list):
        for theme in raw_themes:
            clean = compact_whitespace(theme)[:80]
            if clean and clean.casefold() not in {item.casefold() for item in themes}:
                themes.append(clean)
            if len(themes) >= 8:
                break

    valid_trail_ids = {int(trail["id"]) for trail in existing_trails}
    join_ids = parse_int_list(value.get("joinTrailIds"), valid_trail_ids, 3)

    new_trails = []
    raw_new = value.get("newTrails")
    if isinstance(raw_new, dict):
        raw_new = [raw_new]
    if isinstance(raw_new, list):
        for trail in raw_new[:2]:
            if not isinstance(trail, dict):
                continue
            name = compact_whitespace(trail.get("name"))[:120]
            reason = compact_whitespace(trail.get("reason"))[:320]
            if len(name) >= 3 and len(reason) >= 15:
                new_trails.append({"name": name, "reason": reason})

    return {
        "profile": profile,
        "themes": themes,
        "joinTrailIds": join_ids,
        "newTrails": new_trails,
    }


def source_review_prompt(
    source_id, source, source_content, trail_context, cache_anchor, total
):
    return f"""Review exactly one Memex source and update semantic trail candidates.

Return exactly one JSON object:
{{
  "profile": "concise association profile grounded in this source's content",
  "themes": ["specific theme", "place/entity/concept"],
  "joinTrailIds": [1, 4],
  "newTrails": [
    {{
      "name": "specific reusable trail name",
      "reason": "why this source belongs on this trail and what connection it represents"
    }}
  ]
}}

Rules:
- Review the actual source content, not only its title or filename.
- The current source application ID is shown below; never reproduce its alias.
- joinTrailIds may contain 0-3 IDs and MUST use only T numbers displayed below.
- Create 0-2 new candidate trails. If no displayed trail fits a substantive source,
  create at least one specific candidate trail; singleton candidates are allowed now
  because later sources may join them.
- Prefer reusable semantic, geographic, chronological, evidential, technical,
  biographical, or conceptual trails over generic document-type categories.
- A source may belong to multiple trails only when connections are genuinely distinct.
- Keep profile under 420 characters and themes to at most 8 short values.
- Do not invent facts beyond this source content.
- JSON only.

{cache_anchor}

END STATIC CACHE ANCHOR

CANDIDATE TRAIL SHORTLIST (live, may change every source):
{trail_context}

SOURCE {source_id} OF {total}
TITLE:
{source["title"]}

INDEX SUMMARY:
{source["summary"] or "(none)"}

SOURCE CONTENT (current source only):
{source_content}
"""


def escape_control_chars_in_json_strings(value):
    result = []
    in_string = False
    escaped = False
    for char in value:
        if in_string:
            if escaped:
                result.append(char)
                escaped = False
                continue
            if char == "\\":
                result.append(char)
                escaped = True
                continue
            if char == '"':
                result.append(char)
                in_string = False
                continue
            code = ord(char)
            if code < 0x20:
                result.append(f"\\u{code:04x}")
            else:
                result.append(char)
            continue

        result.append(char)
        if char == '"':
            in_string = True
    return "".join(result)


def repair_common_json_errors(raw):
    repaired = escape_control_chars_in_json_strings(raw)
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    # Models sometimes echo displayed trail IDs as bare T12 tokens. Convert
    # only tokens in value/list positions; validation still range-checks them.
    repaired = re.sub(
        r'(?P<prefix>[:\[,]\s*)T(?P<id>\d+)(?=\s*[,\]])',
        lambda match: f'{match.group("prefix")}"{match.group("id")}"',
        repaired,
    )
    return repaired


def loose_string_field(raw, key):
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"', raw, flags=re.I)
    if not match:
        return ""
    index = match.end()
    result = []
    escaped = False
    while index < len(raw):
        char = raw[index]
        if escaped:
            result.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == '"':
            break
        else:
            result.append(char)
        index += 1
    return compact_whitespace("".join(result))


def loose_array_region(raw, key):
    match = re.search(rf'"{re.escape(key)}"\s*:\s*\[', raw, flags=re.I)
    if not match:
        return ""
    start = match.end()
    depth = 1
    in_string = False
    escaped = False
    for index in range(start, len(raw)):
        char = raw[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return raw[start:index]
    return raw[start:]


def loose_source_decision(raw):
    profile = loose_string_field(raw, "profile")
    themes_region = loose_array_region(raw, "themes")
    themes = [
        compact_whitespace(value)
        for value in re.findall(r'"([^"\n]{1,120})"', themes_region)
    ][:8]

    join_region = loose_array_region(raw, "joinTrailIds")
    join_ids = [int(value) for value in re.findall(r'(?:T)?(\d+)', join_region)][:3]

    new_region = loose_array_region(raw, "newTrails")
    new_trails = []
    cursor = 0
    while len(new_trails) < 2:
        name_match = re.search(r'"name"\s*:\s*"', new_region[cursor:], flags=re.I)
        if not name_match:
            break
        absolute = cursor + name_match.start()
        fragment = new_region[absolute:]
        name = loose_string_field(fragment, "name")
        reason = loose_string_field(fragment, "reason")
        if name and reason:
            new_trails.append({"name": name, "reason": reason})
        cursor = absolute + max(name_match.end(), 6)

    return {
        "profile": profile,
        "themes": themes,
        "joinTrailIds": join_ids,
        "newTrails": new_trails,
    }


def parse_source_decision(raw, trails):
    errors = []
    candidates = [raw, repair_common_json_errors(raw)]
    for candidate in candidates:
        try:
            return validate_source_decision(extract_json_object(candidate), trails)
        except (ValueError, json.JSONDecodeError) as exc:
            errors.append(str(exc))

    try:
        return validate_source_decision(loose_source_decision(raw), trails)
    except ValueError as exc:
        errors.append(str(exc))

    raise ValueError("; ".join(dict.fromkeys(errors)))


def review_one_source_with_trails(
    settings, source_id, source, source_content, trails, trail_context,
    cache_anchor, total
):
    system_prompt = (
        "You review exactly one Memex source at a time and build durable semantic "
        "trail candidates. Return JSON only. Trail IDs are numeric identifiers "
        "provided by the application; never invent or rewrite source aliases."
    )
    prompt = source_review_prompt(
        source_id, source, source_content, trail_context, cache_anchor, total
    )

    # Exactly one LLM call per source. parse_source_decision() already performs
    # deterministic local repair. A second corrective prompt on slot 0 would
    # replace the resident common prefix with a one-off repair prompt.
    raw = llm_chat(settings, prompt, system_prompt)
    try:
        return parse_source_decision(raw, trails)
    except (ValueError, json.JSONDecodeError) as exc:
        out(
            f"source {source_id} validation failed; "
            f"deferred without slot-0 repair call: {exc}"
        )
        raise RuntimeError(
            f"source {source_id} review invalid; deferred to preserve slot-0 KV: {exc}"
        ) from exc


def add_source_to_trail(trail, source_id, max_members=32):
    members = trail.setdefault("sourceIds", [])
    if source_id in members:
        return False
    if len(members) >= max_members:
        return False
    members.append(source_id)
    return True


def apply_source_decision(state, source_id, decision):
    trails = state["trails"]
    by_id = {int(trail["id"]): trail for trail in trails}

    joined = []
    for trail_id in decision["joinTrailIds"]:
        trail = by_id.get(trail_id)
        if trail and add_source_to_trail(trail, source_id):
            joined.append(trail_id)

    by_name = {normalize_name(trail.get("name")): trail for trail in trails}
    created = []
    for proposal in decision["newTrails"]:
        if len(trails) >= 192:
            break
        key = normalize_name(proposal["name"])
        if not key:
            continue
        existing = by_name.get(key)
        if existing:
            if add_source_to_trail(existing, source_id):
                joined.append(int(existing["id"]))
            continue

        trail_id = int(state["nextTrailId"])
        state["nextTrailId"] = trail_id + 1
        trail = {
            "id": trail_id,
            "name": proposal["name"],
            "reason": proposal["reason"],
            "sourceIds": [source_id],
        }
        trails.append(trail)
        by_name[key] = trail
        created.append(trail_id)

    state["profiles"][str(source_id)] = {
        "profile": decision["profile"],
        "themes": decision["themes"],
        "trailIds": sorted(set(joined + created)),
    }


def fetch_source_content(alias, token):
    last_error = None
    for attempt in range(1, 4):
        try:
            return api_get_note(alias, token)
        except Exception as exc:
            last_error = exc
            if attempt < 3:
                time.sleep(1.0 * attempt)
    raise RuntimeError(f"unable to read source {alias}: {last_error}")


def exact_name_merge(trails):
    merged = []
    by_name = {}
    for trail in sorted(trails, key=lambda item: int(item["id"])):
        key = normalize_name(trail.get("name"))
        if not key:
            continue
        existing = by_name.get(key)
        if existing is None:
            clone = {
                "id": int(trail["id"]),
                "name": compact_whitespace(trail.get("name"))[:120],
                "reason": compact_whitespace(trail.get("reason"))[:320],
                "sourceIds": list(dict.fromkeys(trail.get("sourceIds") or [])),
            }
            merged.append(clone)
            by_name[key] = clone
            continue
        for source_id in trail.get("sourceIds") or []:
            if source_id not in existing["sourceIds"] and len(existing["sourceIds"]) < 32:
                existing["sourceIds"].append(source_id)
        if len(compact_whitespace(trail.get("reason"))) > len(existing["reason"]):
            existing["reason"] = compact_whitespace(trail.get("reason"))[:320]
    return merged


def validate_merge_plan(value, trails):
    valid_ids = {int(trail["id"]) for trail in trails}
    raw_groups = value.get("mergeGroups")
    if not isinstance(raw_groups, list):
        raise ValueError("mergeGroups must be an array")

    groups = []
    already_used = set()
    for raw in raw_groups:
        if not isinstance(raw, dict):
            continue
        ids = parse_int_list(raw.get("trailIds"), valid_ids, 8)
        ids = [trail_id for trail_id in ids if trail_id not in already_used]
        if len(ids) < 2:
            continue
        name = compact_whitespace(raw.get("name"))[:120]
        reason = compact_whitespace(raw.get("reason"))[:320]
        if len(name) < 3 or len(reason) < 15:
            continue
        groups.append({"trailIds": ids, "name": name, "reason": reason})
        already_used.update(ids)
    return groups


def consolidate_trails(settings, trails, sources):
    trails = exact_name_merge(trails)
    if len(trails) < 2:
        return trails

    budget = max(14000, settings["maxPromptChars"] - 7000)
    try:
        context = compact_trail_context(trails, sources, budget)
    except RuntimeError as exc:
        out(f"CONSOLIDATION SKIPPED: {exc}")
        return trails

    system_prompt = (
        "You consolidate already-reviewed Memex trail candidates. No raw source "
        "content is being summarized now. Return JSON only and use only provided "
        "numeric trail IDs."
    )
    prompt = f"""Merge only clearly overlapping or equivalent candidate trails.

Every source has already been reviewed individually from its actual content.
Do not drop candidate trails merely to reduce count. A merge combines all members
of the listed trails. Leave unrelated trails unmentioned.

Return:
{{
  "mergeGroups": [
    {{
      "trailIds": [2, 17, 31],
      "name": "durable merged trail name",
      "reason": "concise reason describing the shared connection"
    }}
  ]
}}

Rules:
- Each merge group must contain 2-8 displayed trail IDs.
- A trail ID may appear in at most one merge group.
- Merge only genuinely overlapping semantic paths.
- Do not merge merely because sources share a broad location or document format.
- JSON only.

CANDIDATE TRAILS:
{context}
"""

    previous = ""
    last_error = ""
    groups = []
    for attempt in range(1, 3):
        current = prompt
        if attempt > 1:
            current += f"""

Previous response failed validation: {last_error}
Return corrected JSON only.
Previous response:
{previous[:16000]}
"""
        try:
            previous = llm_chat(settings, current, system_prompt)
            groups = validate_merge_plan(extract_json_object(previous), trails)
            break
        except Exception as exc:
            last_error = str(exc)
            out(f"consolidation validation attempt {attempt} failed: {last_error}")
    else:
        out("CONSOLIDATION WARNING: keeping deterministic candidate trails")
        return trails

    if not groups:
        return trails

    by_id = {int(trail["id"]): trail for trail in trails}
    consumed = set()
    replacements = []
    for group in groups:
        members = []
        for trail_id in group["trailIds"]:
            trail = by_id[trail_id]
            for source_id in trail.get("sourceIds") or []:
                if source_id not in members:
                    members.append(source_id)
        if len(members) > 32:
            continue
        primary_id = min(group["trailIds"])
        replacements.append(
            {
                "id": primary_id,
                "name": group["name"],
                "reason": group["reason"],
                "sourceIds": members,
            }
        )
        consumed.update(group["trailIds"])

    result = [trail for trail in trails if int(trail["id"]) not in consumed]
    result.extend(replacements)
    return exact_name_merge(result)


def validate_final_trails(trails, sources):
    valid_aliases = {source["alias"] for source in sources}
    normalized = []
    seen_names = set()
    seen_members = set()

    for trail in trails:
        if not isinstance(trail, dict):
            continue
        name = compact_whitespace(trail.get("name"))[:120]
        reason = compact_whitespace(trail.get("reason"))[:320]
        raw_aliases = trail.get("aliases")
        if not isinstance(raw_aliases, list):
            continue
        aliases = []
        for alias in raw_aliases:
            alias = str(alias).strip()
            if alias in valid_aliases and alias not in aliases:
                aliases.append(alias)
        if len(aliases) < 2 or len(aliases) > 32:
            continue
        if len(name) < 3 or len(reason) < 15:
            continue
        name_key = normalize_name(name)
        member_key = tuple(sorted(aliases))
        if name_key in seen_names or member_key in seen_members:
            continue
        seen_names.add(name_key)
        seen_members.add(member_key)
        normalized.append({"name": name, "reason": reason, "aliases": aliases})

    if not normalized:
        raise RuntimeError("No valid final trails remain")
    return normalized


def sequential_plan(index_markdown, sources, settings):
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    index_hash = sha256_text(index_markdown)
    path = work_file(index_hash, settings)
    state = load_or_create_work_state(
        path, index_markdown, sources, settings
    )
    reviewed = len(state.get("reviewedSourceIds") or [])
    if reviewed:
        out(f"resuming sequential review: {reviewed}/{len(sources)} sources complete")
        out(f"work state: {path}")

    token = read_token()
    total = len(sources)
    cache_anchor = build_cache_anchor(sources, TRAIL_CACHE_ANCHOR_CHARS)
    out(f"KV_CACHE_ANCHOR_CHARS: {len(cache_anchor)}")
    out(f"KV_CACHE_WORK_STATE: {path}")
    if not state.get("finalized"):
        reviewed_ids = {int(value) for value in state.get("reviewedSourceIds") or []}
        pending_ids = [
            source_id for source_id in range(1, total + 1)
            if source_id not in reviewed_ids
        ]
        if pending_ids and reviewed_ids:
            out(
                f"pending/unreviewed sources this pass: {len(pending_ids)} "
                f"(first={pending_ids[0]})"
            )

        for source_id in pending_ids:
            source = sources[source_id - 1]
            content = fetch_source_content(source["alias"], token)

            candidate_trails = shortlist_candidate_trails(
                state, source_id, source, content, sources
            )
            trail_context = compact_review_trail_context(
                candidate_trails, TRAIL_SHORTLIST_CONTEXT_CHARS
            )
            overhead = 6500 + len(cache_anchor) + len(trail_context)
            content_budget = max(
                10000,
                settings["maxPromptChars"] - overhead,
            )
            fitted_content, truncated = fit_text(content, content_budget)

            try:
                decision = review_one_source_with_trails(
                    settings,
                    source_id,
                    source,
                    fitted_content,
                    candidate_trails,
                    trail_context,
                    cache_anchor,
                    total,
                )
            except RuntimeError as exc:
                deferred = state.setdefault("deferredSourceIds", [])
                if source_id not in deferred:
                    deferred.append(source_id)
                state["nextSourceId"] = source_id + 1
                atomic_json_write(path, state)
                out(
                    f"DEFER {source_id}/{total} after invalid LLM response: {exc}"
                )
                continue

            apply_source_decision(state, source_id, decision)
            if source_id not in state["reviewedSourceIds"]:
                state["reviewedSourceIds"].append(source_id)
            deferred = state.setdefault("deferredSourceIds", [])
            state["deferredSourceIds"] = [
                value for value in deferred if int(value) != source_id
            ]
            state["nextSourceId"] = source_id + 1
            atomic_json_write(path, state)

            memberships = len(state["profiles"][str(source_id)]["trailIds"])
            out(
                f"REVIEW {source_id}/{total} "
                f"trails={len(state['trails'])} candidates={len(candidate_trails)} "
                f"memberships={memberships} "
                f"trail_ctx_chars={len(trail_context)} "
                f"prompt_source_chars={len(fitted_content)} "
                f"content_chars={len(content)}{' truncated' if truncated else ''}"
            )

        reviewed_ids = {int(value) for value in state.get("reviewedSourceIds") or []}
        remaining = [
            source_id for source_id in range(1, total + 1)
            if source_id not in reviewed_ids
        ]
        if remaining:
            state["nextSourceId"] = remaining[0]
            state["deferredSourceIds"] = remaining
            atomic_json_write(path, state)
            out("")
            out(f"DEFERRED_SOURCE_COUNT: {len(remaining)}")
            out("DEFERRED_SOURCE_IDS: " + ",".join(map(str, remaining)))
            raise RuntimeError(
                f"Sequential review incomplete: "
                f"{len(reviewed_ids)}/{total}; rerun Preview to retry "
                f"{len(remaining)} deferred source(s)"
            )

        out("")
        out("all source contents reviewed; consolidating candidate trails…")
        consolidated = consolidate_trails(
            settings, state["trails"], sources
        )
        # A second compact consolidation pass catches overlaps exposed by the first.
        consolidated = consolidate_trails(settings, consolidated, sources)

        final = []
        for trail in consolidated:
            source_ids = list(dict.fromkeys(trail.get("sourceIds") or []))
            if len(source_ids) < 2:
                continue
            final.append(
                {
                    "name": compact_whitespace(trail.get("name"))[:120],
                    "reason": compact_whitespace(trail.get("reason"))[:320],
                    "aliases": [sources[source_id - 1]["alias"] for source_id in source_ids],
                }
            )

        state["finalTrails"] = validate_final_trails(final, sources)
        state["finalized"] = True
        state["finalizedAt"] = datetime.now(timezone.utc).isoformat()
        atomic_json_write(path, state)

    if len(state.get("reviewedSourceIds") or []) != total:
        raise RuntimeError(
            f"Sequential review incomplete: "
            f"{len(state.get('reviewedSourceIds') or [])}/{total}"
        )

    return validate_final_trails(state.get("finalTrails") or [], sources), path

def render_trails(trails, sources):
    by_alias = {source["alias"]: source for source in sources}
    blocks = []

    for trail in trails:
        lines = [
            f'### {trail["name"]}',
            "",
            trail["reason"],
            "",
        ]
        for alias in trail["aliases"]:
            source = by_alias[alias]
            lines.append(
                f'- [{source["title"]}]({source["href"]})'
            )
        blocks.append("\n".join(lines))

    return "\n\n".join(blocks).rstrip() + "\n"


def replace_trails(index_markdown, trail_markdown):
    marker = "\n## Trails"
    position = index_markdown.find(marker)

    if position >= 0:
        prefix = index_markdown[:position].rstrip()
    else:
        prefix = index_markdown.rstrip()

    return (
        f"{prefix}\n\n## Trails\n\n"
        f"{trail_markdown.rstrip()}\n"
    )


def read_token():
    token = os.environ.get("MEMEX_API_TOKEN", "").strip()
    if token:
        return token

    for env_path in [ROOT / ".env", ROOT / ".env.memex"]:
        if not env_path.exists():
            continue

        for line in env_path.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            match = re.match(
                r"^\s*MEMEX_API_TOKEN\s*=\s*(.*?)\s*$", line
            )
            if not match:
                continue

            token = match.group(1).strip()
            if (
                len(token) >= 2
                and token[0] == token[-1]
                and token[0] in {"'", '"'}
            ):
                token = token[1:-1]
            if token:
                return token

    raise RuntimeError("MEMEX_API_TOKEN is not configured")


def api_headers(token):
    return {"Authorization": f"Bearer {token}"}


def api_get_note(alias, token):
    request = urllib.request.Request(
        f"{HEDGEDOC_NOTES_API}/{urllib.parse.quote(alias)}/content",
        headers=api_headers(token),
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8")


def api_put_note(alias, markdown, token):
    request = urllib.request.Request(
        f"{HEDGEDOC_NOTES_API}/{urllib.parse.quote(alias)}",
        data=markdown.encode("utf-8"),
        method="PUT",
        headers={
            **api_headers(token),
            "Content-Type": "text/markdown",
        },
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        response.read()


def atomic_write(path, content):
    temporary = path.with_name(
        f".{path.name}.trail-refresh-{os.getpid()}.tmp"
    )
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)


def preview_file(preview_hash):
    return BACKUP_ROOT / f"memex-trail-refresh-preview-{preview_hash}.json"


def preview():
    index_markdown = INDEX_PATH.read_text(encoding="utf-8")
    sources = parse_sources(index_markdown)
    settings = load_model_settings()

    out("=== MEMEX SEQUENTIAL LLM TRAIL REFRESH ===")
    out("mode: PREVIEW")
    out(f"started: {datetime.now(timezone.utc).isoformat()}")
    out(f"sources: {len(sources)}")
    out(f"current trails: {current_trail_count(index_markdown)}")
    out(f'provider: {settings["provider"]}')
    out(f'model: {settings["model"]}')
    out("review mode: one source content per LLM call")
    out("KV cache mode: stable catalogue prefix + live trail state")
    out("fresh work state: kv3 (starts at source 1)")
    out("source mutation: disabled")
    out("user trail mutation: disabled")
    out("")

    trails, work_path = sequential_plan(
        index_markdown, sources, settings
    )
    trail_markdown = render_trails(trails, sources)
    coverage = len(
        {
            alias
            for trail in trails
            for alias in trail["aliases"]
        }
    )
    reviewed = len(sources)
    unassociated = reviewed - coverage

    core = {
        "version": 3,
        "indexHash": sha256_text(index_markdown),
        "sourceSectionHash": sha256_text(source_section(index_markdown)),
        "sourceCount": len(sources),
        "reviewedSourceCount": reviewed,
        "provider": settings["provider"],
        "model": settings["model"],
        "trails": trails,
        "trailMarkdown": trail_markdown,
    }

    preview_hash = sha256_text(
        json.dumps(core, sort_keys=True, ensure_ascii=False)
    )
    payload = {
        **core,
        "previewHash": preview_hash,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceCoverage": coverage,
        "unassociatedSourceCount": unassociated,
        "workState": str(work_path),
    }

    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    preview_path = preview_file(preview_hash)
    preview_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    out("")
    out("=== PROPOSED TRAILS ===")
    for index, trail in enumerate(trails, 1):
        out(
            f'[{index:02d}] {trail["name"]} '
            f'({len(trail["aliases"])} sources)'
        )

    out("")
    out(f"SOURCES_REVIEWED: {reviewed}/{len(sources)}")
    out(f"TRAIL_COUNT: {len(trails)}")
    out(f"SOURCE_COVERAGE: {coverage}")
    out(f"UNASSOCIATED_SOURCE_COUNT: {unassociated}")
    out(f"PREVIEW_HASH: {preview_hash}")
    out("CONFIRMATION_REQUIRED: APPLY")
    out(f"work state: {work_path}")
    out(f"preview plan: {preview_path}")
    out("")
    out("PREVIEW COMPLETE: no Memex index content was changed.")

def apply(preview_hash, confirmation):
    if confirmation != "APPLY":
        raise RuntimeError("Apply requires confirmation APPLY")
    if not re.fullmatch(r"[0-9a-f]{64}", preview_hash):
        raise RuntimeError("Invalid preview hash")

    plan_path = preview_file(preview_hash)
    if not plan_path.exists():
        raise RuntimeError(
            f"Preview plan is missing: {plan_path}"
        )

    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("previewHash") != preview_hash:
        raise RuntimeError("Preview plan hash does not match filename")

    plan_core = {
        "version": plan.get("version"),
        "indexHash": plan.get("indexHash"),
        "sourceSectionHash": plan.get("sourceSectionHash"),
        "sourceCount": plan.get("sourceCount"),
        "reviewedSourceCount": plan.get("reviewedSourceCount"),
        "provider": plan.get("provider"),
        "model": plan.get("model"),
        "trails": plan.get("trails"),
        "trailMarkdown": plan.get("trailMarkdown"),
    }
    recomputed_hash = sha256_text(
        json.dumps(plan_core, sort_keys=True, ensure_ascii=False)
    )
    if recomputed_hash != preview_hash:
        raise RuntimeError("Preview plan contents fail hash verification")

    current_index = INDEX_PATH.read_text(encoding="utf-8")
    current_sources = parse_sources(current_index)

    if sha256_text(current_index) != plan.get("indexHash"):
        raise RuntimeError(
            "STALE PREVIEW: memex/index.md changed; generate a new preview"
        )
    if (
        sha256_text(source_section(current_index))
        != plan.get("sourceSectionHash")
    ):
        raise RuntimeError(
            "STALE PREVIEW: source catalogue changed; generate a new preview"
        )

    if plan.get("reviewedSourceCount") != len(current_sources):
        raise RuntimeError(
            "Refusing apply: preview did not review every current source"
        )

    trails = validate_final_trails(plan.get("trails") or [], current_sources)
    trail_markdown = render_trails(trails, current_sources)
    updated_index = replace_trails(current_index, trail_markdown)

    if (
        sha256_text(source_section(updated_index))
        != plan.get("sourceSectionHash")
    ):
        raise RuntimeError("Refusing apply: source catalogue would change")

    token = read_token()
    original_mirror = api_get_note(INDEX_MIRROR_ALIAS, token)

    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%d-%H%M%SZ")
    snapshot = BACKUP_ROOT / f"memex-trail-refresh-{stamp}"
    snapshot.mkdir(parents=True, exist_ok=False)

    (snapshot / "memex-index.md").write_text(
        current_index, encoding="utf-8"
    )
    (snapshot / "memex-index-mirror.md").write_text(
        original_mirror, encoding="utf-8"
    )
    shutil.copy2(plan_path, snapshot / "preview-plan.json")
    (snapshot / "manifest.json").write_text(
        json.dumps(
            {
                "createdAt": now.isoformat(),
                "purpose": "pre-LLM-system-trail-refresh snapshot",
                "previewHash": preview_hash,
                "sourceCount": len(current_sources),
                "reviewedSourceCount": plan.get("reviewedSourceCount"),
                "sourceCoverage": plan.get("sourceCoverage"),
                "unassociatedSourceCount": plan.get("unassociatedSourceCount"),
                "oldTrailCount": current_trail_count(current_index),
                "newTrailCount": len(trails),
                "sourcesPreserved": True,
                "userTrailsPreserved": True,
                "mirrorAlias": INDEX_MIRROR_ALIAS,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    out("=== MEMEX LLM TRAIL REFRESH ===")
    out("mode: APPLY")
    out(f"snapshot: {snapshot}")
    out(f"sources preserved: {len(current_sources)}")
    out(f"old trails: {current_trail_count(current_index)}")
    out(f"new trails: {len(trails)}")
    out("")

    try:
        atomic_write(INDEX_PATH, updated_index)
        out("LOCAL INDEX UPDATED")

        api_put_note(INDEX_MIRROR_ALIAS, updated_index, token)
        out("HEDGEDOC MIRROR UPDATED")
    except Exception:
        atomic_write(INDEX_PATH, current_index)
        try:
            api_put_note(INDEX_MIRROR_ALIAS, original_mirror, token)
        except Exception as rollback_error:
            out(f"ROLLBACK WARNING: {rollback_error}")
        raise

    verified = INDEX_PATH.read_text(encoding="utf-8")
    verified_sources = parse_sources(verified)

    if len(verified_sources) != len(current_sources):
        raise RuntimeError("Verification failed: source count changed")
    if (
        sha256_text(source_section(verified))
        != plan.get("sourceSectionHash")
    ):
        raise RuntimeError("Verification failed: source section changed")

    out("")
    out("=== VERIFY ===")
    out(f"VERIFY_SOURCE_COUNT: {len(verified_sources)}")
    out(f"VERIFY_TRAIL_COUNT: {current_trail_count(verified)}")
    out("VERIFY_SOURCES_PRESERVED: yes")
    out("VERIFY_USER_TRAILS_PRESERVED: yes")
    out(f"snapshot: {snapshot}")
    out("APPLY COMPLETE")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--action", choices=["preview", "apply"], required=True
    )
    parser.add_argument("--preview-hash", default="")
    parser.add_argument("--confirmation", default="")
    args = parser.parse_args()

    try:
        if args.action == "preview":
            preview()
        else:
            apply(args.preview_hash, args.confirmation)
    except KeyboardInterrupt:
        out("FATAL: trail refresh interrupted")
        return 130
    except Exception as exc:
        out(f"FATAL: {exc}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
