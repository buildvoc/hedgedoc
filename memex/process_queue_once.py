#!/usr/bin/env python3

import json
import os
import re
import urllib.request
import urllib.error
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path

API = "http://127.0.0.1:3100/api/v2/notes"
MODEL_SETTINGS_PATH = Path(
    os.environ.get("MEMEX_MODEL_SETTINGS_PATH", "memex/model-settings.json")
)
RECOMMENDATIONS_FILE = Path(
    os.environ.get(
        "MEMEX_ASSOCIATION_RECOMMENDATIONS_FILE",
        "memex/association-recommendations.jsonl",
    )
)
WIKI_MAINTAIN_URL = os.environ.get(
    "MEMEX_WIKI_MAINTAIN_URL",
    "http://127.0.0.1:3101/memex-wiki-maintain",
).rstrip("/")
WIKI_CONTEXT_MAX_PAGES = max(
    1, int(os.environ.get("MEMEX_WIKI_CONTEXT_MAX_PAGES", "12"))
)
WIKI_CONTEXT_MAX_CHARS = max(
    4000, int(os.environ.get("MEMEX_WIKI_CONTEXT_MAX_CHARS", "24000"))
)
WIKI_PAGE_TYPES = {
    "source-summary",
    "entity",
    "topic",
    "comparison",
    "synthesis",
}


def load_model_settings():
    settings = {}
    if MODEL_SETTINGS_PATH.exists():
        value = json.loads(MODEL_SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            settings = value

    provider = str(
        settings.get("provider")
        or os.environ.get("MEMEX_LLM_BACKEND", "ollama")
    ).strip().lower()

    if provider not in ("ollama", "llamacpp"):
        raise ValueError(f"Unsupported Memex provider: {provider}")

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
        default_model = str(
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
        default_model = str(
            value("defaultModel", "MEMEX_MODEL", "gemma4:26b")
        )

    return {
        "provider": provider,
        "baseUrl": base_url,
        "defaultModel": default_model,
        "numCtx": int(value("numCtx", "MEMEX_NUM_CTX", 32768)),
        "maxPromptChars": int(
            value("maxPromptChars", "MEMEX_PROMPT_DOC_CHARS", 80000)
        ),
        "timeoutSeconds": int(
            value("timeoutSeconds", "MEMEX_TIMEOUT_SECONDS", 600)
        ),
        "temperature": float(
            value("temperature", "MEMEX_TEMPERATURE", 0.35)
        ),
    }

MODEL_SETTINGS = load_model_settings()
MODEL = MODEL_SETTINGS["defaultModel"]
LLM_BACKEND = MODEL_SETTINGS["provider"]

OLLAMA = f'{MODEL_SETTINGS["baseUrl"]}/api/chat'
LLAMACPP_BASE_URL = MODEL_SETTINGS["baseUrl"]
LLAMACPP_MODEL = MODEL_SETTINGS["defaultModel"]
LLAMACPP_MAX_TOKENS = int(
    os.environ.get("MEMEX_LLAMACPP_MAX_TOKENS", "8192")
)
NUM_CTX = MODEL_SETTINGS["numCtx"]
MAX_PROMPT_DOC_CHARS = MODEL_SETTINGS["maxPromptChars"]
TIMEOUT_SECONDS = MODEL_SETTINGS["timeoutSeconds"]
TEMPERATURE = MODEL_SETTINGS["temperature"]
NODEBOOK = "memex-network"

TOKEN = os.environ["MEMEX_API_TOKEN"]
QUEUE = Path("memex/queue.jsonl")
BATCH_BASELINE_ALIASES = tuple(
    alias.strip()
    for alias in os.environ.get("MEMEX_BATCH_BASELINE_ALIASES", "").split(",")
    if alias.strip()
)


def llm_chat(prompt, num_ctx=None, system_prompt=None):
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    if LLM_BACKEND == "ollama":
        payload = {
            "model": MODEL,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": TEMPERATURE,
                "num_ctx": num_ctx or NUM_CTX,
            },
        }
        endpoint = OLLAMA
    elif LLM_BACKEND == "llamacpp":
        payload = {
            "model": LLAMACPP_MODEL,
            "messages": messages,
            "stream": False,
            "temperature": TEMPERATURE,
            "max_tokens": LLAMACPP_MAX_TOKENS,
            "reasoning_effort": "none",
            "cache_prompt": True,
            "id_slot": 0,
        }
        endpoint = f"{LLAMACPP_BASE_URL}/chat/completions"
    else:
        raise ValueError(f"Unsupported MEMEX_LLM_BACKEND: {LLM_BACKEND}")

    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            outer = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")

        peg_failure = (
            LLM_BACKEND == "llamacpp"
            and exc.code == 500
            and "does not match the expected peg-gemma4 format" in detail
        )

        if not peg_failure:
            raise RuntimeError(
                f"llama.cpp HTTP {exc.code}: {detail[:1000]}"
            ) from exc

        print(
            "MEMEX llama.cpp peg-gemma4 parse failure; "
            "retrying via apply-template -> completion",
            flush=True,
        )

        base = LLAMACPP_BASE_URL.rstrip("/")
        if base.endswith("/v1"):
            server_root = base[:-3]
        else:
            server_root = base

        template_req = urllib.request.Request(
            f"{server_root}/apply-template",
            data=json.dumps({"messages": messages}).encode(),
            headers={"Content-Type": "application/json"},
        )

        with urllib.request.urlopen(
            template_req, timeout=TIMEOUT_SECONDS
        ) as response:
            template_outer = json.loads(response.read().decode())

        raw_prompt = template_outer.get("prompt")
        if not isinstance(raw_prompt, str) or not raw_prompt:
            raise RuntimeError(
                "llama.cpp /apply-template returned no prompt"
            )

        completion_payload = {
            "prompt": raw_prompt,
            "stream": False,
            "temperature": TEMPERATURE,
            "n_predict": LLAMACPP_MAX_TOKENS,
            "cache_prompt": True,
            "id_slot": 0,
        }

        completion_req = urllib.request.Request(
            f"{server_root}/completion",
            data=json.dumps(completion_payload).encode(),
            headers={"Content-Type": "application/json"},
        )

        with urllib.request.urlopen(
            completion_req, timeout=TIMEOUT_SECONDS
        ) as response:
            completion_outer = json.loads(response.read().decode())

        content = completion_outer.get("content", "")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError(
                "llama.cpp raw completion fallback returned no content"
            )

        print(
            "MEMEX llama.cpp raw completion fallback succeeded",
            flush=True,
        )
        return content

    if LLM_BACKEND == "ollama":
        return outer.get("message", {}).get("content", "")

    choices = outer.get("choices") or []
    if not choices:
        raise ValueError("llama.cpp response contained no choices")

    usage = outer.get("usage") or {}
    prompt_details = usage.get("prompt_tokens_details") or {}
    timings = outer.get("timings") or {}
    cached_tokens = prompt_details.get("cached_tokens")
    if cached_tokens is None:
        cached_tokens = timings.get("cache_n")
    print(
        "MEMEX llama.cpp telemetry:",
        f"prompt={usage.get('prompt_tokens', '?')}",
        f"cached={cached_tokens if cached_tokens is not None else '?'}",
        f"prompt_ms={timings.get('prompt_ms', '?')}",
        f"generated={timings.get('predicted_n', '?')}",
        f"generation_ms={timings.get('predicted_ms', '?')}",
    )

    return choices[0].get("message", {}).get("content", "")


def api_get(path):
    req = urllib.request.Request(
        f"{API}/{path}",
        headers={"Authorization": f"Bearer {TOKEN}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode()


def api_put(alias, content):
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


def wiki_json_request(url, method="GET", payload=None):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        body = response.read().decode()

    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError(f"Memex wiki endpoint returned non-object JSON: {url}")
    return value


def wiki_source_aliases(markdown):
    frontmatter_match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", markdown)
    if not frontmatter_match:
        return []

    aliases = []
    for match in re.finditer(
        r"(?m)^\s*-\s*[\"']?https?://[^\s\"']+/n/"
        r"([A-Za-z0-9_-]{1,160})[\"']?\s*$",
        frontmatter_match.group(1),
    ):
        alias = match.group(1)
        if alias not in aliases:
            aliases.append(alias)
    return aliases


def wiki_source_anchor(markdown):
    frontmatter_match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", markdown)
    if not frontmatter_match:
        return ""

    match = re.search(
        r"(?m)^memex_source_anchor:\s*(.+?)\s*$",
        frontmatter_match.group(1),
    )
    if not match:
        return ""

    value = match.group(1).strip()
    if value.startswith(('"', "'")) and value.endswith(value[0]):
        value = value[1:-1].strip()
    return value if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,159}", value) else ""


def wiki_heading_anchor(value):
    text = re.sub(r"[`*_~]", "", value).strip().casefold()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s-]+", "-", text).strip("-")
    return text[:160]


def wiki_body_heading_anchors(body):
    anchors = []
    for match in re.finditer(r"(?m)^#{2,6}\s+(.+?)\s*#*\s*$", body):
        anchor = wiki_heading_anchor(match.group(1))
        if anchor and anchor not in anchors:
            anchors.append(anchor)
    return anchors


def memex_source_summary_target_metadata(body, verified_document_pages, inline_pages):
    """Metadata of the NEW summary, not stale/extractive earlier revisions.

    sourcePages is the verified original-document page scope, not a claim that
    every sentence has a supporting inline citation. sourceAnchor links to the
    first substantive thematic section, skipping generic opening headings.
    If no substantive section exists, keep the first valid heading rather than
    inventing an anchor that does not exist in the Markdown.
    """
    page_scope = sorted({int(p) for p in (verified_document_pages or [])
                         if str(p).isdigit() and 0 < int(p) <= 100000})
    pages = page_scope or sorted({int(p) for p in inline_pages if str(p).isdigit()})
    sections = wiki_body_heading_anchors(body)
    generic_sections = {
        "overview", "summary", "introduction", "executive-summary",
        "document-overview", "source-summary", "abstract", "background",
    }
    thematic = next((anchor for anchor in sections
                    if anchor not in generic_sections), None)
    return pages, (thematic or (sections[0] if sections else ""))


def wiki_body_source_pages(body):
    pages = set()
    for match in re.finditer(
        r"<!--\s*memex-source-pages:\s*([0-9,\s-]+)\s*-->",
        body,
        flags=re.I,
    ):
        for token in match.group(1).split(","):
            token = token.strip()
            range_match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", token)
            if range_match:
                start, end = map(int, range_match.groups())
                if start <= end and end - start <= 200:
                    pages.update(range(start, end + 1))
                continue
            if token.isdigit():
                pages.add(int(token))
    return sorted(page for page in pages if page > 0)


def wiki_body_unmarked_factual_blocks(body):
    marker_re = re.compile(
        r"<!--\s*memex-source-pages:\s*[0-9,\s-]+\s*-->",
        flags=re.I,
    )
    list_re = re.compile(r"^(\s*)(?:[-*+]\s+|\d+[.)]\s+)")
    heading_re = re.compile(r"^\s*#{1,6}\s+")
    fence_re = re.compile(r"^\s*(```|~~~)")
    horizontal_re = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
    standalone_comment_re = re.compile(r"^\s*<!--[\s\S]*-->\s*$")
    lines = body.splitlines()
    violations = []
    in_fence = False

    def next_nonempty(index):
        for candidate_index in range(index + 1, len(lines)):
            candidate = lines[candidate_index]
            if candidate.strip():
                return candidate
        return ""

    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if fence_re.match(line):
            in_fence = not in_fence
            index += 1
            continue
        if (
            in_fence
            or not stripped
            or heading_re.match(line)
            or horizontal_re.match(line)
        ):
            index += 1
            continue
        if standalone_comment_re.fullmatch(line):
            index += 1
            continue

        list_match = list_re.match(line)
        if list_match:
            indent = len(list_match.group(1).replace("\t", "    "))
            block = [stripped]
            end = index + 1

            while end < len(lines):
                candidate = lines[end]
                candidate_stripped = candidate.strip()
                if (
                    not candidate_stripped
                    or heading_re.match(candidate)
                    or fence_re.match(candidate)
                ):
                    break

                child_match = list_re.match(candidate)
                if child_match:
                    break

                block.append(candidate_stripped)
                end += 1

            block_text = " ".join(block)
            if not marker_re.search(block_text):
                following = next_nonempty(index)
                child_match = list_re.match(following) if following else None
                child_indent = (
                    len(child_match.group(1).replace("\t", "    "))
                    if child_match
                    else -1
                )
                # Markdown emphasis can wrap a pure nested-list label:
                # * **Fire-Resisting Glazing Types:**
                # This is a section label, not a factual statement. Still
                # require actual indented children; other uncited bullets
                # remain invalid.
                intro = re.sub(r"(?:\*\*|__|`)+\s*$", "", stripped).rstrip()
                is_list_container = (
                    intro.endswith(":")
                    and child_match is not None
                    and child_indent > indent
                )
                if not is_list_container:
                    violations.append(block_text[:220])

            index = max(end, index + 1)
            continue

        block = [stripped]
        end = index + 1

        while end < len(lines):
            candidate = lines[end]
            candidate_stripped = candidate.strip()
            if (
                not candidate_stripped
                or heading_re.match(candidate)
                or fence_re.match(candidate)
                or list_re.match(candidate)
            ):
                break
            if (
                standalone_comment_re.fullmatch(candidate)
                and not marker_re.search(candidate)
            ):
                break

            block.append(candidate_stripped)
            end += 1

        block_text = " ".join(block)
        if not marker_re.search(block_text):
            following = next_nonempty(end - 1)
            is_list_intro = (
                block_text.endswith(":")
                and bool(list_re.match(following))
            )
            if not is_list_intro:
                violations.append(block_text[:220])

        index = max(end, index + 1)

    return violations


def remove_uncited_wiki_source_summary_blocks(body):
    """Conservatively discard uncited factual blocks, never invent citations.

    Used only when verified Docling excerpt recovery is unavailable AND the
    model summary already contains at least one verified inline page citation.
    Keep Markdown section headings, source-cited paragraphs/list items, and
    genuine nested-list labels. Re-check with the strict validator afterwards.
    """
    marker_re = re.compile(
        r"<!--\s*memex-source-pages:\s*[0-9,\s-]+\s*-->", re.I
    )
    list_re = re.compile(r"^(\s*)(?:[-*+]\s+|\d+[.)]\s+)")
    heading_re = re.compile(r"^\s*#{1,6}\s+")
    fence_re = re.compile(r"^\s*(```|~~~)")
    horizontal_re = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
    standalone_comment_re = re.compile(r"^\s*<!--[\s\S]*-->\s*$")

    def one_pass(text):
        lines = text.splitlines(keepends=True)
        kept = []
        removed = 0
        in_fence = False
        index = 0

        def next_nonempty(start):
            for candidate in lines[start + 1:]:
                if candidate.strip():
                    return candidate
            return ""

        while index < len(lines):
            line = lines[index]
            stripped = line.strip()
            if fence_re.match(line):
                in_fence = not in_fence
                kept.append(line)
                index += 1
                continue
            if (
                in_fence or not stripped or heading_re.match(line)
                or horizontal_re.match(line)
                or standalone_comment_re.fullmatch(line)
            ):
                kept.append(line)
                index += 1
                continue

            list_match = list_re.match(line)
            end = index + 1
            if list_match:
                while end < len(lines):
                    candidate = lines[end]
                    if (
                        not candidate.strip() or heading_re.match(candidate)
                        or fence_re.match(candidate) or list_re.match(candidate)
                    ):
                        break
                    end += 1
                block_text = " ".join(s.strip() for s in lines[index:end])
                following = next_nonempty(index)
                child_match = list_re.match(following) if following else None
                child_indent = (
                    len(child_match.group(1).replace("\t", "    "))
                    if child_match else -1
                )
                indent = len(list_match.group(1).replace("\t", "    "))
                intro = re.sub(r"(?:\*\*|__|`)+\s*$", "", stripped).rstrip()
                container = (
                    intro.endswith(":") and child_match is not None
                    and child_indent > indent
                )
                keep = bool(marker_re.search(block_text)) or container
            else:
                while end < len(lines):
                    candidate = lines[end]
                    if (
                        not candidate.strip() or heading_re.match(candidate)
                        or fence_re.match(candidate) or list_re.match(candidate)
                        or (
                            standalone_comment_re.fullmatch(candidate)
                            and not marker_re.search(candidate)
                        )
                    ):
                        break
                    end += 1
                block_text = " ".join(s.strip() for s in lines[index:end])
                following = next_nonempty(end - 1)
                intro = block_text.rstrip()
                container = (
                    intro.endswith(":") and bool(list_re.match(following))
                )
                keep = bool(marker_re.search(block_text)) or container

            if keep:
                kept.extend(lines[index:end])
            else:
                removed += 1
            index = end

        return "".join(kept), removed

    # Nested container labels can become orphaned after dropping uncited
    # children. Repeat until stable; no source text is ever added or rewritten.
    total = 0
    for _ in range(24):
        body_next, removed = one_pass(body)
        total += removed
        body = body_next
        if not removed:
            break
    return body, total


def remap_wiki_source_page_markers(body, source_page_map):
    if not source_page_map:
        return body, 0

    source_pages = set(source_page_map.values())
    remapped_markers = 0
    marker_re = re.compile(
        r"<!--\s*memex-source-pages:\s*([0-9,\s-]+)\s*-->",
        flags=re.I,
    )

    def replace_marker(match):
        nonlocal remapped_markers

        values = []
        changed = False

        for token in match.group(1).split(","):
            token = token.strip()
            range_match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", token)

            if range_match:
                start, end = map(int, range_match.groups())
                if start > end or end - start > 200:
                    return match.group(0)
                raw_values = range(start, end + 1)
            elif token.isdigit():
                raw_values = [int(token)]
            else:
                return match.group(0)

            for value in raw_values:
                if value in source_pages:
                    mapped = value
                elif value in source_page_map:
                    mapped = source_page_map[value]
                    changed = changed or mapped != value
                else:
                    mapped = value
                if mapped not in values:
                    values.append(mapped)

        if not changed:
            return match.group(0)

        remapped_markers += 1
        return (
            "<!-- memex-source-pages: "
            + ", ".join(str(value) for value in values)
            + " -->"
        )

    return marker_re.sub(replace_marker, body), remapped_markers


def filter_unverified_wiki_source_page_markers(body, allowed_source_pages):
    """Keep only verified printed-page citations; never guess replacements.

    Source-page markers may contain individual pages or ranges. Work *after*
    extraction-local page remapping, so only genuinely verified printed pages
    survive. The existing validator still rejects unsourced factual blocks:
    removing a marker is not permission to publish an unsupported claim.
    """
    allowed = {int(page) for page in allowed_source_pages if int(page) > 0}
    if not allowed:
        return body, 0, []

    marker_re = re.compile(
        r"<!--\s*memex-source-pages:\s*([0-9,\s-]+)\s*-->",
        flags=re.I,
    )
    changed = 0
    removed_pages = set()

    def keep_verified(match):
        nonlocal changed
        cited = wiki_body_source_pages(match.group(0))
        verified = [number for number in cited if number in allowed]
        removed_pages.update(set(cited) - allowed)

        if len(verified) == len(cited) and cited:
            return match.group(0)

        changed += 1
        if not verified:
            return ""
        return "<!-- memex-source-pages: " + ", ".join(map(str, verified)) + " -->"

    filtered = marker_re.sub(keep_verified, body)
    return filtered, changed, sorted(removed_pages)




def enrich_synthesized_memex_citations(body, source_text, source_page_map, allowed_source_pages):
    """Conservatively annotate original synthesis using verified Docling text.

    Does not send additional LLM prompts or rewrite any factual words. A source
    A page is attributed only from original Docling provenance. On a
    single-verified-page source, attribution is possible without pretending
    to have fact-checked a paraphrase. On multi-page sources, ambiguous page
    matches are left uncited. No factual text is changed or LLM call made.
    """
    if not (isinstance(body, str) and isinstance(source_text, str)
            and source_page_map and allowed_source_pages):
        return body, 0
    if os.environ.get("MEMEX_CITATION_ENRICHMENT", "1") == "0":
        return body, 0
    start = source_text.find("{")
    if start < 0:
        return body, 0
    try:
        document, _ = json.JSONDecoder().raw_decode(source_text[start:])
    except (ValueError, TypeError):
        return body, 0
    if not isinstance(document, dict) or document.get("schema_name") != "DoclingDocument":
        return body, 0

    allowed = {int(page) for page in allowed_source_pages if str(page).isdigit()}
    # Ignore common vocabulary: matching page citations requires *content* terms.
    stop = {
        "about", "above", "after", "again", "against", "also", "among", "because",
        "before", "being", "below", "between", "both", "could", "does", "during",
        "each", "either", "every", "first", "found", "from", "have", "into",
        "itself", "more", "most", "much", "must", "only", "other", "over",
        "same", "should", "since", "some", "such", "than", "that", "their",
        "them", "there", "these", "they", "this", "those", "through", "under",
        "until", "upon", "used", "using", "very", "were", "what", "when",
        "where", "which", "while", "with", "within", "would", "your",
        "source", "document", "summary", "information", "related", "important",
        "however", "therefore", "including", "different", "significant",
    }

    def terms(value):
        words = set()
        for word in re.findall(r"[A-Za-z][A-Za-z-]{3,}", value.casefold()):
            word = word.replace("-", "")
            if word.endswith("ies") and len(word) > 6:
                word = word[:-3] + "y"
            elif word.endswith("s") and not word.endswith("ss") and len(word) > 5:
                word = word[:-1]
            if word not in stop and len(word) >= 4:
                words.add(word)
        return words

    evidence = []
    for item in document.get("texts") or []:
        if not isinstance(item, dict) or item.get("label") in {
            "page_header", "page_footer", "caption"
        }:
            continue
        text = str(item.get("text") or "")
        if len(text.strip()) < 30:
            continue
        keys = terms(text)
        if len(keys) < 5:
            continue
        pages = set()
        for prov in item.get("prov") or []:
            if isinstance(prov, dict):
                page = source_page_map.get(prov.get("page_no"))
                if page in allowed:
                    pages.add(page)
        if len(pages) != 1:
            continue  # ambiguous or unverified provenance
        evidence.append((next(iter(pages)), keys))
    if not evidence:
        return body, 0

    marker_re = re.compile(r"<!--\s*memex-source-pages:\s*[0-9,\s-]+\s*-->", re.I)

    # Aggregate ORIGINAL Docling text by verified printed page, so a paraphrase
    # can share relevant terminology across several adjacent text elements.
    page_terms = {}
    page_passages = {}
    for page, keys in evidence:
        page_terms.setdefault(page, set()).update(keys)
        page_passages.setdefault(page, []).append(keys)

    def strong_page_for_sentence(sentence):
        claim = terms(sentence)
        if len(claim) < 3:
            return None
        pages = sorted(page_terms)
        if len(pages) == 1:
            # This is page *attribution*, NOT independent factual verification.
            # A content overlap guards against irrelevant unsupported text.
            page = pages[0]
            return page if len(claim & page_terms[page]) >= 2 else None

        scores = {}
        for page in pages:
            shared_page = len(claim & page_terms[page])
            if shared_page < 3:
                continue
            # Use the strongest single provenance-bearing passage and the
            # accumulated page context. Do not use fuzzy matching by proximity.
            shared_passage = max(len(claim & keys) for keys in page_passages[page])
            if shared_passage < 2:
                continue
            fraction = shared_page / len(claim)
            if fraction < 0.34:
                continue
            scores[page] = fraction + 0.08 * (shared_passage / len(claim))
        if not scores:
            return None
        best = sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))
        # Do not manufacture precision where two pages support the same terms.
        if len(best) > 1 and best[0][1] - best[1][1] < 0.12:
            return None
        return best[0][0]

    def cite_one(block):
        if marker_re.search(block) or "<!--" in block or "-->" in block:
            return block, False
        # Markdown structural blocks and unsupported multiline lists are left alone.
        if re.search(r"(?m)^\s*(?:#{1,6}\s|>|```|~~~|\|)", block):
            return block, False
        lines = [line for line in block.splitlines() if line.strip()]
        if not lines or len(lines) > 5:
            return block, False
        if len(lines) > 1 and any(re.match(r"^\s*(?:[-*+]\s|\d+[.)]\s)", l)
                                  for l in lines):
            return block, False
        prose = re.sub(r"^\s*(?:[-*+]\s|\d+[.)]\s)", "", block.strip())
        sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z“])", prose)
                     if s.strip()]
        if not sentences or len(sentences) > 4:
            return block, False
        # Require all factual sentences to be supported; a single good match
        # does not justify citing an entire paragraph with an unrelated claim.
        pages = [strong_page_for_sentence(s) for s in sentences]
        if any(page is None for page in pages) or len(set(pages)) > 2:
            return block, False
        suffix = " <!-- memex-source-pages: " + ", ".join(
            map(str, sorted(set(pages)))) + " -->"
        return block.rstrip() + suffix + block[len(block.rstrip()):], True

    # Independently cite individual Markdown bullets even when successive
    # bullets have no blank line; preserve all heading, layout and prose text.
    parts = re.split(r"(\n\s*\n)", body)
    inserted = 0
    for index in range(0, len(parts), 2):
        block = parts[index]
        if not block.strip():
            continue
        bullet_lines = re.findall(r"(?m)^\s*(?:[-*+]\s+|\d+[.)]\s+)", block)
        if len(bullet_lines) >= 2:
            chunks = re.split(r"(\n(?=\s*(?:[-*+]\s+|\d+[.)]\s+)))", block)
            for subindex in range(0, len(chunks), 2):
                chunks[subindex], changed = cite_one(chunks[subindex])
                inserted += int(changed)
            parts[index] = "".join(chunks)
        else:
            parts[index], changed = cite_one(block)
            inserted += int(changed)
    return "".join(parts), inserted


def extract_verified_docling_source_excerpts(source_text, source_page_map, allowed_source_pages):
    """Build a small, explicitly extractive fallback, never fabricated prose.

    Only text elements with a Docling provenance page mapped to a verified
    printed source page are eligible. If no such evidence exists, return empty
    and keep the strict validator/LLM repair path.
    """
    if not source_text or not source_page_map or not allowed_source_pages:
        return "", 0
    start = source_text.find("{")
    if start < 0:
        return "", 0
    try:
        doc, _ = json.JSONDecoder().raw_decode(source_text[start:])
    except (ValueError, TypeError):
        return "", 0
    if not isinstance(doc, dict) or doc.get("schema_name") != "DoclingDocument":
        return "", 0

    allowed = set(allowed_source_pages)
    per_page = {}
    excerpts = []
    seen = set()
    for item in doc.get("texts") or []:
        if not isinstance(item, dict) or item.get("label") in {
            "page_header", "page_footer", "caption"
        }:
            continue
        phrase = " ".join(str(item.get("text") or "").split())
        if len(phrase) < 25 or phrase in seen:
            continue
        printed_page = None
        for prov in item.get("prov") or []:
            if not isinstance(prov, dict):
                continue
            mapped = source_page_map.get(prov.get("page_no"))
            if mapped in allowed:
                printed_page = mapped
                break
        if printed_page is None or per_page.get(printed_page, 0) >= 3:
            continue
        seen.add(phrase)
        # Preserve the source's words. Mark an excerpt, rather than silently
        # turning a truncated fragment into a complete quotation.
        if len(phrase) > 450:
            phrase = phrase[:450].rsplit(" ", 1)[0].rstrip() + "…"
        phrase = phrase.replace("<!--", "&lt;!--").replace("-->", "--&gt;")
        excerpts.append(
            f"- “{phrase}” <!-- memex-source-pages: {printed_page} -->"
        )
        per_page[printed_page] = per_page.get(printed_page, 0) + 1
        if len(excerpts) >= 9:
            break

    if not excerpts:
        return "", 0
    return "## Extracted source passages (automatic fallback)\n\n" + "\n".join(excerpts), len(excerpts)



def derive_wiki_source_anchor(body):
    current_anchor = ""
    first_anchor = ""
    for line in body.splitlines():
        heading = re.match(r"^#{2,6}\s+(.+?)\s*#*\s*$", line)
        if heading:
            current_anchor = wiki_heading_anchor(heading.group(1))
            if current_anchor and not first_anchor:
                first_anchor = current_anchor
            continue
        if current_anchor and re.search(
            r"<!--\s*memex-source-pages:\s*[0-9,\s-]+\s*-->",
            line,
            flags=re.I,
        ):
            return current_anchor
    return first_anchor


def docling_printed_page_map(content):
    start = content.find("{")
    if start < 0:
        return {}
    try:
        doc = json.loads(content[start:])
    except json.JSONDecodeError:
        return {}
    if not isinstance(doc, dict) or doc.get("schema_name") != "DoclingDocument":
        return {}

    def normalize_header_page_token(value):
        # OCR substitutions are accepted only inside a recognised running
        # page-header number slot, never from arbitrary source text.
        token = value.strip().translate(
            str.maketrans(
                {
                    "O": "0",
                    "o": "0",
                    "$": "5",
                    ";": "7",
                }
            )
        )
        if not re.fullmatch(r"\d{1,4}", token):
            return None
        page = int(token)
        return page if 0 < page <= 10000 else None

    def page_header_number(value):
        compact = re.sub(r"\s+", " ", value.strip())

        match = re.fullmatch(
            r"([0-9Oo$;]{1,4}) RURAL LIFE IN HAMPSHIRE",
            compact,
            flags=re.I,
        )
        if match:
            return normalize_header_page_token(match.group(1))

        match = re.fullmatch(
            r"MANORIAL USAGES ([0-9Oo$;]{1,4})",
            compact,
            flags=re.I,
        )
        if match:
            return normalize_header_page_token(match.group(1))

        return None

    # Large PDF imports are split into page-range documents.  Their Docling
    # page_no values restart at 1, while the split filename begins with the
    # physical source-page number, e.g. 56_Scenes... .  Do not treat every
    # numeric filename prefix as a split marker: confirm it against a numeric
    # header/footer on local page 1 first.  This avoids misreading source names
    # such as 7_A... or 8_A... as page offsets.
    origin = doc.get("origin") if isinstance(doc.get("origin"), dict) else {}
    filename = str(origin.get("filename") or doc.get("name") or "").strip()
    split_match = re.match(r"^(\d{1,5})_", filename)
    if split_match:
        split_start = int(split_match.group(1))
        first_page_numbers = set()

        for item in doc.get("texts", []):
            if not isinstance(item, dict):
                continue
            if item.get("label") not in {"page_header", "page_footer"}:
                continue

            is_first_page = any(
                isinstance(prov, dict) and prov.get("page_no") == 1
                for prov in item.get("prov") or []
            )
            if not is_first_page:
                continue

            label_text = str(item.get("text") or item.get("orig") or "")
            for token in re.findall(r"(?<!\d)(\d{1,5})(?!\d)", label_text):
                value = int(token)
                if 0 < value <= 100000:
                    first_page_numbers.add(value)

        if split_start in first_page_numbers:
            local_pages = set()
            raw_pages = doc.get("pages")
            if isinstance(raw_pages, dict):
                for key, page in raw_pages.items():
                    local = page.get("page_no") if isinstance(page, dict) else None
                    if not isinstance(local, int):
                        try:
                            local = int(key)
                        except (TypeError, ValueError):
                            local = None
                    if isinstance(local, int) and local > 0:
                        local_pages.add(local)

            if not local_pages:
                for item in doc.get("texts", []):
                    if not isinstance(item, dict):
                        continue
                    for prov in item.get("prov") or []:
                        if not isinstance(prov, dict):
                            continue
                        local = prov.get("page_no")
                        if isinstance(local, int) and local > 0:
                            local_pages.add(local)

            if local_pages:
                return {
                    local: split_start + local - 1
                    for local in sorted(local_pages)
                }

    candidates = {}
    for item in doc.get("texts", []):
        if not isinstance(item, dict):
            continue

        label = item.get("label")
        text = str(item.get("text") or item.get("orig") or "").strip()
        printed = None

        if label == "page_footer" and re.fullmatch(r"\d{1,4}", text):
            printed = int(text)
            # Historical title/copyright pages frequently have a year (e.g.
            # 1901) in their footer. A bare year is not verified pagination.
            if 1800 <= printed <= 2100:
                continue
        elif label == "page_header":
            printed = page_header_number(text)

        if printed is None:
            continue

        for prov in item.get("prov") or []:
            if not isinstance(prov, dict):
                continue
            local = prov.get("page_no")
            if isinstance(local, int) and local > 0:
                candidates.setdefault(local, set()).add(printed)

    return {
        local: next(iter(values))
        for local, values in sorted(candidates.items())
        if len(values) == 1
    }


def load_wiki_context(queued_title):
    catalogue = wiki_json_request(WIKI_MAINTAIN_URL)
    raw_pages = catalogue.get("pages", [])
    if not isinstance(raw_pages, list):
        raise ValueError("Memex wiki catalogue pages must be an array")

    registry = {}
    catalogue_lines = []
    for page in raw_pages:
        if not isinstance(page, dict):
            continue
        page_type = str(page.get("pageType", "")).strip()
        title = str(page.get("title", "")).strip()
        alias = str(page.get("alias", "")).strip()
        description = " ".join(str(page.get("description", "")).split())
        if not page_type or not title or not alias:
            continue
        key = (page_type.casefold(), title.casefold())
        registry[key] = {
            "alias": alias,
            "pageType": page_type,
            "title": title,
            "description": description,
            "sourceAliases": [],
            "fullContext": False,
        }
        catalogue_lines.append(
            f"- [{page_type}] {title} | alias={alias} | {description}"
        )

    priority_key = ("source-summary", queued_title.casefold())
    if priority_key in registry:
        priority_page = registry.pop(priority_key)
        registry = {priority_key: priority_page, **registry}

    bounded_catalogue_lines = []
    catalogue_chars = 0
    for line in catalogue_lines:
        line_chars = len(line) + 1
        if catalogue_chars + line_chars > 4000:
            break
        bounded_catalogue_lines.append(line)
        catalogue_chars += line_chars

    context_parts = [
        "CURRENT DERIVED WIKI CATALOGUE:",
        *(bounded_catalogue_lines or ["(empty)"]),
        "",
        "FULL CURRENT DERIVED WIKI PAGES SUPPLIED FOR SAFE REVISION:",
    ]
    used_chars = sum(len(part) + 1 for part in context_parts)
    included = 0

    for page in list(registry.values())[:WIKI_CONTEXT_MAX_PAGES]:
        query = urllib.parse.urlencode({"alias": page["alias"]})
        detail = wiki_json_request(f"{WIKI_MAINTAIN_URL}?{query}")
        markdown = detail.get("markdown")
        if not isinstance(markdown, str):
            raise ValueError(
                f"Memex wiki page {page['alias']} returned no markdown"
            )
        block = (
            f"\n=== {page['pageType']} | {page['title']} "
            f"| alias={page['alias']} ===\n{markdown.strip()}\n"
        )
        if used_chars + len(block) > WIKI_CONTEXT_MAX_CHARS:
            continue
        context_parts.append(block)
        used_chars += len(block)
        included += 1
        page["sourceAliases"] = wiki_source_aliases(markdown)
        page["sourceAnchor"] = wiki_source_anchor(markdown)
        page["fullContext"] = True

    if included == 0:
        context_parts.append("(no full derived pages currently supplied)")

    return (
        "\n".join(context_parts).strip(),
        registry,
        included,
        len(registry),
    )


def validate_memex_summary_synthesis(body):
    """Mandatory format gate. This does not claim to verify factual accuracy."""
    if not isinstance(body, str) or len(body.strip()) < 220:
        raise ValueError("source-summary synthesis quality: meaningful prose required")
    if re.search(
        r"(?im)^\s*#{1,6}\s+.*(?:extracted\s+(?:source\s+)?passages?|"
        r"automatic\s+fallback|verbatim\s+(?:source\s+)?excerpts?)",
        body,
    ):
        raise ValueError("source-summary synthesis quality: extractive heading rejected")
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    content = [line for line in lines if not re.match(r"^#{1,6}\s", line)
               and not line.startswith("<!--")]
    quoted = sum(bool(re.match(r"^(?:[-*+]\s+|\d+[.)]\s+|>\s*)[\"“‘']", line))
                 for line in content)
    if len(content) >= 3 and quoted >= 2 and quoted * 2 >= len(content):
        raise ValueError("source-summary synthesis quality: mostly copied quotations")
    headings = re.findall(r"(?m)^\s*#{2,6}\s+\S.*$", body)
    if len(headings) < 2:
        raise ValueError("source-summary synthesis quality: two thematic sections required")
    # A collection of empty headings is not synthesis.
    prose = re.sub(r"(?m)^\s*#{1,6}\s+.*$", "", body)
    prose = re.sub(r"<!--[^>]*-->", "", prose)
    if len(prose.strip()) < 160:
        raise ValueError("source-summary synthesis quality: insufficient developed findings")


def memex_summary_source_evidence(source_text):
    """Extract bounded original Docling text for a *citation-free* synthesis."""
    if not isinstance(source_text, str):
        return "", 0
    start = source_text.find("{")
    if start < 0:
        return "", 0
    try:
        doc, _ = json.JSONDecoder().raw_decode(source_text[start:])
    except (TypeError, ValueError):
        return "", 0
    if not isinstance(doc, dict) or doc.get("schema_name") != "DoclingDocument":
        return "", 0
    passages = []
    seen = set()
    for item in doc.get("texts") or []:
        if not isinstance(item, dict) or item.get("label") in {
            "page_header", "page_footer", "caption"
        }:
            continue
        phrase = " ".join(str(item.get("text") or "").split())
        if len(phrase) < 25 or phrase in seen:
            continue
        seen.add(phrase)
        passages.append(phrase[:1100])
    if not passages:
        return "", 0
    # Cover beginning, middle and end rather than only the first source page.
    indexes = list(range(len(passages)))
    if len(indexes) > 42:
        indexes = sorted(set(round(i * (len(passages) - 1) / 41) for i in range(42)))
    selected = []
    total = 0
    # Per-item cap keeps evidence distributed across the entire document,
    # rather than exhausting the token budget on early long paragraphs.
    item_budget = max(250, min(1100, 22500 // len(indexes)))
    for i in indexes:
        phrase = passages[i]
        if len(phrase) > item_budget:
            phrase = phrase[:item_budget].rsplit(" ", 1)[0] + " [excerpt ends]"
        if total + len(phrase) > 23000:
            break
        selected.append(phrase)
        total += len(phrase)
    return "\n\n".join(selected), len(selected)


def synthesize_memex_summary_only(candidate, source_text):
    """Generate an original Markdown synthesis; citations handled separately."""
    if not isinstance(candidate, dict):
        return None, 0
    pages = candidate.get("wiki_pages")
    if not isinstance(pages, list):
        return None, 0
    targets = [page for page in pages if isinstance(page, dict)
               and page.get("pageType") == "source-summary"]
    if len(targets) != 1:
        return None, 0
    evidence, count = memex_summary_source_evidence(source_text)
    if len(evidence) < 200:
        return None, count
    original = targets[0]
    prompt = (
        "Summarize the ORIGINAL DOCUMENT evidence below for a useful Memex wiki page.\n"
        "PRIORITY 1: accurate, ORIGINAL thematic synthesis.\n"
        "PRIORITY 2: source-page citations are OPTIONAL and handled in a separate "
        "step. Do NOT add page numbers, comment markers or quotations.\n"
        "Write 2-4 specific Markdown ## thematic headings and 5-9 clear, "
        "substantive sentences or concise analytical bullets in total (250-450 words). "
        "Explain findings, relationships and implications supported by the text. "
        "Never output 'Extracted source passages', a quote dump, a recap of "
        "unrelated literature, or unsupported dates/names/causal claims. "
        "Return ONLY Markdown, without JSON/YAML/fences.\n\n"
        "DOCUMENT: " + str(original.get("title") or "")[:160] +
        "\n\nORIGINAL DOCLING EVIDENCE:\n" + evidence
    )
    raw = llm_chat(
        prompt, num_ctx=NUM_CTX,
        system_prompt=("You write accurate, evidence-grounded historical and "
                       "technical syntheses. Prioritize explanation over copying. "
                       "Return Markdown prose, not JSON or citations."),
    )
    if not isinstance(raw, str):
        return None, count
    body = raw.strip()
    if body.startswith("```"):
        body = re.sub(r"^```[^\n]*\n|\n```\s*$", "", body).strip()
    if body.startswith("{"):
        try:
            parsed, _, _ = parse_json_object_with_escape_recovery(body)
            body = str(parsed.get("body") or parsed.get("summary") or "").strip()
        except (ValueError, json.JSONDecodeError):
            return None, count
    if len(body) > 12000:
        return None, count
    try:
        validate_memex_summary_synthesis(body)
    except ValueError as exc:
        print("MEMEX summary-first synthesis rejected:", str(exc), flush=True)
        return None, count
    new_pages = [dict(page, body=body) if page is original else page for page in pages]
    return dict(candidate, wiki_pages=new_pages), count


def normalize_wiki_mutations(
    result,
    registry,
    queued_alias,
    allowed_source_pages=None,
    source_page_map=None,
    source_text=None,
    allow_extract_fallback=False,
):
    raw_pages = result.get("wiki_pages")
    if not isinstance(raw_pages, list):
        raise ValueError('LLM response must contain top-level "wiki_pages" array')
    if len(raw_pages) > 12:
        raise ValueError("LLM response may mutate at most 12 derived wiki pages")

    pages = []
    seen = set()
    for raw in raw_pages:
        if not isinstance(raw, dict):
            raise ValueError("Every wiki_pages item must be an object")

        page_type = str(raw.get("pageType", "")).strip()
        title = " ".join(str(raw.get("title", "")).split())
        description = " ".join(str(raw.get("description", "")).split())
        raw_body = raw.get("body")
        body = raw_body.strip() if isinstance(raw_body, str) else ""
        tags = raw.get("tags", [])
        if page_type == "source-summary" and body:
            # This advisory belongs to the prior generated revision; recalc
            # it from the new body instead of stacking repeated notices.
            body = re.sub(
                r"(?im)^\s*>\s*\*\*Citation review:\*\* Incomplete; "
                r"verify findings against the original source\.\s*$", "", body,
            )
            body = re.sub(
                r"(?im)^\s*<!-- memex-citation-status: incomplete -->\s*$",
                "", body,
            ).strip()

        if page_type not in WIKI_PAGE_TYPES:
            raise ValueError(f"Unsupported derived wiki pageType: {page_type}")
        if not title or len(title) > 160:
            raise ValueError("Every derived wiki page needs a title <= 160 chars")
        if not description or len(description) > 500:
            raise ValueError(
                "Every derived wiki page needs a description <= 500 chars"
            )
        if not body and page_type == "source-summary" and allow_extract_fallback:
            body, excerpt_count = extract_verified_docling_source_excerpts(
                source_text, source_page_map, allowed_source_pages
            )
            if body:
                print(
                    "MEMEX recovered empty source-summary body using verified "
                    "Docling text excerpts:",
                    f"excerpts={excerpt_count}",
                    flush=True,
                )
        if not body and page_type != "source-summary":
            # Optional pages are speculative proposals. Ignore an empty one
            # rather than rejecting an otherwise valid required source-summary.
            print(
                "MEMEX ignored empty optional derived wiki page:",
                f"type={page_type} title={title!r}",
                flush=True,
            )
            continue
        if not body:
            raise ValueError(
                f"Required source-summary body is empty: {title!r}; "
                "a cited summary is required"
            )
        if len(body) > 60000:
            if page_type != "source-summary":
                # Do not publish a truncated update to an existing wiki page.
                print(
                    "MEMEX ignored oversized optional derived wiki page:",
                    f"type={page_type} title={title!r} chars={len(body)}",
                    flush=True,
                )
                continue
            raise ValueError(
                f"Required source-summary body exceeds 60000 chars: "
                f"title={title!r} chars={len(body)}"
            )
        if body.startswith("---\n") or body.startswith("---\r\n"):
            raise ValueError("Derived wiki page body must not contain YAML frontmatter")
        if not isinstance(tags, list):
            raise ValueError("Derived wiki page tags must be an array")

        key = (page_type.casefold(), title.casefold())
        if key in seen:
            raise ValueError(f"Duplicate derived wiki mutation: {page_type} {title}")
        seen.add(key)

        existing = registry.get(key)
        if page_type == "source-summary":
            source_matches = [
                candidate
                for candidate in registry.values()
                if candidate.get("pageType") == "source-summary"
                and queued_alias in candidate.get("sourceAliases", [])
            ]
            if len(source_matches) > 1:
                raise ValueError(
                    f"Multiple source-summary pages already reference {queued_alias}"
                )
            if source_matches:
                existing = source_matches[0]

        if existing and not existing.get("fullContext"):
            raise ValueError(
                f"Refusing unsafe rewrite of {existing['alias']}: "
                "full current page content was not supplied to the LLM"
            )

        source_aliases = []
        if existing:
            source_aliases.extend(existing.get("sourceAliases", []))
        if queued_alias not in source_aliases:
            source_aliases.append(queued_alias)

        if page_type == "source-summary" and not allow_extract_fallback:
            validate_memex_summary_synthesis(body)

        if page_type == "source-summary" and not allowed_source_pages:
            # Without any verified printed-page map, the model's numeric
            # markers are unverified. Omit them rather than invent citations or
            # exhaust three repair calls on the same impossible requirement.
            body, removed_markers = re.subn(
                r"<!--\s*memex-source-pages:\s*[0-9,\s-]+\s*-->",
                "",
                body,
                flags=re.I,
            )
            if removed_markers:
                print(
                    "MEMEX omitted unverified source-summary page markers:",
                    f"markers={removed_markers} (no verified source-page map)",
                    flush=True,
                )

        if page_type == "source-summary" and source_page_map:
            body, remapped_markers = remap_wiki_source_page_markers(
                body,
                source_page_map,
            )
            if remapped_markers:
                print(
                    "MEMEX remapped extraction-local source-summary page markers:",
                    f"markers={remapped_markers}",
                    flush=True,
                )

        if page_type == "source-summary" and allowed_source_pages:
            body, changed_markers, removed_pages = (
                filter_unverified_wiki_source_page_markers(
                    body, allowed_source_pages
                )
            )
            if changed_markers:
                print(
                    "MEMEX filtered unverified source-summary page citations:",
                    f"markers_changed={changed_markers}",
                    f"unverified={', '.join(map(str, removed_pages)) or '(none)'}",
                    flush=True,
                )

        if (
            page_type == "source-summary"
            and allowed_source_pages
            and allow_extract_fallback
        ):
            # Filtering unsupported numbers removes false evidence, but can
            # leave factual claims with no usable inline citation. Never
            # attach an allowed page to those unverified model claims.
            # Instead, use the previously validated verbatim Docling fallback
            # when its text elements have verified page provenance.
            cited_pages = wiki_body_source_pages(body)
            unmarked = (
                wiki_body_unmarked_factual_blocks(body) if cited_pages else []
            )
            if not cited_pages or unmarked:
                extracted, excerpt_count = extract_verified_docling_source_excerpts(
                    source_text, source_page_map, allowed_source_pages
                )
                if extracted:
                    reason = (
                        "no-verified-markers" if not cited_pages
                        else "uncited-factual-blocks"
                    )
                    body = extracted
                    print(
                        "MEMEX replaced unsourced source-summary with "
                        "verified Docling excerpts:",
                        f"reason={reason}",
                        f"excerpts={excerpt_count}",
                        flush=True,
                    )
                elif cited_pages and unmarked:
                    # Some Docling inputs are table-only and offer no eligible
                    # extractive text. Retain only already-cited model blocks;
                    # discard unsupported factual paragraphs and list items.
                    # Do not use this escape hatch if the resulting summary
                    # would lose all citations or fail strict coverage checks.
                    candidate, removed = remove_uncited_wiki_source_summary_blocks(body)
                    if (
                        removed
                        and wiki_body_source_pages(candidate)
                        and not wiki_body_unmarked_factual_blocks(candidate)
                    ):
                        body = candidate
                        print(
                            "MEMEX removed uncited source-summary factual blocks "
                            "without inventing page citations:",
                            f"blocks_removed={removed}",
                            f"verified_pages={','.join(map(str, wiki_body_source_pages(body)))}",
                            flush=True,
                        )

        page = {
            "pageType": page_type,
            "title": title,
            "description": description,
            "tags": [str(tag) for tag in tags if isinstance(tag, str)],
            "sourceAliases": source_aliases,
            "body": body,
        }

        if page_type == "source-summary":
            # Provenance for the exact model used by this queue processing run.
            page["benchmarkGoldGeneratorModel"] = MODEL
            # Evidence-supported enrichment is strictly secondary to synthesis.
            # It is deterministic, bounded and may add zero citations safely.
            body, enriched_count = enrich_synthesized_memex_citations(
                body, source_text, source_page_map, allowed_source_pages
            )
            if enriched_count:
                print(
                    "MEMEX source-summary citation enrichment:",
                    f"evidence_matched_blocks={enriched_count}", flush=True,
                )
            page["body"] = body
            source_pages = wiki_body_source_pages(body)
            allowed = set(allowed_source_pages or [])
            invalid_pages = sorted(set(source_pages) - allowed) if allowed else source_pages
            if invalid_pages:
                raise ValueError(
                    "source-summary contains unverified source page markers: "
                    + ", ".join(str(value) for value in invalid_pages)
                )
            # SUMMARY FIRST: verified citations are desirable but never the
            # reason to discard an otherwise valid original synthesis.
            # Unknown page numbers were removed above, not guessed/reassigned.
            unmarked_blocks = wiki_body_unmarked_factual_blocks(body)
            citation_incomplete = not source_pages or bool(unmarked_blocks)
            if citation_incomplete:
                print(
                    "MEMEX source-summary citation advisory: INCOMPLETE",
                    f"verified_markers={len(source_pages)}",
                    f"uncited_blocks={len(unmarked_blocks)}",
                    flush=True,
                )
                # Keep citation coverage visible in logs, not in the wiki.
                # Preserve the synthesized body and its verified inline markers.
            else:
                print(
                    "MEMEX source-summary citation advisory: COMPLETE",
                    f"verified_markers={len(source_pages)}", flush=True,
                )

            heading_anchors = wiki_body_heading_anchors(body)
            existing_anchor = str((existing or {}).get("sourceAnchor", "")).strip()
            if not heading_anchors:
                # Repair missing Markdown section headings without a new LLM
                # call. Keep any verified inline page citations and all facts.
                heading_label = (
                    existing_anchor
                    if existing_anchor
                    and wiki_heading_anchor(existing_anchor) == existing_anchor
                    else "Source Summary"
                )
                section = f"## {heading_label}"
                if body.startswith("# "):
                    first_line, separator, remainder = body.partition("\n")
                    body = (
                        f"{first_line}\n\n{section}\n\n{remainder}"
                        if separator else f"{first_line}\n\n{section}"
                    )
                else:
                    body = f"{section}\n\n{body}"
                if len(body) > 60000:
                    raise ValueError(
                        "source-summary body exceeds 60000 chars after "
                        "inserting its missing section heading"
                    )
                page["body"] = body
                heading_anchors = wiki_body_heading_anchors(body)
                print(
                    "MEMEX inserted missing source-summary section heading:",
                    f"anchor={heading_anchors[0]}",
                    flush=True,
                )
            metadata_pages, source_anchor = memex_source_summary_target_metadata(
                body, allowed_source_pages, source_pages
            )
            if not source_anchor:
                raise ValueError(
                    "source-summary must contain at least one Markdown section "
                    "heading so memex_source_anchor can be derived"
                )
            if metadata_pages:
                page["sourcePages"] = metadata_pages
            page["sourceAnchor"] = source_anchor
        if existing:
            page["alias"] = existing["alias"]
        pages.append(page)

    source_summary_count = sum(
        1 for page in pages if page["pageType"] == "source-summary"
    )
    if source_summary_count != 1:
        raise ValueError(
            "LLM response must include exactly one source-summary wiki page "
            "for the queued source"
        )

    return pages


def commit_wiki_mutations(pages, provenance):
    response = wiki_json_request(
        WIKI_MAINTAIN_URL,
        method="POST",
        payload={
            "dryRun": False,
            "provenance": provenance,
            "pages": pages,
        },
    )
    if response.get("committed") is not True:
        raise RuntimeError(
            f"Memex wiki mutation was not committed: {response}"
        )
    committed = response.get("pages")
    if not isinstance(committed, list) or len(committed) != len(pages):
        raise RuntimeError(
            "Memex wiki mutation count mismatch: "
            f"requested={len(pages)} committed="
            f"{len(committed) if isinstance(committed, list) else 'invalid'}"
        )
    return response


def sync_readonly_mirror(alias, path):
    try:
        api_put(alias, path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"WARNING: failed to sync {alias} revision mirror: {exc}")


def title_from_markdown(text, alias):
    m = re.search(r'^title:\s*["\']?(.*?)["\']?\s*$', text, re.M)
    if m:
        return m.group(1).strip()
    m = re.search(r'^#\s+(.+)$', text, re.M)
    return m.group(1).strip() if m else alias


def sanitize_llm_source(text):
    markdown_image_re = re.compile(r"!\[[^\]\n]*\]\([^)\n]*\)")
    data_image_re = re.compile(
        r"data:image/[^;,\s]+;base64,[A-Za-z0-9+/=]+"
    )
    is_docling = re.search(
        r'"schema_name"\s*:\s*"DoclingDocument"',
        text,
    )

    if not is_docling:
        cleaned, markdown_removed = markdown_image_re.subn(
            "[MARKDOWN_IMAGE_REMOVED]",
            text,
        )
        if markdown_removed:
            print(
                "MEMEX source sanitizer:",
                "docling=no",
                f"markdown_images_removed={markdown_removed}",
                f"chars={len(text)}->{len(cleaned)}",
            )
        return cleaned

    start = text.find("{")
    if start < 0:
        return text

    try:
        doc = json.loads(text[start:])
    except json.JSONDecodeError:
        return text

    DROP = object()
    stats = {
        "pictures_keys": 0,
        "picture_refs": 0,
        "data_images": 0,
        "markdown_images": 0,
    }

    def clean(value):
        if isinstance(value, dict):
            for ref_key in ("$ref", "self_ref"):
                ref = value.get(ref_key)
                if isinstance(ref, str) and ref.startswith("#/pictures/"):
                    stats["picture_refs"] += 1
                    return DROP

            cleaned = {}
            for key, item in value.items():
                if key == "pictures":
                    stats["pictures_keys"] += 1
                    continue
                result = clean(item)
                if result is not DROP:
                    cleaned[key] = result
            return cleaned

        if isinstance(value, list):
            cleaned = []
            for item in value:
                result = clean(item)
                if result is not DROP:
                    cleaned.append(result)
            return cleaned

        if isinstance(value, str):
            if value.startswith("#/pictures/"):
                stats["picture_refs"] += 1
                return DROP

            value, n_data = data_image_re.subn(
                "[EMBEDDED_IMAGE_REMOVED]",
                value,
            )
            stats["data_images"] += n_data

            value, n_markdown = markdown_image_re.subn(
                "[MARKDOWN_IMAGE_REMOVED]",
                value,
            )
            stats["markdown_images"] += n_markdown
            return value

        return value

    cleaned_doc = clean(doc)
    cleaned = text[:start] + json.dumps(
        cleaned_doc,
        ensure_ascii=False,
        separators=(",", ":"),
    )

    print(
        "MEMEX source sanitizer:",
        "docling=yes",
        f"pictures_keys_removed={stats['pictures_keys']}",
        f"picture_refs_removed={stats['picture_refs']}",
        f"data_images_removed={stats['data_images']}",
        f"markdown_images_removed={stats['markdown_images']}",
        f"chars={len(text)}->{len(cleaned)}",
    )

    return cleaned


# REVISION_AWARE_MEMEX
# Revision UUID is the cache key.


def verified_docling_evidence_for_summary(source_text, source_page_map, allowed_pages):
    """Return bounded, page-labeled ORIGINAL text for a citation-safe retry.

    A document ID is not a source page. Never assign a page to model-written
    claims: only the Docling provenance map supplies permitted evidence here.
    """
    if not source_text or not source_page_map or not allowed_pages:
        return "", 0
    start = source_text.find("{")
    if start < 0:
        return "", 0
    try:
        doc, _ = json.JSONDecoder().raw_decode(source_text[start:])
    except (TypeError, ValueError):
        return "", 0
    if not isinstance(doc, dict) or doc.get("schema_name") != "DoclingDocument":
        return "", 0

    allowed = set(allowed_pages)
    snippets = []
    seen = set()
    per_page = {}
    chars = 0
    for item in doc.get("texts") or []:
        if not isinstance(item, dict) or item.get("label") in {
            "page_header", "page_footer", "caption"
        }:
            continue
        phrase = " ".join(str(item.get("text") or "").split())
        if len(phrase) < 25 or phrase in seen:
            continue
        page = None
        for provenance in item.get("prov") or []:
            if isinstance(provenance, dict):
                mapped = source_page_map.get(provenance.get("page_no"))
                if mapped in allowed:
                    page = mapped
                    break
        if page is None or per_page.get(page, 0) >= 6:
            continue
        # Bounded context for predictable llama.cpp latency. Clearly label
        # excerpts as partial if a long source paragraph is truncated.
        if len(phrase) > 800:
            phrase = phrase[:800].rsplit(" ", 1)[0].rstrip() + " [excerpt ends]"
        row = f"[SOURCE PAGE {page}] {phrase}"
        if chars + len(row) > 14500:
            break
        snippets.append(row)
        seen.add(phrase)
        per_page[page] = per_page.get(page, 0) + 1
        chars += len(row)
        if len(snippets) >= 24:
            break
    return "\n\n".join(snippets), len(snippets)


def synthesize_cited_source_summary(candidate, source_text, source_page_map,
                                    allowed_source_pages):
    """One focused LLM synthesis using *verified* source passages only.

    Keep trails, document summaries, associations and other wiki proposals
    untouched. Callers MUST run the existing strict wiki validator on result.
    """
    if not isinstance(candidate, dict):
        return None, 0
    pages = candidate.get("wiki_pages")
    if not isinstance(pages, list):
        return None, 0
    matches = [p for p in pages if isinstance(p, dict)
               and p.get("pageType") == "source-summary"]
    if len(matches) != 1:
        return None, 0
    evidence, count = verified_docling_evidence_for_summary(
        source_text, source_page_map, allowed_source_pages
    )
    if not evidence:
        return None, 0

    page = matches[0]
    allowed = ", ".join(str(i) for i in sorted(set(allowed_source_pages)))
    prompt = f"""Write a concise, USEFUL synthesized source summary from the
verified original Docling evidence below. This is NOT a request for quotations
or an extracted-passages list.

Return one JSON object only: {{"body": "## Main findings\\n\\n- ..."}}
Its body must have 2-4 informative Markdown section headings and 3-8 concise
factual bullets or paragraphs. Every factual paragraph/list item MUST end
with its OWN citation <!-- memex-source-pages: N --> on that same item.
N must be the actual SOURCE PAGE on the supporting evidence passage.
If evidence spans pages, cite all supporting pages separated by commas.
Never use the DOCUMENT ID, extraction-local page numbers, or any other number
as a source-page citation. Allowed source pages are EXACTLY: {allowed}.
Do NOT add any fact, interpretation, name, date, or causal claim that cannot
be supported by one or more passages below. Prefer fewer fully supported
findings over guesses. Synthesize the key evidence; do not copy the excerpts
or return the title 'Extracted source passages (automatic fallback)'.
Do not emit YAML, other fields, markdown fences or commentary.

SOURCE TITLE: {str(page.get('title') or '')[:160]}

VERIFIED EVIDENCE:
{evidence}
"""
    response = llm_chat(
        prompt,
        num_ctx=NUM_CTX,
        system_prompt=(
            "You synthesize grounded historical/technical source summaries. "
            "Return only valid JSON with a cited Markdown body. Never "
            "invent page citations or unsupported details."
        ),
    )
    try:
        parsed, _, _ = parse_json_object_with_escape_recovery(response)
    except (ValueError, json.JSONDecodeError) as exc:
        print("MEMEX evidence synthesis invalid JSON:", str(exc), flush=True)
        return None, count
    body = parsed.get("body") if isinstance(parsed, dict) else None
    if not isinstance(body, str) or not body.strip() or len(body) > 12000:
        print("MEMEX evidence synthesis returned no usable body", flush=True)
        return None, count

    revised_pages = [
        dict(p, body=body.strip()) if p is page else p
        for p in pages
    ]
    return dict(candidate, wiki_pages=revised_pages), count


def normalize_wiki_mutations_with_repair(result, original_prompt, *args, **kwargs):
    candidate = result
    repair_dir = Path("/data/builds/memex-peg-recovery/wiki-contract-errors")
    repair_dir.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(0, 4):
        try:
            # Previous Oct 14 patches silently discarded a summary *before*
            # any LLM citation repair. Rejected summaries must be repaired,
            # not immediately replaced with raw Docling passages.
            return normalize_wiki_mutations(
                candidate, *args, allow_extract_fallback=False, **kwargs
            )
        except ValueError as exc:
            last_error = exc

            # A real synthesis is mandatory; do not try to fix its *citations*
            # by pasting verified excerpts. The read-only Oct 16 test showed
            # Gemma4 can produce thematic prose without forced page markers.
            quality_problem = (
                "source-summary synthesis quality:" in str(exc)
                or "Required source-summary body is empty" in str(exc)
            )
            if quality_problem:
                for summary_attempt in (1, 2):
                    replacement, evidence_count = synthesize_memex_summary_only(
                        candidate, kwargs.get("source_text")
                    )
                    print(
                        "MEMEX summary-first retry:",
                        f"attempt={summary_attempt}/2",
                        f"source_passages={evidence_count}", flush=True,
                    )
                    if replacement is None:
                        continue
                    try:
                        validated = normalize_wiki_mutations(
                            replacement, *args, allow_extract_fallback=False, **kwargs
                        )
                    except ValueError as summary_exc:
                        print(
                            "MEMEX summary-first validation rejected:",
                            str(summary_exc), flush=True,
                        )
                        continue
                    print(
                        "MEMEX accepted SYNTHESIZED source-summary; citations "
                        "are advisory", flush=True,
                    )
                    return validated
                raise RuntimeError(
                    "MEMEX summary-first synthesis failed after 2 attempts; "
                    "original wiki left unchanged: " + str(exc)
                ) from exc

            if attempt >= 3:
                raise RuntimeError(
                    "MEMEX wiki contract repair failed after 3 attempts: "
                    + str(exc)
                ) from exc

            n = attempt + 1

            bad_path = repair_dir / f"{queued_alias}-contract-{n}.json"
            bad_path.write_text(
                json.dumps(candidate, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            print(
                f"MEMEX wiki contract violation: {exc}",
                flush=True,
            )
            print(
                f"MEMEX wiki contract repair attempt {n}/3",
                flush=True,
            )

            repair_prompt = f"""Repair the Memex JSON response below.

The Python validator rejected it with this exact error:

{exc}

Return exactly one complete valid JSON object and nothing else.

Required top-level fields:
- summary: string
- documents: array
- reviewed_trail_count: integer
- trail_changes: array
- wiki_pages: array
- associations: array

Wiki requirements:
- wiki_pages must contain exactly ONE page whose pageType is "source-summary"
- that source-summary must represent the currently queued source
- its sourceAliases must include the queued raw source alias: {queued_alias}
- do not create a second source-summary for the same queued source
- preserve valid entity/topic/comparison/synthesis pages where justified
- valid pageType values are source-summary, entity, topic, comparison, synthesis
- raw HedgeDoc source aliases are evidence; memex-wiki-* aliases are derived pages, not sourceAliases
- do not invent evidence
- preserve valid trail_changes and associations from the previous response
- prioritize a meaningful original synthesis; citation completeness is
  advisory and you MUST NOT replace a summary with extracted source passages
- add memex-source-pages markers only when the source page is verified
- a parent line that only introduces marked child list items may end with ":"
  without its own marker
- never use one standalone/catch-all page marker for the whole source-summary
- use only source pages allowed by the ORIGINAL MEMEX TASK page map
- do not use markdown fences

CURRENT INVALID RESPONSE:
{json.dumps(candidate, ensure_ascii=False)}

ORIGINAL MEMEX TASK:
{original_prompt}
"""

            repaired = llm_chat(
                repair_prompt,
                num_ctx=NUM_CTX,
                system_prompt=(
                    "You are repairing structured Memex output rejected "
                    "by its deterministic validator. Return one JSON "
                    "object only and satisfy the validator exactly."
                ),
            )

            raw_path = repair_dir / f"{queued_alias}-contract-{n}.txt"
            raw_path.write_text(repaired, encoding="utf-8")

            try:
                candidate = parse_json_object(repaired)
            except (json.JSONDecodeError, ValueError) as parse_exc:
                print(
                    f"MEMEX wiki contract repair produced malformed JSON: "
                    f"{parse_exc}",
                    flush=True,
                )
                candidate = {
                    "summary": candidate.get("summary", ""),
                    "documents": candidate.get("documents", []),
                    "reviewed_trail_count": candidate.get(
                        "reviewed_trail_count", 0
                    ),
                    "trail_changes": candidate.get("trail_changes", []),
                    "wiki_pages": candidate.get("wiki_pages", []),
                    "associations": candidate.get("associations", []),
                }
                last_error = parse_exc
                continue

            print(
                f"MEMEX wiki contract repair parsed attempt={n}",
                flush=True,
            )

    raise RuntimeError(
        "MEMEX wiki contract repair exhausted: "
        + str(last_error)
    )


def parse_json_object(text):
    if not isinstance(text, str):
        raise ValueError("Ollama response content is not text")

    start = text.find("{")
    if start < 0:
        raise ValueError("Ollama response contained no JSON object")

    value, _ = json.JSONDecoder(strict=False).raw_decode(text[start:])
    if not isinstance(value, dict):
        raise ValueError("Ollama response JSON must be an object")
    return value


def escape_invalid_json_string_backslashes(text):
    r"""Escape only invalid JSON string backslashes, preserving valid escapes.

    Gemma can emit literal backslashes in source-summary text (e.g. \q or
    incomplete \u sequences). Doubling those backslashes preserves the
    original characters in the decoded string without inventing content.
    Do not touch backslashes outside strings or valid JSON escape sequences.
    """
    start = text.find("{")
    if start < 0:
        return text, 0
    prefix, source = text[:start], text[start:]
    result = []
    index = 0
    in_string = False
    corrections = 0
    allowed = '\"\\/bfnrt'
    hex_digits = "0123456789abcdefABCDEF"

    while index < len(source):
        char = source[index]
        if char == '"':
            in_string = not in_string
            result.append(char)
            index += 1
            continue
        if in_string and char == "\\" and index + 1 < len(source):
            following = source[index + 1]
            if following in allowed:
                result.append(source[index:index + 2])
                index += 2
                continue
            if following == "u" and (
                index + 6 <= len(source)
                and all(digit in hex_digits for digit in source[index + 2:index + 6])
            ):
                result.append(source[index:index + 6])
                index += 6
                continue
            # Preserve the raw backslash as data, never reinterpret it.
            result.append("\\\\" + following)
            corrections += 1
            index += 2
            continue
        result.append(char)
        index += 1

    return prefix + "".join(result), corrections


def parse_json_object_with_escape_recovery(text):
    """Try local invalid-escape recovery before expensive model JSON repairs.

    Run the existing decoder again; do not accept incomplete/invalid JSON or
    alter legitimate JSON escapes. Non-escape JSON errors still follow the
    existing LLM repair path.
    """
    try:
        return parse_json_object(text), text, 0
    except json.JSONDecodeError as error:
        if error.msg not in ("Invalid \\escape", "Invalid \\uXXXX escape"):
            raise
        corrected, count = escape_invalid_json_string_backslashes(text)
        if count == 0:
            raise
        return parse_json_object(corrected), corrected, count


def append_association_recommendations(source_doc, proposals, queue_row):
    RECOMMENDATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)

    existing = []
    if RECOMMENDATIONS_FILE.exists():
        for raw in RECOMMENDATIONS_FILE.read_text(encoding="utf-8").splitlines():
            if not raw.strip():
                continue
            try:
                item = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                existing.append(item)

    def pair_key(source, target):
        return tuple(sorted((str(source).strip(), str(target).strip())))

    pending_keys = {
        (
            pair_key(item.get("source", ""), item.get("target", "")),
            str(item.get("sourceRevision", "")),
        )
        for item in existing
        if item.get("status") == "pending"
    }

    now = datetime.now(timezone.utc).isoformat()
    additions = []

    for proposal in proposals:
        target_alias = str(proposal.get("target", "")).strip()
        if not target_alias or target_alias == source_doc["alias"]:
            continue

        key = (
            pair_key(source_doc["alias"], target_alias),
            str(source_doc["revision"]),
        )
        if key in pending_keys:
            continue

        additions.append({
            "id": str(uuid.uuid4()),
            "source": source_doc["alias"],
            "sourceTitle": source_doc["title"],
            "target": target_alias,
            "targetTitle": str(proposal.get("targetTitle", target_alias)),
            "relation": "associated_with",
            "createdBy": "llm",
            "reason": proposal["reason"],
            "confidence": proposal["confidence"],
            "mainModel": MODEL,
            "recommendationSource": "main-model-candidate",
            "sourceRevision": source_doc["revision"],
            "snapshotRevision": queue_row.get("snapshotRevision"),
            "queueItemId": queue_row.get("id"),
            "recommendedAt": now,
            "status": "pending",
        })
        pending_keys.add(key)

    if additions:
        with RECOMMENDATIONS_FILE.open("a", encoding="utf-8") as fh:
            for item in additions:
                fh.write(json.dumps(item, separators=(",", ":")) + "\n")

    return {
        "added": len(additions),
        "pending": sum(
            1 for item in existing if item.get("status") == "pending"
        ) + len(additions),
    }


# Previously processed sources are represented by memex/index.md summaries.
INDEX_PATH = Path("memex/index.md")
LOG_PATH = Path("memex/log.md")

# KARPATHY_INDEX_LOG_CONTEXT
# index.md is content-oriented memory; log.md is chronological operational
# memory. Keep log context bounded so it does not crowd source evidence.
from wiki_log import ensure_index_labels, recent_log_context

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
)

current_index = (
    INDEX_PATH.read_text(encoding="utf-8")
    if INDEX_PATH.exists()
    else "# Memex Index\n\nNo indexed sources yet."
)

# Normal batch processing may freeze the large index-bearing system prefix so
# llama.cpp can reuse it across different source suffixes. Canonical mutation
# still uses current_index; only LLM navigation/context uses prompt_index.
batch_frozen_index_path = os.environ.get("MEMEX_BATCH_FROZEN_INDEX_PATH", "").strip()
prompt_index = current_index
if batch_frozen_index_path:
    frozen_path = Path(batch_frozen_index_path)
    if not frozen_path.is_file():
        raise RuntimeError(
            f"Frozen Memex batch index does not exist: {frozen_path}"
        )
    prompt_index = frozen_path.read_text(encoding="utf-8")
    print(
        "MEMEX frozen prompt prefix:",
        f"path={frozen_path}",
        f"frozen_chars={len(prompt_index)}",
        f"live_chars={len(current_index)}",
    )

rows = [
    json.loads(x)
    for x in QUEUE.read_text().splitlines()
    if x.strip()
]

# Latest queue state is authoritative. A source that was processed and later
# cancelled must not be fed back into the maintained index/graph.
latest_by_alias = {}
for row in rows:
    alias = row.get("alias")
    # Snapshot replays are benchmark/history rows, not lifecycle authority.
    if alias and row.get("queueReason") != "snapshot-process":
        latest_by_alias[alias] = row

cancelled_aliases = {
    alias
    for alias, row in latest_by_alias.items()
    if row.get("status") == "cancelled"
}

pending = next(
    (x for x in reversed(rows) if x.get("status") == "pending"),
    None
)

if not pending:
    raise SystemExit("No pending Memex queue item")

queued_alias = pending["alias"]

# Queue/run overrides take precedence over central model settings.
if pending.get("llmModel"):
    MODEL = MODEL_SETTINGS["defaultModel"]
if pending.get("numCtx"):
    NUM_CTX = int(pending["numCtx"])

# Canonical memex-network host is output, never a queued source.
if queued_alias == NODEBOOK:
    now = datetime.now(timezone.utc).isoformat()
    pending["status"] = "processed"
    pending["processedAt"] = now
    pending["ignoredReason"] = "nodebook-output"
    pending["nodeBook"] = NODEBOOK
    QUEUE.write_text("".join(json.dumps(x) + "\n" for x in rows))
    raise SystemExit("Ignoring generated nodeBook queue entry")


def processed_revision(alias):
    for row in reversed(rows):
        if row.get("alias") != alias:
            continue

        # Snapshot replay rows must never become lifecycle/revision authority.
        if row.get("queueReason") == "snapshot-process":
            continue

        if row.get("status") == "cancelled":
            return None

        if row.get("status") == "processed" and row.get("sourceRevision"):
            return row["sourceRevision"]

    return None


# Fetch only revision metadata first.
revisions = json.loads(api_get(f"{queued_alias}/revisions"))

if not revisions:
    raise RuntimeError(f"No revisions returned for {queued_alias}")

latest = max(revisions, key=lambda x: x["createdAt"])
latest_revision = latest["uuid"]
previous_revision = processed_revision(queued_alias)

# Exact same revision already processed: no content fetch, no Gemma.
if (
    previous_revision == latest_revision
    and pending.get("queueReason") not in {"orphan-repair", "snapshot-process"}
):
    now = datetime.now(timezone.utc).isoformat()

    for row in rows:
        if row.get("id") == pending["id"]:
            row["status"] = "processed"
            row["processedAt"] = now
            row["sourceRevision"] = latest_revision
            row["ignoredReason"] = "unchanged-revision"
            row["nodeBook"] = NODEBOOK

    QUEUE.write_text(
        "".join(json.dumps(x) + "\n" for x in rows)
    )

    if not LOG_PATH.exists():
        LOG_PATH.write_text("# Memex Log\n\n", encoding="utf-8")

    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(
            f"## [{now}] revision check | {queued_alias}\n\n"
            f"- revision: `{latest_revision}`\n"
            f"- unchanged: yes\n"
            f"- LLM called: no\n\n"
        )

    sync_readonly_mirror("memex-log", LOG_PATH)

    raise SystemExit(
        f"Unchanged HedgeDoc ignored: {queued_alias} "
        f"({latest_revision}); LLM not called"
    )


# Parse only the Sources section of the maintained index.
source_section = ""

if "## Sources" in current_index:
    source_section = current_index.split("## Sources", 1)[1]
    if "## Trails" in source_section:
        source_section = source_section.split("## Trails", 1)[0]

index_sources = []

for line in source_section.splitlines():
    line = line.strip()

    if not line.startswith("- [") or "](" not in line or ") — " not in line:
        continue

    try:
        title = line[3:line.index("](")]
        rest = line[line.index("](") + 2:]
        url, summary = rest.split(") — ", 1)

        if "/n/" not in url:
            continue

        alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]

        if (
            not alias
            or alias in {queued_alias, NODEBOOK}
            or alias in cancelled_aliases
        ):
            continue

        index_sources.append({
            "alias": alias,
            "title": title.strip(),
            "summary": summary.strip(),
        })
    except ValueError:
        continue


# Existing knowledge comes from compact index summaries.
docs = []
seen_aliases = set()

for item in index_sources:
    alias = item["alias"]

    if alias in seen_aliases:
        continue

    seen_aliases.add(alias)

    docs.append({
        "id": len(docs) + 1,
        "alias": alias,
        "title": item["title"],
        "revision": processed_revision(alias) or "",
        "content": (
            "INDEX SUMMARY ONLY — previously processed source.\n"
            + item["summary"]
        ),
        "summary": item["summary"],
        "cached": True,
    })


# Only the new/revised HedgeDoc gets a full content fetch.
content = api_get(f"{queued_alias}/content")
content = sanitize_llm_source(content)
source_page_map = docling_printed_page_map(content)
verified_source_pages = sorted(set(source_page_map.values()))

if source_page_map:
    print(
        "MEMEX verified source-page map:",
        ", ".join(
            f"docling={local}->source={source_page}"
            for local, source_page in source_page_map.items()
        ),
    )

queued_doc = {
    "id": len(docs) + 1,
    "alias": queued_alias,
    "title": title_from_markdown(content, queued_alias),
    "revision": latest_revision,
    "content": content,
    "summary": "",
    "cached": False,
}

docs.append(queued_doc)

page_map_text = (
    "\n".join(
        f"- prov.page_no {local} = source page {source_page}"
        for local, source_page in source_page_map.items()
    )
    if source_page_map
    else "(no verified source-page map available)"
)

queued_text = f"""DOCUMENT {queued_doc['id']} — NEW OR REVISED SOURCE
TITLE: {queued_doc['title']}
REVISION: {queued_doc['revision']}

VERIFIED SOURCE PAGE MAP:
{page_map_text}

SOURCE CONTENT:
{queued_doc['content']}"""

# The frozen system prefix already contains the reusable 12-source baseline
# summaries plus all maintained trails and stable DOCUMENT ids. Do not repeat
# every historical source summary in the per-source suffix.
prompt_docs = queued_text

trail_section = (
    current_index.split("## Trails", 1)[1]
    if "## Trails" in current_index
    else ""
)
existing_trail_count = len(
    re.findall(r"(?m)^###\s+\S", trail_section)
)


def trail_blocks_for_batch(index_text):
    """Return maintained trail Markdown blocks keyed by normalized trail name."""
    if "## Trails" not in index_text:
        return {}

    section = index_text.split("## Trails", 1)[1]
    blocks = {}
    current = []
    current_key = None

    def finish():
        nonlocal current, current_key
        if current_key is not None:
            blocks[current_key] = "\n".join(current).strip()
        current = []
        current_key = None

    for raw in section.splitlines():
        if raw.startswith("### "):
            finish()
            name = raw[4:].strip()
            current_key = re.sub(r"\s+", " ", name).casefold()
            current = [raw.rstrip()]
        elif current_key is not None:
            current.append(raw.rstrip())

    finish()
    return blocks


def cumulative_batch_trail_delta(base_index, live_index):
    """Describe only live trail mutations relative to the frozen batch base."""
    base = trail_blocks_for_batch(base_index)
    live = trail_blocks_for_batch(live_index)
    changes = []

    for key, block in live.items():
        if base.get(key) != block:
            changes.append("UPSERT CURRENT TRAIL STATE:\n" + block)

    for key, block in base.items():
        if key not in live:
            heading = block.splitlines()[0] if block else f"### {key}"
            changes.append("DELETE TRAIL:\n" + heading)

    return ("\n\n".join(changes) if changes else "(none)"), len(changes)


batch_delta_base_path = os.environ.get(
    "MEMEX_BATCH_DELTA_BASE_INDEX_PATH",
    "",
).strip()
delta_base_index = prompt_index
if batch_delta_base_path:
    delta_base_path = Path(batch_delta_base_path)
    if not delta_base_path.is_file():
        raise RuntimeError(
            f"Frozen Memex delta base does not exist: {delta_base_path}"
        )
    delta_base_index = delta_base_path.read_text(encoding="utf-8")

batch_trail_delta, batch_trail_delta_count = cumulative_batch_trail_delta(
    delta_base_index,
    current_index,
)
if batch_frozen_index_path:
    print(
        "MEMEX batch trail delta:",
        f"changes={batch_trail_delta_count}",
        f"chars={len(batch_trail_delta)}",
    )
trail_mode = (
    "BOOTSTRAP: the current Memex index has no maintained trails. "
    "Reconstruct strong trails across the supplied corpus."
    if existing_trail_count == 0
    else f"MAINTENANCE: preserve and update the {existing_trail_count} "
         "existing maintained trails."
)

wiki_context, wiki_registry, wiki_context_page_count, wiki_catalogue_count = (
    load_wiki_context(queued_doc["title"])
)
print(
    "MEMEX derived wiki context:",
    f"catalogue={wiki_catalogue_count}",
    f"full_pages={wiki_context_page_count}",
    f"chars={len(wiki_context)}",
)

if existing_trail_count == 0:
    bootstrap_docs = []
    for doc in docs:
        summary = doc.get("summary", "").strip()
        if not summary:
            summary = f"Source note: {doc['title']}."
        bootstrap_docs.append(
            f"DOCUMENT {doc['id']}\n"
            f"TITLE: {doc['title']}\n"
            f"SUMMARY: {summary}"
        )

    bootstrap_prompt = f"""
You are rebuilding an EMPTY Memex trail catalogue from compact source memory.

Identify strong, useful conceptual trails shared by TWO OR MORE supplied
documents. Do not force unrelated documents into a trail.

Return JSON only:
{{
  "summary": "short explanation of the reconstructed trail structure",
  "documents": [
    {{
      "id": {queued_doc['id']},
      "summary": "one concise factual line describing the new/revised source"
    }}
  ],
  "trails": [
    {{
      "name": "specific relationship name",
      "reason": "concrete relationship supported by the supplied titles/summaries",
      "confidence": 0.0,
      "members": [1, 2]
    }}
  ],
  "wiki_pages": [
    {{
      "pageType": "source-summary",
      "title": "canonical page title",
      "description": "one-line description",
      "tags": ["specific-tag"],
      "body": "complete resulting Markdown body without YAML frontmatter"
    }}
  ],
  "associations": [
    {{
      "target": 2,
      "reason": "why the new/revised source may have a direct relationship with DOCUMENT 2",
      "confidence": 0.0
    }}
  ]
}}

Rules:
- Use numeric DOCUMENT IDs only.
- Every trail must have at least two documents.
- Prefer several precise trails over broad catch-all categories.
- Shared geography, chronology, title words, or generic subject alone is weak.
- A document may remain untrailed.
- "associations" concerns DOCUMENT {queued_doc['id']} only.
- Association suggestions go directly to human review; there is no automated verifier.
- Confidence is the main model's own confidence in the suggestion.
- Zero association candidates is valid.
- Do not return an empty trail list if any defensible multi-document
  relationship exists.
- "wiki_pages" is REQUIRED. Always return a source-summary page for the NEW
  OR REVISED source. Return additional entity/topic/comparison/synthesis pages
  only when this source materially creates or changes persistent knowledge.
- For an existing derived page whose FULL content is supplied below, preserve
  supported prior knowledge and return the complete resulting body. Do not
  return a patch/diff. Do not update catalogue-only pages whose full content is
  not supplied.
- Derived page bodies must not contain YAML frontmatter. The processor owns YAML,
  provenance, source links, deterministic aliases, and the wiki index.
- TOP PRIORITY: Write a genuinely SYNTHESIZED source-summary with 2-4
  informative thematic ## sections and 5-9 substantive findings. Explain the
  evidence in your own words; NEVER output extracted-passage headings, a
  list of verbatim source quotations, or copied passages.
- Source-page citations are SECONDARY. Add inline memex-source-pages markers
  only when the verified printed-page map confidently supports the claim;
  otherwise omit the marker. Uncited findings are accepted for human review.
  Do not guess page numbers, use document IDs, or confuse extraction-local
  Docling prov.page_no values with printed source page numbers.
- Keep source-summary content under meaningful Markdown section headings so the
  processor can derive a stable HedgeDoc heading anchor. Do not emit
  memex_source_pages or memex_source_anchor YAML; the processor/route owns them.

CURRENT DERIVED WIKI CONTEXT:

{wiki_context}

NEW OR REVISED SOURCE FULL CONTENT:

{queued_text}

SOURCE MEMORY:

{chr(10).join(bootstrap_docs)}
"""
    print(
        "Memex trail bootstrap",
        len(docs),
        "documents...",
        f"model={MODEL}",
    )
    bootstrap_content = llm_chat(
        bootstrap_prompt,
        num_ctx=min(NUM_CTX, 32768),
    )
    result = parse_json_object(bootstrap_content)

else:
    system_prompt = f"""
    You are discovering meaningful Memex trails across source documents.

    A MEMEX TRAIL is a conceptual traversal through documents that share a
    meaningful relationship. It is NOT merely a category, date-sorted list,
    search result, or collection of everything about the same town.

    Review the supplied document context together.

    DOCUMENT NEW_SOURCE_ID is the NEW OR REVISED source.

    The FROZEN BATCH MEMEX INDEX contains the reusable 12-source comparison
    baseline plus all maintained trails with stable DOCUMENT ids.

    SOURCE DOCUMENTS contains ONLY DOCUMENT NEW_SOURCE_ID. Do not treat the full
    historical source registry as a fresh review corpus. Focus all new source
    analysis on DOCUMENT NEW_SOURCE_ID while reviewing every maintained trail.

    TRAIL MODE is supplied in the user message.

    MAINTENANCE REQUIREMENT:
    Review ALL maintained trails represented by the FROZEN BATCH MEMEX INDEX
    after applying the CUMULATIVE TRAIL CHANGES SINCE BATCH START supplied in the
    user message. Those cumulative changes are authoritative over the frozen base.
    Full review is mandatory, but unchanged trails MUST NOT be regenerated.

    Return only trail_changes for trails that actually need mutation. A maintained
    trail omitted from trail_changes means it was reviewed, remains valid, and must
    be preserved exactly by the processor.

    Use op=upsert to create or replace a changed trail. An upsert must return the
    complete resulting state for that changed trail: name, reason, confidence, and
    ordered members. Use op=delete only when a maintained trail is no longer valid.
    To rename a trail, delete the old name and upsert the new name.

    DISCOVER TRAILS USING DISTINCT CONCEPTUAL LENSES, for example:
    - shared activity or purpose
    - shared venue or setting
    - shared audience or community
    - related cultural form
    - related market/commercial activity
    - related organisation or participants
    - thematic or functional relationship
    - meaningful sequence or progression supported by the source content

    IMPORTANT TRAIL RULES:

    1. Prefer MULTIPLE useful trails when the documents support different
       relationships.

    2. Documents MAY belong to several trails when each membership expresses
       a genuinely different relationship.

    3. A document may remain outside every trail when no meaningful relationship
       to another supplied document is supported. Never invent a weak catch-all
       relationship merely to avoid an untrailed document.

    4. Every trail must contain at least 2 documents. In BOOTSTRAP mode, return at
       least one trail whenever any defensible multi-document relationship exists.

    5. Do NOT create a catch-all trail simply because documents are:
       - local events
       - in Liphook
       - upcoming
       - in the same month or date range
       - sorted chronologically

    6. Chronology alone is NOT a meaningful Memex relationship.
       Do not create trails such as "Upcoming Events Aug-Oct" merely to connect
       otherwise unrelated documents.

    7. Order members according to the conceptual traversal of that trail.
       Use chronological order ONLY when time itself is essential to the
       relationship.

    8. Prefer a smaller precise trail over a broad vague trail.

    9. Trail names must describe the actual relationship.
       Good examples:
       - Community Markets and Sales
       - Outdoor Cinema Experiences
       - Live Performance and Cultural Events

       Bad examples:
       - Upcoming Local Events
       - Liphook Events
       - August to October Events
       - General Activities

    10. Do not invent relationships unsupported by the source documents.

    11. Before returning the answer, internally compare possible overlapping
        trails and discard weak, redundant, catch-all, or chronology-only trails.

    Return JSON only:

    {{
      "summary": "short explanation of the conceptual structure discovered",
      "documents": [
        {{
          "id": 1,
          "summary": "one concise factual line describing this source"
        }}
      ],
      "reviewed_trail_count": 0,
      "trail_changes": [
        {{
          "op": "upsert",
          "name": "specific conceptual trail name",
          "reason": "the concrete relationship shared by these documents",
          "confidence": 0.0,
          "members": [1, 2, 3]
        }},
        {{
          "op": "delete",
          "name": "obsolete maintained trail name"
        }}
      ],
      "wiki_pages": [
        {{
          "pageType": "source-summary",
          "title": "canonical page title",
          "description": "one-line description",
          "tags": ["specific-tag"],
          "body": "complete resulting Markdown body without YAML frontmatter"
        }}
      ]
    }}

    CRITICAL:
    Review every maintained trail before returning the answer.
    The example reviewed_trail_count value 0 is a placeholder.
    reviewed_trail_count MUST equal LIVE EXISTING TRAIL COUNT from the user message.
    Use ONLY numeric DOCUMENT IDs in upsert members.
    Never reproduce aliases.
    Do not output your analysis.
    Do not force every document into a trail.
    Do not emit unchanged trails in trail_changes.
    In "documents", return a summary for the NEW OR REVISED SOURCE.
    Do not rewrite summaries merely because a document is INDEX SUMMARY ONLY.

    The top-level JSON field "wiki_pages" is REQUIRED.
    - Always return exactly one useful source-summary page for the NEW OR REVISED
      source. On later revisions, update the same source-summary title rather than
      creating a renamed duplicate.
    - Also create/update entity, topic, comparison, or synthesis pages when the
      new evidence materially affects them. Zero additional pages is valid.
    - Existing derived pages may be revised only when their FULL current Markdown
      appears in CURRENT DERIVED WIKI CONTEXT. Catalogue-only pages must not be
      rewritten.
    - For an existing page, preserve supported prior knowledge, incorporate the new
      evidence, surface contradictions/uncertainty, maintain useful cross-links,
      and return the COMPLETE resulting Markdown body, not a patch or diff.
    - Do not copy YAML frontmatter into "body". The processor owns YAML metadata,
      source provenance, deterministic aliases, and the derived wiki index.
    - TOP PRIORITY: Provide a meaningful original synthesis. Use 2-4
      thematic ## headings with 5-9 substantive findings. Never copy a list
      of source quotations or say 'Extracted source passages'.
    - Source-page citations are OPTIONAL. Include only confidently verified
      printed source page numbers; NEVER invent or guess missing citations.
      The validator flags incomplete coverage for human review rather than
      replacing or rejecting a useful synthesized summary.
    - For any VERIFIED inline source-page citation, follow the maintained
      8_A Heritage Impact Assessment pattern: put it directly after the
      statement it supports.
    - Never put one standalone/catch-all memex-source-pages marker at the end of
      the source-summary. Docling prov.page_no values are extraction-local and
      must never be exposed directly. Never invent or infer an unmapped page.
    - Keep source-summary content under meaningful Markdown section headings so the
      processor can derive a stable HedgeDoc heading anchor. Do not emit
      memex_source_pages or memex_source_anchor YAML; the processor/route owns them.
    - Do not modify raw HedgeDoc source notes. Derived pages must remain grounded
      in supplied source evidence and existing derived-page content.
    - Return at most 12 wiki_pages.

    The top-level JSON field "associations" is REQUIRED, even when it is empty.
    It contains candidate direct relationships from the NEW OR REVISED source only:

    "associations": [
      {{
        "target": 2,
        "reason": "why the new/revised source may be directly associated with DOCUMENT 2",
        "confidence": 0.0
      }}
    ]

    Association candidate rules:
    - The source is implicitly DOCUMENT NEW_SOURCE_ID; return only target IDs.
    - A target must be another supplied DOCUMENT.
    - Zero candidates is valid: return "associations": [].
    - Do not create a candidate merely because two documents share a trail,
      broad topic, place category, chronology, title words, or keywords.
    - Propose a candidate only when the supplied evidence gives a concrete reason
      for a direct relationship.
    - Include confidence from 0.0 to 1.0 for each suggestion.
    - Suggestions go directly to human review. There is no automated verifier
      and Process Pending does not create canonical association edges.

    FROZEN BATCH MEMEX INDEX BASE:
    Use this stable batch-start index as reusable navigation/context. The
    CUMULATIVE TRAIL CHANGES SINCE BATCH START and source documents in the user
    message are newer and authoritative whenever they differ from this frozen base.

    {prompt_index}

    The RECENT MEMEX LOG supplied in the user message is operational history,
    not source evidence. Use it to understand recent ingests, queries, revision
    checks, and lint results. Do not create a trail or associated_with suggestion
    from log text alone. Evidence for maintained knowledge must come from the
    the frozen 12-source baseline summaries, maintained trail state, and the
    supplied NEW OR REVISED source document.
    """

    user_prompt = f"""
NEW OR REVISED SOURCE DOCUMENT ID: {queued_doc["id"]}
TRAIL MODE: {trail_mode}
LIVE EXISTING TRAIL COUNT: {existing_trail_count}

CUMULATIVE TRAIL CHANGES SINCE BATCH START:
{batch_trail_delta}

RECENT MEMEX LOG:
{recent_log}

CURRENT DERIVED WIKI CONTEXT:
{wiki_context}

SOURCE DOCUMENTS:

{prompt_docs}
"""

    print(
        "Memex reviewing NEW SOURCE only:",
        f"document_id={queued_doc['id']}",
        f"baseline_sources={len(BATCH_BASELINE_ALIASES)}",
        f"indexed_registry={len(docs)}",
        f"trails={existing_trail_count}",
        f"model={MODEL}",
    )

    capture_system_prompt_path = os.environ.get(
        "MEMEX_CAPTURE_SYSTEM_PROMPT_PATH",
        "",
    ).strip()
    if capture_system_prompt_path:
        capture_path = Path(capture_system_prompt_path)
        capture_path.parent.mkdir(parents=True, exist_ok=True)
        capture_path.write_text(system_prompt, encoding="utf-8")

    llm_content = llm_chat(
        user_prompt,
        num_ctx=NUM_CTX,
        system_prompt=system_prompt,
    )
    try:
        result, llm_content, escaped = parse_json_object_with_escape_recovery(
            llm_content
        )
        if escaped:
            print(
                f"MEMEX deterministic JSON escape recovery: "
                f"corrected={escaped} stage=initial",
                flush=True,
            )
    except (json.JSONDecodeError, ValueError) as first_error:
        repair_dir = Path("/data/builds/memex-peg-recovery/json-errors")
        repair_dir.mkdir(parents=True, exist_ok=True)

        bad_path = repair_dir / f"{queued_alias}-original.txt"
        bad_path.write_text(llm_content, encoding="utf-8")

        print(
            f"MEMEX malformed JSON: {first_error}; "
            f"saved={bad_path}",
            flush=True,
        )

        repair_error = first_error

        for repair_attempt in range(1, 4):
            repair_prompt = f"""Repair the malformed JSON below.

Return exactly one valid JSON object.
Do not add markdown fences.
Do not add commentary.
Do not omit fields merely because they are difficult to repair.
Preserve the semantic content and existing field names as closely as possible.

Python JSON parser error:
{repair_error}

MALFORMED JSON:
{llm_content}
"""

            print(
                f"MEMEX JSON repair attempt {repair_attempt}/3",
                flush=True,
            )

            repaired_content = llm_chat(
                repair_prompt,
                num_ctx=NUM_CTX,
                system_prompt=(
                    "You are a strict JSON repair tool. "
                    "Output one valid JSON object and nothing else."
                ),
            )

            repair_path = (
                repair_dir
                / f"{queued_alias}-repair-{repair_attempt}.txt"
            )
            repair_path.write_text(
                repaired_content,
                encoding="utf-8",
            )

            try:
                result, llm_content, escaped = parse_json_object_with_escape_recovery(
                    repaired_content
                )
                if escaped:
                    print(
                        f"MEMEX deterministic JSON escape recovery: "
                        f"corrected={escaped} stage=llm-repair-{repair_attempt}",
                        flush=True,
                    )
                print(
                    f"MEMEX JSON repair succeeded "
                    f"attempt={repair_attempt}",
                    flush=True,
                )
                break
            except (json.JSONDecodeError, ValueError) as exc:
                repair_error = exc
                llm_content = repaired_content
                print(
                    f"MEMEX JSON repair still invalid: {exc}",
                    flush=True,
                )
        else:
            raise RuntimeError(
                "MEMEX JSON repair failed after 3 attempts: "
                f"{repair_error}"
            )


if existing_trail_count == 0 and not result.get("trails"):
    print(
        "No trails returned during bootstrap; retrying trail discovery...",
        f"model={MODEL}",
    )
    retry_prompt = f"""
You are rebuilding an empty Memex trail catalogue.

Using ONLY the supplied compact source memory below, identify every strong,
useful relationship shared by TWO OR MORE documents.

Return JSON only:
{{
  "trails": [
    {{
      "name": "specific relationship name",
      "reason": "concrete relationship supported by the supplied documents",
      "confidence": 0.0,
      "members": [1, 2]
    }}
  ]
}}

Rules:
- Use numeric DOCUMENT IDs only.
- Every trail needs at least two documents.
- Prefer several precise trails over broad catch-all categories.
- Shared geography, chronology, or generic subject alone is insufficient.
- A document may remain untrailed.
- Do not return an empty list if any defensible multi-document relationship
  exists.

SOURCE MEMORY:

{chr(10).join(bootstrap_docs)}
"""
    retry_content = llm_chat(
        retry_prompt,
        num_ctx=NUM_CTX,
    )
    retry_result = parse_json_object(retry_content)
    if isinstance(retry_result.get("trails"), list):
        result["trails"] = retry_result["trails"]

wiki_mutations = normalize_wiki_mutations_with_repair(
    result,
    user_prompt,
    wiki_registry,
    queued_alias,
    verified_source_pages,
    source_page_map,
    source_text=queued_doc["content"],
)
print(
    "LLM derived wiki mutations:",
    f"pages={len(wiki_mutations)}",
    "types=" + ",".join(page["pageType"] for page in wiki_mutations),
)

valid_ids = {d["id"] for d in docs}
alias_to_id = {d["alias"]: d["id"] for d in docs}


def parse_existing_index_trails(index_text):
    if "## Trails" not in index_text:
        return []

    section = index_text.split("## Trails", 1)[1]
    parsed = []
    current = None

    def finish():
        nonlocal current
        if current:
            current["members"] = list(dict.fromkeys(current["members"]))
            if len(current["members"]) >= 2:
                parsed.append(current)
        current = None

    for raw in section.splitlines():
        line = raw.strip()

        if line.startswith("### "):
            finish()
            current = {
                "name": line[4:].strip() or "Untitled Trail",
                "reason": "",
                "confidence": 0,
                "members": [],
            }
            continue

        if current is None or not line:
            continue

        if line.startswith("- [") and "](" in line:
            url = line.split("](", 1)[1].split(")", 1)[0]
            if "/n/" in url:
                alias = url.rsplit("/n/", 1)[1].split("?", 1)[0].split("#", 1)[0]
                doc_id = alias_to_id.get(alias)
                if doc_id is not None:
                    current["members"].append(doc_id)
            continue

        if not current["reason"]:
            current["reason"] = line

    finish()
    return parsed


existing_trails = parse_existing_index_trails(current_index)

# Existing maintained trails are authoritative non-destructive memory. In
# maintenance mode the LLM reviews every trail but returns only explicit changes;
# omitted trails are preserved exactly as maintained state. Bootstrap still
# returns a complete trail set because no maintained catalogue exists yet.
trail_by_name = {
    re.sub(r"\s+", " ", trail["name"]).strip().casefold(): trail
    for trail in existing_trails
}

if existing_trail_count == 0:
    returned_trails = []
    for trail in result.get("trails", []):
        if not isinstance(trail, dict):
            continue
        members = [
            int(x) for x in trail.get("members", [])
            if isinstance(x, int) and x in valid_ids
        ]
        members = list(dict.fromkeys(members))
        if len(members) >= 2:
            returned_trails.append({
                "name": str(trail.get("name", "Untitled Trail")).strip(),
                "reason": str(trail.get("reason", "")).strip(),
                "confidence": trail.get("confidence", 0),
                "members": members,
            })

    for trail in returned_trails:
        key = re.sub(r"\s+", " ", trail["name"]).strip().casefold()
        trail_by_name[key] = trail

    print(
        "LLM trail bootstrap result:",
        f"returned={len(returned_trails)}",
    )
else:
    try:
        reviewed_trail_count = int(result.get("reviewed_trail_count"))
    except (TypeError, ValueError):
        raise ValueError(
            'Maintenance response must contain integer "reviewed_trail_count"'
        )

    if reviewed_trail_count != existing_trail_count:
        raise ValueError(
            "Maintenance response reviewed_trail_count mismatch: "
            f"expected={existing_trail_count} got={reviewed_trail_count}"
        )

    trail_changes = result.get("trail_changes")
    if not isinstance(trail_changes, list):
        raise ValueError(
            'Maintenance response must contain top-level "trail_changes" array'
        )

    upserts = 0
    deletes = 0
    skipped = 0

    for change in trail_changes:
        if not isinstance(change, dict):
            raise ValueError("Every trail_changes item must be an object")

        op = str(change.get("op", "")).strip().lower()
        name = str(change.get("name", "")).strip()
        if not name:
            raise ValueError("Every trail change requires a trail name")

        key = re.sub(r"\s+", " ", name).strip().casefold()

        if op == "delete":
            if key not in trail_by_name:
                raise ValueError(
                    f"Cannot delete unknown maintained trail: {name}"
                )
            trail_by_name.pop(key)
            deletes += 1
            continue

        if op != "upsert":
            raise ValueError(
                f"Unsupported trail change op for {name}: {op or '<missing>'}"
            )

        raw_members = change.get("members", [])
        if not isinstance(raw_members, list):
            action = "preserve-existing" if key in trail_by_name else "skip-new"
            skipped += 1
            print(
                "LLM compact trail change skipped:",
                f"name={name}",
                "reason=members-not-array",
                f"action={action}",
            )
            continue

        members = [
            int(x) for x in raw_members
            if isinstance(x, int) and x in valid_ids
        ]
        members = list(dict.fromkeys(members))
        if len(members) < 2:
            action = "preserve-existing" if key in trail_by_name else "skip-new"
            skipped += 1
            print(
                "LLM compact trail change skipped:",
                f"name={name}",
                f"valid_members={len(members)}",
                "reason=requires-at-least-two-valid-members",
                f"action={action}",
            )
            continue

        trail_by_name[key] = {
            "name": name,
            "reason": str(change.get("reason", "")).strip(),
            "confidence": change.get("confidence", 0),
            "members": members,
        }
        upserts += 1

    print(
        "LLM compact trail review:",
        f"reviewed={reviewed_trail_count}",
        f"changes={len(trail_changes)}",
        f"upserts={upserts}",
        f"deletes={deletes}",
        f"skipped={skipped}",
        f"maintained={len(trail_by_name)}",
    )

trails = list(trail_by_name.values())

# Build membership and traversal edges
memberships = {d["id"]: [] for d in docs}
edges = {d["id"]: [] for d in docs}

for trail in trails:
    name = trail["name"]
    relation = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')

    for doc_id in trail["members"]:
        memberships[doc_id].append(name)

    for a, b in zip(trail["members"], trail["members"][1:]):
        edges[a].append((relation, b))

id_to_doc = {d["id"]: d for d in docs}

raw_association_candidates = result.get("associations", [])
if not isinstance(raw_association_candidates, list):
    raise ValueError(
        'Ollama response must contain top-level "associations" array'
    )

association_suggestions = []
seen_target_ids = set()

for item in raw_association_candidates:
    if not isinstance(item, dict):
        continue

    try:
        target_id = int(item.get("target"))
    except (TypeError, ValueError):
        continue

    if (
        target_id == queued_doc["id"]
        or target_id not in id_to_doc
        or target_id in seen_target_ids
    ):
        continue

    reason = " ".join(str(item.get("reason", "")).split())
    if not reason:
        continue

    try:
        confidence = float(item.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    target_doc = id_to_doc[target_id]
    seen_target_ids.add(target_id)
    association_suggestions.append({
        "target": target_doc["alias"],
        "targetTitle": target_doc["title"],
        "reason": reason,
        "confidence": confidence,
    })

print(
    "LLM association suggestions:",
    f"candidates={len(association_suggestions)}",
    "automated-verifier=disabled",
)

graph = []

for d in docs:
    graph.append(f"# {d['title']} · {d['alias']}")
    graph.append(f"alias: {d['alias']};")

    for trail in memberships[d["id"]]:
        graph.append(f"trail: {trail};")

    for relation, target_id in edges[d["id"]]:
        target = id_to_doc[target_id]
        graph.append(
            f"<{relation}> {target['title']} · {target['alias']};"
        )

    graph.append("")

# Legacy trail-test frontmatter; unrelated to derived source-summary pages.
frontmatter = f"""---
okf_type: Index
title: "Liphook Events — Free LLM Trail Test"
description: "The configured Memex model maintains trails after reviewing queued HedgeDoc revisions."
tags:
  - memex
  - llm-test
  - trails
status: experimental
---"""

body = [
    frontmatter,
    "",
    "# Liphook Events — Free LLM Trail Test",
    "",
    f"Updated from Memex queue using `{MODEL}`.",
    "",
    f"Queued source: `{queued_alias}`",
    f"Source revision: `{queued_doc['revision']}`",
    "",
    "Main-model association suggestions become human-review recommendations after successful lint; no automated verifier is used.",
    "",
    "## LLM review",
    "",
    result.get("summary", ""),
    "",
]

for trail in trails:
    body += [
        f"### {trail['name']}",
        "",
        trail["reason"],
        "",
        f"Confidence: `{trail['confidence']}`",
        "",
    ]

body += [
    "## Graph",
    "",
    "```nodeBook",
    *graph,
    "```",
    "",
]

# The canonical Memex network note is a lightweight presentation host.
# Trail membership and direct source associations are loaded dynamically by
# Memex mode from /memex-trails and /memex-associations. A unique refresh
# marker changes on every run so HedgeDoc records a new revision.
host_refresh_at = datetime.now(timezone.utc).isoformat()
new_nodebook = "\n".join(
    [
        "# Memex Network",
        "",
        "```memex",
        "Memex Association Network",
        "```",
        "",
        f"<!-- memex-refresh:{queued_alias}:{host_refresh_at} -->",
        "",
    ]
)

def build_candidate_index():
    summary_by_id = {}

    for item in result.get("documents", []):
        if not isinstance(item, dict):
            continue

        try:
            doc_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue

        summary = " ".join(str(item.get("summary", "")).split())
        if summary:
            summary_by_id[doc_id] = summary

    public_base = __import__("os").environ.get(
        "MEMEX_HEDGEDOC_BASE_URL",
        "http://192.168.1.142:8180",
    ).rstrip("/")

    index_lines = [
        "# Memex Index",
        "",
        "Content-oriented index maintained after successful Memex processing.",
        "",
        "## Sources",
        "",
    ]

    for doc in docs:
        summary = summary_by_id.get(
            doc["id"],
            doc.get("summary") or f"Source note: {doc['title']}.",
        )
        url = f"{public_base}/n/{doc['alias']}"
        index_lines.append(f"- [{doc['title']}]({url}) — {summary}")

    index_lines.extend(["", "## Trails", ""])

    doc_by_id = {doc["id"]: doc for doc in docs}

    for trail in trails:
        index_lines.append(f"### {trail['name']}")

        if trail.get("reason"):
            index_lines.extend(["", trail["reason"]])

        index_lines.append("")

        for doc_id in trail["members"]:
            doc = doc_by_id.get(doc_id)
            if doc:
                url = f"{public_base}/n/{doc['alias']}"
                index_lines.append(f"- [{doc['title']}]({url})")

        index_lines.append("")

    return "\n".join(index_lines).rstrip() + "\n"


candidate_index = ensure_index_labels(build_candidate_index())

# Keep the previous index and canonical host so a failed lint cannot damage
# the accepted Memex state.
old_index = current_index
old_nodebook = api_get(f"{NODEBOOK}/content")
before = json.loads(api_get(f"{NODEBOOK}/revisions"))
before_uuid = max(before, key=lambda x: x["createdAt"])["uuid"]

# Lint validates the candidate index and canonical Memex host together.
INDEX_PATH.write_text(candidate_index, encoding="utf-8")

try:
    status = api_put(NODEBOOK, new_nodebook)
except Exception:
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    raise

# MEMEX_ORPHAN_LINT_GATE
# The generated index/nodeBook must satisfy the no-orphan invariant before
# this queue item is allowed to become processed.
_lint_script = Path(__file__).with_name("lint_memex.py")
_lint_result = __import__("subprocess").run(
    [
        __import__("sys").executable,
        str(_lint_script),
        "--include-alias",
        queued_alias,
    ],
    cwd=str(Path(__file__).resolve().parents[1]),
    text=True,
    capture_output=True,
)

if _lint_result.stdout:
    print(_lint_result.stdout, end="")

if _lint_result.stderr:
    print(_lint_result.stderr, end="", file=__import__("sys").stderr)

if _lint_result.returncode != 0:
    print("Lint failed; restoring previous index and Memex host...")
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    api_put(NODEBOOK, old_nodebook)
    raise SystemExit(
        f"Memex lint rejected {queued_alias}; "
        "previous nodeBook restored; queue item remains pending"
    )

# Main-model association suggestions become recommendations only after the
# candidate index/nodeBook state passes lint. There is no automated verifier.
# Canonical graph mutation remains a separate human Accept action.
try:
    recommendation_sync = append_association_recommendations(
        queued_doc,
        association_suggestions,
        pending,
    )
except Exception as exc:
    print(
        "Association recommendation write failed; restoring previous index and Memex host...",
        file=__import__("sys").stderr,
    )
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    api_put(NODEBOOK, old_nodebook)
    raise SystemExit(
        f"Memex association recommendation rejected {queued_alias}: {exc}; "
        "previous index/nodeBook restored; queue item remains pending"
    )

# Derived wiki mutation is part of successful source processing. The route owns
# deterministic aliases, YAML/provenance, source links, and wiki index maintenance.
# If it fails, the queue item remains pending. Any already-written association
# recommendation is deduplicated on retry.
try:
    wiki_sync = commit_wiki_mutations(
        wiki_mutations,
        f"source-ingest {queued_alias} revision {queued_doc['revision']}",
    )
except Exception as exc:
    print(
        "Derived wiki write failed; restoring previous index and Memex host...",
        file=__import__("sys").stderr,
    )
    INDEX_PATH.write_text(old_index, encoding="utf-8")
    api_put(NODEBOOK, old_nodebook)
    raise SystemExit(
        f"Memex derived wiki update rejected {queued_alias}: {exc}; "
        "previous index/nodeBook restored; queue item remains pending"
    )

# Mark queue entry processed
now = datetime.now(timezone.utc).isoformat()

for row in rows:
    if row.get("id") == pending["id"]:
        row["status"] = "processed"
        row["processedAt"] = now
        row["sourceRevision"] = queued_doc["revision"]
        row["nodeBook"] = NODEBOOK

QUEUE.write_text(
    "".join(json.dumps(x) + "\n" for x in rows)
)

after = json.loads(api_get(f"{NODEBOOK}/revisions"))
after_uuid = max(after, key=lambda x: x["createdAt"])["uuid"]

print()
print("=== DONE ===")
print("HTTP:", status)
print("source:", queued_alias)
print("source revision:", queued_doc["revision"])
print("trails:", len(trails))
print("nodeBook:", f"http://192.168.1.142:8280/n/{NODEBOOK}")
print("previous nodeBook revision:", before_uuid)
print("current nodeBook revision:", after_uuid)
print("queue status: processed")
print(
    "Association recommendations:",
    f"added={recommendation_sync['added']}",
    f"pending={recommendation_sync['pending']}",
)
print("association review store:", RECOMMENDATIONS_FILE)
print(
    "derived wiki:",
    f"updated={len(wiki_sync.get('pages', []))}",
    f"index={wiki_sync.get('indexAlias', 'memex-wiki-index')}",
)
for wiki_page in wiki_sync.get("pages", []):
    if isinstance(wiki_page, dict):
        print(
            "derived wiki page:",
            wiki_page.get("pageType", "?"),
            wiki_page.get("alias", "?"),
        )
print("main model:", MODEL)
print("association verifier: disabled; human review is authoritative")
print("trail mode:", trail_mode)
if existing_trail_count == 0:
    print("full maintenance prompt: skipped during empty-index bootstrap")


# MEMEX_INDEX_LOG_MAINTENANCE
import os as _os
from datetime import datetime as _datetime, timezone as _timezone

_summary_by_id = {}
for _item in result.get("documents", []):
    if not isinstance(_item, dict):
        continue
    try:
        _id = int(_item.get("id"))
    except (TypeError, ValueError):
        continue
    _summary = " ".join(str(_item.get("summary", "")).split())
    if _summary:
        _summary_by_id[_id] = _summary

_public_base = _os.environ.get(
    "MEMEX_HEDGEDOC_BASE_URL",
    "http://192.168.1.142:8180"
).rstrip("/")

_index = [
    "# Memex Index",
    "",
    "Content-oriented index maintained after successful Memex processing.",
    "",
    "## Sources",
    "",
]

for _doc in docs:
    _summary = _summary_by_id.get(
        _doc["id"],
        _doc.get("summary") or f"Source note: {_doc['title']}."
    )
    _url = f"{_public_base}/n/{_doc['alias']}"
    _index.append(f"- [{_doc['title']}]({_url}) — {_summary}")

_index.extend(["", "## Trails", ""])

_doc_by_id = {d["id"]: d for d in docs}

for _trail in trails:
    _index.append(f"### {_trail['name']}")
    if _trail.get("reason"):
        _index.append("")
        _index.append(_trail["reason"])
    _index.append("")
    for _id in _trail["members"]:
        _doc = _doc_by_id.get(_id)
        if _doc:
            _url = f"{_public_base}/n/{_doc['alias']}"
            _index.append(f"- [{_doc['title']}]({_url})")
    _index.append("")

_final_index = ensure_index_labels("\n".join(_index).rstrip() + "\n")
INDEX_PATH.write_text(_final_index, encoding="utf-8")

if not LOG_PATH.exists():
    LOG_PATH.write_text("# Memex Log\n\n", encoding="utf-8")

_stamp = _datetime.now(_timezone.utc).isoformat(timespec="seconds")
_summary = " ".join(str(result.get("summary", "")).split())

with LOG_PATH.open("a", encoding="utf-8") as _fh:
    _fh.write(
        f"## [{_stamp}] ingest | {queued_alias}\n\n"
        f"- revision: `{queued_doc['revision']}`\n"
        f"- cached index sources: {sum(1 for d in docs if d.get('cached'))}\n"
        f"- full HedgeDocs read: {sum(1 for d in docs if not d.get('cached'))}\n"
        f"- documents represented: {len(docs)}\n"
        f"- trails: {len(trails)}\n"
        f"- LLM associated_with suggestions: {len(association_suggestions)}\n"
        f"- derived wiki pages updated: {len(wiki_sync.get('pages', []))}\n"
        f"- derived wiki catalogue pages seen: {wiki_catalogue_count}\n"
        f"- full derived wiki pages supplied to LLM: {wiki_context_page_count}\n"
        f"- index read by LLM: yes\n"
        f"- recent log entries supplied to LLM: {recent_log_entry_count}\n"
        f"- LLM called: yes\n"
        f"- main model: `{MODEL}`\n"
        f"- association verifier: disabled; human review authoritative\n"
        f"- nodeBook: `{NODEBOOK}`\n"
        f"- summary: {_summary or 'No summary returned.'}\n\n"
    )

sync_readonly_mirror("memex-index", INDEX_PATH)
sync_readonly_mirror("memex-log", LOG_PATH)

print("index:", INDEX_PATH)
print("log:", LOG_PATH)
