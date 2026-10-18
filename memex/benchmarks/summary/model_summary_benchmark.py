#!/usr/bin/env python3
"""Read-only direct-LLM summary benchmark. Never imports the Memex wiki processor.

Five calls to llama.cpp: baseline A, comprehensive B, and three B repeats.
Deterministic checks are screening heuristics, never a factual-accuracy certificate.
"""
from __future__ import annotations

import argparse
import fcntl
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'fixtures/64_PAS_9980_FINAL.txt'
WIKI_REFERENCE = HERE / 'fixtures/64_PAS_9980_FINAL.wiki-reference-2026-10-17.md'
DEFAULT_SETTINGS = Path('/data/projects/hedgedoc/memex/model-settings.json')
DEFAULT_RESULTS = HERE / 'results'
SOURCE_INDEX = HERE.parents[1] / 'index.md'  # project_root/memex/index.md (see below)
# Fixture is always available; for selected HedgeDoc notes benchmark the *original* source.
HEDGEDOC_API = 'http://127.0.0.1:3100/api/v2/notes'
MAX_SOURCES = 3
MAX_SOURCE_CHARS = 48000
GOLD_DIR = HERE / 'gold'
FRONTIER_ENV = HERE.parents[2] / '.env.memex-benchmark'
ALLOWED_ROLES = ('local', 'frontier')
ALIAS_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')


# Each criterion demands distinct semantic coverage. These are *heuristics*:
# a weakly worded or contradicted claim may still trigger a hit.
CRITERIA = {
    '14-no-pro-forma': [r'no (?:fixed|prescribed|mandatory|specific|required) (?:format|template|pro.?forma)', r'(?:format|template|pro.?forma).{0,60}(?:not|no).{0,18}(?:prescribed|mandatory|required)'],
    '14-factual-low-risk': [r'(?:factual|fact.?based)', r'(?:inherent(?:ly)?|intrinsic(?:ally)?) low[ -]risk'],
    '14.1-informs-FRA': [r'\bFRA\b', r'fire risk assessment'],
    '14.2-no-regulation-compliance': [r'(?:not|does not|doesn.t|isn.t|cannot|rather than).{0,90}(?:compli|certif)', r'(?:compli|certif).{0,90}(?:not|does not|doesn.t|isn.t|cannot)'],
    '14.3-conditional-signatory-competence': [r'(?:competenc|competent|qualifi).{0,75}(?:signator|signer|author)', r'(?:signator|signer|author).{0,75}(?:competenc|competent|qualifi)'],
    '14.3-Figure-1-condition': [r'figure\s*1', r'(?:low[ -]risk|conditional).{0,90}(?:procedure|process|flowchart)'],
    '14.4a-appraiser-organisation': [r'\bappraiser\b', r'(?:organisation|organization|employer|firm)'],
    '14.4b-report-and-inspection-dates': [r'(?:report|complet).{0,65}dat', r'inspection.{0,45}dat', r'dat.{0,45}inspection'],
    '14.4c-building-address': [r'\baddress\b', r'(?:building|property).{0,35}location'],
    '14.4d-building-use': [r'(?:use|usage|occupancy|purpose)\s*(?:of|for|\(s\))?\s*(?:the\s*)?building', r'building.{0,40}(?:use|occupancy|purpose)'],
    '14.4e-building-dimensions': [r'dimension|height|storey|stories|floor area'],
    '14.4f-building-age': [r'(?:age|year.{0,20}built|date.{0,20}construct|approximate.{0,15}age)'],
    '14.4g-low-risk-rationale': [r'(?:justif|explain|reason|rationale|basis).{0,75}low[ -]risk', r'low[ -]risk.{0,75}(?:justif|explain|reason|rationale|basis)'],
    '14.4h-statutory-dutyholder-info': [r'(?:dutyholder|statutory dut|legal dut|fire safety.*regulat)'],
}

PROMPT_B_GENERAL = ("Produce a comprehensive, accurate summary of the following source. Cover ALL substantive sections, requirements, "
                    "exceptions, qualifications, dates, numerical values, and limitations. Preserve the source's exact modal force "
                    "(should versus must). Do not invent facts. Use thematic Markdown headings and concise bullets. "
                    "Do not output JSON or page-citation markup.")

PROMPT_A = 'Summarize the following document accurately for a knowledgeable reader. Do not add information not present in the document.'
PROMPT_B = ("Provide a complete, accurate, concise summary of this document for a technical reader. "
            "Cover every substantive numbered clause and the minimum-report-information items (a–h), "
            "including conditions/exceptions and report scope. Preserve the source's modal force "
            '("should" is not "must"). Do not invent requirements. Use clear thematic headings and bullets; '
            'no page-citation syntax or JSON is needed.')


def score(text: str) -> dict:
    hits = {}
    for label, patterns in CRITERIA.items():
        hits[label] = any(re.search(p, text, re.I | re.S) for p in patterns)
    # Automated modal red-flag: may need human checking; never sufficient to reject.
    alerts = []
    if re.search(r'(?:report|appraiser|signator).{0,65}\bmust\b|\bmust\b.{0,65}(?:report|appraiser|signator)', text, re.I | re.S):
        alerts.append('Potentially strengthened SHOULD -> MUST; verify against source')
    return {'coverage_proxy': sum(hits.values()), 'coverage_total': len(hits),
            'checks': hits, 'alerts': alerts,
            'missing_proxy': [k for k, v in hits.items() if not v]}


def processor_pids() -> list[str]:
    """Return only currently running Memex queue jobs, not the benchmark itself."""
    try:
        output = subprocess.check_output(['ps', '-eo', 'pid=,args='], text=True)
    except (OSError, subprocess.CalledProcessError):
        raise RuntimeError('Cannot verify Memex queue is idle; aborting benchmark')
    result = []
    for line in output.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        pid, cmd = parts
        if (re.search(r'(?:^|\s)(?:[^ ]*/)?(?:process_queue_(?:batch|once)\.py|memex-first10\.py)(?:\s|$)', cmd)
                and not re.search(r'(?:bash -c|grep|pgrep|sh -c)', cmd)):
            result.append(f'{pid} {cmd[:160]}')
    return result


def validated_settings(path: Path) -> tuple[str, str]:
    settings = json.loads(path.read_text(encoding='utf-8'))
    if settings.get('provider') != 'llamacpp':
        raise RuntimeError('Benchmark requires provider=llamacpp; check memex/model-settings.json')
    base = str(settings.get('baseUrl', '')).rstrip('/')
    if not re.fullmatch(r'http://(?:192\.168\.1\.99|127\.0\.0\.1|localhost):8080(?:/v1)?', base):
        raise RuntimeError('Unexpected llama.cpp URL; no external/unapproved hosts allowed')
    if not base.endswith('/v1'):
        base += '/v1'
    model = str(settings.get('defaultModel', '')).strip()
    if not model:
        raise RuntimeError('Missing llama.cpp model in model-settings.json')
    return base, model



def frontier_configuration(config: Path = FRONTIER_ENV, environment=None) -> tuple[str, str, str]:
    """Server-only credentials. Never included in benchmark output or error messages."""
    variables = dict(os.environ if environment is None else environment)
    if config.is_file():
        for row in config.read_text(encoding='utf8').splitlines():
            match = re.match(r'^\s*(?:export\s+)?(MEMEX_BENCH_FRONTIER_(?:BASE_URL|MODEL|API_KEY))\s*=\s*(.*?)\s*$', row)
            if match and match.group(1) not in variables:
                variables[match.group(1)] = match.group(2).strip('\"\' ')
    base = variables.get('MEMEX_BENCH_FRONTIER_BASE_URL', '').strip().rstrip('/')
    model = variables.get('MEMEX_BENCH_FRONTIER_MODEL', '').strip()
    key = variables.get('MEMEX_BENCH_FRONTIER_API_KEY', '').strip()
    parsed = urllib.parse.urlparse(base)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
        or parsed.query or parsed.fragment or not parsed.path.endswith('/v1')
        or parsed.hostname in ('localhost', '127.0.0.1') or not model or not key
        or model.startswith('CHOOSE_') or key.startswith('REPLACE_')):
        raise RuntimeError('Frontier API not configured: set HTTPS /v1 URL, model and API key in .env.memex-benchmark')
    return base, model, key


def invoke_frontier(url: str, model: str, source: str, instruction: str, seed: int,
                    max_tokens: int, timeout: int, temperature: float, *, api_key: str) -> dict:
    """OpenAI-compatible chat-completions endpoint; no llama.cpp-only extensions."""
    # Many frontier reasoning models do not accept temperature or legacy max_tokens.
    # Keep the source/prompt/output budget identical, record sampling-parameter differences.
    def setting(name, default):
        key = 'MEMEX_BENCH_FRONTIER_' + name
        if os.environ.get(key):
            return os.environ[key].strip()
        if FRONTIER_ENV.is_file():
            for row in FRONTIER_ENV.read_text(encoding='utf8').splitlines():
                m = re.match(r'^\s*(?:export\s+)?' + re.escape(key) + r'\s*=\s*(.*?)\s*$', row)
                if m:
                    return m.group(1).strip('\"\' ')
        return default
    token_field = setting('TOKEN_FIELD', 'max_completion_tokens')
    if token_field not in ('max_completion_tokens', 'max_tokens'):
        raise RuntimeError('Invalid frontier token field configuration')
    body = {
        'model': model, 'messages': [
            {'role': 'system', 'content': 'You are evaluating model comprehension. Base all claims only on the supplied document.'},
            {'role': 'user', 'content': f'{instruction}\n\n=== ORIGINAL SOURCE TEXT ===\n{source}\n=== END ==='},
        ], token_field: max_tokens, 'stream': False,
    }
    sends_temperature = setting('SEND_TEMPERATURE', '0') == '1'
    if sends_temperature:
        body['temperature'] = temperature
    data = json.dumps(body).encode()
    req = urllib.request.Request(url + '/chat/completions', data=data,
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Bearer ' + api_key}, method='POST')
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'Frontier API HTTP {e.code} (details suppressed to protect credentials)') from None
    except urllib.error.URLError:
        raise RuntimeError('Frontier API unreachable (connection error)') from None
    duration = round(time.monotonic() - start, 3)
    choices = result.get('choices') or []
    if not choices or not isinstance(choices[0].get('message', {}).get('content'), str):
        raise RuntimeError('Frontier API returned no plain-text completion')
    reason = choices[0].get('finish_reason')
    return {'output': choices[0]['message']['content'], 'finish_reason': reason,
            'truncated': reason in ('length', 'max_tokens'),
            'duration_seconds': duration, 'usage': result.get('usage') or {}}


def frozen_gold(source_alias: str, *, gold_dir: Path = GOLD_DIR) -> dict | None:
    """Read a per-source human gold set and snapshot it into each run for stable grading."""
    if not ALIAS_RE.fullmatch(source_alias):
        raise RuntimeError('Invalid source alias')
    path = gold_dir / f'{source_alias}.json'
    if not path.exists():
        return None
    gold = json.loads(path.read_text(encoding='utf8'))
    if gold.get('source_alias') != source_alias:
        raise RuntimeError('Gold set alias mismatch')
    criteria = gold.get('criteria', [])
    summary = gold.get('gold_summary', '')
    if not isinstance(summary, str) or (summary and not 200 <= len(summary.strip()) <= 20000):
        raise RuntimeError('Gold set has invalid reference summary')
    if not isinstance(criteria, list) or len(criteria) > 40 or not (criteria or summary) or any(
        not isinstance(c, dict) or not isinstance(c.get('id'), str)
        or not re.fullmatch(r'[A-Za-z0-9_-]{1,36}', c['id'])
        or not isinstance(c.get('expectation'), str)
        or not 8 <= len(c['expectation'].strip()) <= 500 for c in criteria
    ) or len({c['id'] for c in criteria}) != len(criteria):
        raise RuntimeError('Gold set has invalid criteria')
    note_alias = gold.get('gold_note_alias')
    if note_alias is not None and not (isinstance(note_alias, str) and
        re.fullmatch(r'memex-gold-[A-Za-z0-9._-]{1,100}', note_alias)):
        raise RuntimeError('Gold set has invalid HedgeDoc alias')
    if summary and gold.get('gold_summary_sha256') not in (None, hashlib.sha256(summary.encode('utf-8')).hexdigest()):
        raise RuntimeError('Gold summary content hash mismatch')
    return {'source_alias': source_alias, 'revision': gold.get('revision', ''),
            'gold_summary': summary, 'gold_note_alias': note_alias,
            'gold_summary_sha256': hashlib.sha256(summary.encode('utf-8')).hexdigest() if summary else None,
            'criteria': [{'id': c['id'], 'expectation': c['expectation']} for c in criteria]}


def invoke(url: str, model: str, source: str, instruction: str, seed: int,
           max_tokens: int, timeout: int, temperature: float) -> dict:
    data = json.dumps({
        'model': model, 'messages': [
            {'role': 'system', 'content': 'You are evaluating model comprehension. Base all claims only on the supplied document.'},
            {'role': 'user', 'content': f'{instruction}\n\n=== ORIGINAL SOURCE TEXT ===\n{source}\n=== END ==='},
        ], 'temperature': temperature, 'seed': seed, 'max_tokens': max_tokens,
        'stream': False, 'cache_prompt': False,
    }).encode()
    req = urllib.request.Request(url + '/chat/completions', data=data,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'llama.cpp HTTP {e.code}: {e.read(1000).decode(errors="replace")}') from e
    duration = round(time.monotonic() - start, 3)
    choices = result.get('choices') or []
    if not choices or not isinstance(choices[0].get('message', {}).get('content'), str):
        raise RuntimeError('Missing text in llama.cpp response')
    msg = choices[0]['message']['content']
    reason = choices[0].get('finish_reason')
    return {'output': msg, 'finish_reason': reason, 'truncated': reason in ('length', 'max_tokens'),
            'duration_seconds': duration, 'usage': result.get('usage') or {}}


def write_atomic(path: Path, content: str) -> None:
    temp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    temp.write_text(content, encoding='utf-8')
    os.replace(temp, path)


def read_catalogue(path: Path = SOURCE_INDEX) -> list[dict[str, str]]:
    """Read current canonical source aliases; never offer derived wiki notes."""
    catalogue: list[dict[str, str]] = []
    seen = set()
    inside = False
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip() == '## Sources':
            inside = True
            continue
        if inside and line.startswith('## '):
            break
        if not inside:
            continue
        m = re.match(r'^- \[(.+?)\]\(https?://[^/]+/n/([^/)?#]+)\)', line)
        if not m:
            continue
        title, alias = m.group(1), urllib.parse.unquote(m.group(2))
        if ALIAS_RE.fullmatch(alias) and not alias.startswith('memex-wiki-') and alias not in seen:
            catalogue.append({'alias': alias, 'title': title})
            seen.add(alias)
    return catalogue


def hedgedoc_token() -> str:
    token = os.environ.get('MEMEX_API_TOKEN', '').strip()
    if token:
        return token
    # HedgeDoc service does not necessarily export this terminal environment file.
    config = HERE.parents[2] / '.env.memex'  # project_root/.env.memex
    if not config.is_file():
        raise RuntimeError('HedgeDoc token not available (MEMEX_API_TOKEN or .env.memex)')
    for line in config.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^\s*(?:export\s+)?MEMEX_API_TOKEN\s*=\s*(.*?)\s*$', line)
        if m:
            return m.group(1).strip('"\' ')
    raise RuntimeError('MEMEX_API_TOKEN missing from .env.memex')


def source_text(raw: str) -> str:
    """Extract plain source passages (no JSON or document metadata dumped into model)."""
    if '"schema_name"' in raw and 'DoclingDocument' in raw:
        # Stored HedgeDoc notes wrap JSON in Markdown; look for the Docling object.
        decoder = json.JSONDecoder()
        for match in re.finditer(r'\{', raw):
            try:
                document, _ = decoder.raw_decode(raw[match.start():])
            except json.JSONDecodeError:
                continue
            if not isinstance(document, dict) or document.get('schema_name') != 'DoclingDocument':
                continue
            seen = set()
            passages = []
            for item in document.get('texts', []):
                if not isinstance(item, dict) or item.get('label') in ('page_header', 'page_footer'):
                    continue
                text = ' '.join(str(item.get('text') or '').split())
                if len(text) >= 15 and text not in seen:
                    passages.append(text)
                    seen.add(text)
            text = '\n\n'.join(passages)
            break
        else:
            raise RuntimeError('DoclingDocument JSON could not be decoded')
    else:
        text = re.sub(r'\A---\s*\n.*?\n---\s*\n', '', raw, count=1, flags=re.S).strip()
    if not (250 <= len(text) <= MAX_SOURCE_CHARS):
        raise RuntimeError(f'Source text length {len(text)} outside 250..{MAX_SOURCE_CHARS}; refusing truncated benchmark')
    return text


def fetch_hedgedoc_source(alias: str, token: str) -> str:
    if not ALIAS_RE.fullmatch(alias):
        raise RuntimeError('Invalid HedgeDoc source alias')
    url = HEDGEDOC_API + '/' + urllib.parse.quote(alias, safe='') + '/content'
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            if response.status != 200:
                raise RuntimeError(f'HedgeDoc GET returned HTTP {response.status}')
            raw = response.read(1_500_001)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'HedgeDoc source unavailable (HTTP {exc.code}): {alias}') from exc
    if len(raw) > 1_500_000:
        raise RuntimeError('Source note exceeds 1.5 MB safety limit')
    return source_text(raw.decode('utf-8'))


def select_sources(aliases: list[str], *, index: Path = SOURCE_INDEX, fetcher=None) -> list[dict]:
    if not aliases or len(aliases) > MAX_SOURCES or len(set(aliases)) != len(aliases):
        raise RuntimeError('Select one to three distinct HedgeDoc source notes')
    allowed = {row['alias']: row['title'] for row in read_catalogue(index)}
    if any(alias not in allowed for alias in aliases):
        raise RuntimeError('A chosen note is not a registered Memex source')
    token = None if fetcher else hedgedoc_token()
    entries = []
    for alias in aliases:
        content = (fetcher or fetch_hedgedoc_source)(alias, token)
        if not (250 <= len(content) <= MAX_SOURCE_CHARS):
            raise RuntimeError('Selected source does not meet size requirements')
        entries.append({'alias': alias, 'title': allowed[alias], 'text': content,
                        'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()})
    return entries


def markdown_report(run: dict, sources: list[dict]) -> str:
    lines = ['# Memex direct-model summary benchmark', '',
             f'- Run: `{run["id"]}`', f'- Models: `{run.get("providers", {})}`',
             '- Mode: direct llama.cpp; no queue, wiki, trail, citation or association writes.',
             '- Automated criteria are proxy checks; human factual review required.',
             '- Frontier provider receives original source text when selected; compare the matching run by source SHA-256.', '']
    for item in sources:
        lines += [f'## Original HedgeDoc source — {item["title"]}', '',
                  f'- Alias: `{item["alias"]}`; SHA-256: `{item["sha256"]}`',
                  '', '```text', item['text'], '```', '']
    if run.get('fixture') and WIKI_REFERENCE.exists():
        lines += ['## Existing Wiki output — static comparator', '',
                  WIKI_REFERENCE.read_text(encoding='utf-8'), '']
    for attempt in run['attempts']:
        lines += [f'## {attempt["source_title"]}: {attempt.get("model_role", "local")} {attempt["name"]} — {attempt["status"]}', '',
                  f'Seed: {attempt["seed"]}; elapsed: {attempt.get("duration_seconds", 0)}s; '
                  f'finish: {attempt.get("finish_reason", "n/a")}', '']
        if attempt.get('score'):
            s = attempt['score']
            if s['coverage_total']:
                lines += [f'Coverage keyword proxy: {s["coverage_proxy"]}/{s["coverage_total"]}', '',
                          'Missing proxy checks: ' + (', '.join(s['missing_proxy']) or '(none)'), '']
            else:
                lines += ['No source-specific accuracy rubric for this HedgeDoc; assess manually.', '']
        lines += [attempt.get('output', attempt.get('error', '')), '']
    lines += ['## Human assessment required', '',
              '- Compare each individual summary with its original source above.',
              '- Check omissions, invented assertions, conditions/exceptions and SHOULD vs MUST.',
              '- A/B/C consistency cannot establish factual accuracy.',
              '- Direct-model success combined with poor wiki output suggests processing/prompt constraints.', '']
    return '\n'.join(lines)


def execute(settings_path: Path, results_dir: Path, run_id: str, timeout: int,
            max_tokens: int, temperature: float, *, requester=None,
            aliases: list[str] | None = None, fetcher=None, index: Path = SOURCE_INDEX,
            roles: list[str] | None = None, gold_dir: Path = GOLD_DIR, frontier=None) -> dict:
    active = processor_pids()
    if active:
        raise RuntimeError('Memex queue processing is active; stop and wait before benchmarking: ' + '; '.join(active))
    base, model = validated_settings(settings_path)
    roles = ['local'] if roles is None else roles
    if not roles or len(set(roles)) != len(roles) or any(role not in ALLOWED_ROLES for role in roles):
        raise RuntimeError('Select local, frontier, or both model roles')
    providers = {'local': {'base': base, 'model': model}}
    if 'frontier' in roles:
        f_base, f_model, f_key = frontier if frontier is not None else frontier_configuration()
        providers['frontier'] = {'base': f_base, 'model': f_model, 'key': f_key}
    selected = bool(aliases)
    if selected:
        sources = select_sources(aliases or [], index=index, fetcher=fetcher)
    else:
        source = FIXTURE.read_text(encoding='utf-8').strip()
        if '14.4' not in source or '14.3' not in source:
            raise RuntimeError('Benchmark source fixture incomplete')
        sources = [{'alias': 'fixture-64-PAS-9980', 'title': '64_PAS_9980_FINAL — PAS 9980:2026 page 48',
                    'text': source, 'sha256': hashlib.sha256(source.encode('utf-8')).hexdigest()}]
    result = {'id': run_id, 'status': 'running',
              'started_at': datetime.now(timezone.utc).isoformat(),
              'model': model, 'llm_base_url': base,
              'providers': {role: {'model': providers[role]['model']} for role in roles},
              'roles': roles,
              'gold': {s['alias']: frozen_gold(s['alias'], gold_dir=gold_dir) for s in sources},
              'sources': [{k:v for k,v in s.items() if k != 'text'} for s in sources],
              'fixture': not selected,
              'temperature': temperature, 'max_tokens': max_tokens,
              'prompts': {'A': PROMPT_A, 'B_and_C': (PROMPT_B if not selected else PROMPT_B_GENERAL)},
              'attempts': []}
    if not selected:
        result['source_sha256'] = sources[0]['sha256']
        wiki_reference_text = WIKI_REFERENCE.read_text(encoding='utf-8') if WIKI_REFERENCE.exists() else ''
        result['wiki_reference_coverage_proxy'] = score(wiki_reference_text) if wiki_reference_text else None
    results_dir.mkdir(parents=True, exist_ok=True)
    json_path = results_dir / f'{run_id}.json'
    md_path = results_dir / f'{run_id}.md'
    write_atomic(json_path, json.dumps(result, indent=2))
    for source_index, item in enumerate(sources):
        # Identical original-source bytes and prompts across both providers, in one run.
        for role in roles:
            provider = providers[role]
            for name, instruction, seed in [('A-baseline', PROMPT_A, 100),
                                             ('B-complete', PROMPT_B_GENERAL if selected else PROMPT_B, 110),
                                             ('C-repeat-1', PROMPT_B_GENERAL if selected else PROMPT_B, 120),
                                             ('C-repeat-2', PROMPT_B_GENERAL if selected else PROMPT_B, 121),
                                             ('C-repeat-3', PROMPT_B_GENERAL if selected else PROMPT_B, 122)]:
                if processor_pids():
                    result['status'] = 'stopped-queue-became-active'
                    break
                print(f'RUN {item["alias"]} {role} {name}: direct model', flush=True)
                attempt = {'source_alias': item['alias'], 'source_title': item['title'],
                           'model_role': role, 'model': provider['model'],
                           'name': name, 'seed': seed + 1000 * source_index, 'status': 'running'}
                result['attempts'].append(attempt)
                write_atomic(json_path, json.dumps(result, indent=2))
                try:
                    if role == 'local':
                        r = (requester or invoke)(base, model, item['text'], instruction,
                                                  attempt['seed'], max_tokens, timeout, temperature)
                    else:
                        call = requester if requester is not None else invoke_frontier
                        if requester is not None:
                            # Test injection receives exactly the same args as local.
                            r = call(provider['base'], provider['model'], item['text'], instruction,
                                     attempt['seed'], max_tokens, timeout, temperature)
                        else:
                            r = call(provider['base'], provider['model'], item['text'], instruction,
                                     attempt['seed'], max_tokens, timeout, temperature, api_key=provider['key'])
                    attempt.update(r)
                    attempt['status'] = 'truncated' if r['truncated'] else 'completed'
                    attempt['score'] = score(r['output']) if not selected else {
                        'coverage_proxy': 0, 'coverage_total': 0, 'checks': {},
                        'alerts': ['Manual factual review required; no per-source automatic rubric'],
                        'missing_proxy': []}
                    print(f"RESULT {role} {name}: source={item['alias']} status={attempt['status']} "
                          f"finish={attempt['finish_reason']} time={attempt['duration_seconds']}s", flush=True)
                except Exception as exc:
                    attempt.update({'status': 'failed', 'error': str(exc)})
                    result['status'] = 'failed'
                    print(f'ERROR {role} {name}: {exc}', file=sys.stderr, flush=True)
                    break
                finally:
                    write_atomic(json_path, json.dumps(result, indent=2))
                    write_atomic(md_path, markdown_report(result, sources))
            if result['status'] != 'running':
                break
        if result['status'] != 'running':
            break
    if result['status'] == 'running':
        result['status'] = ('completed' if len(result['attempts']) == len(sources) * 5 * len(roles) and
                            all(x['status'] == 'completed' for x in result['attempts']) else 'incomplete')
    result['finished_at'] = datetime.now(timezone.utc).isoformat()
    write_atomic(json_path, json.dumps(result, indent=2))
    write_atomic(md_path, markdown_report(result, sources))
    return result

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', type=Path, default=DEFAULT_SETTINGS)
    parser.add_argument('--results-dir', type=Path, default=DEFAULT_RESULTS)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--max-tokens', type=int, default=2048)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--temperature', type=float, default=.35)
    parser.add_argument('--role', action='append', choices=ALLOWED_ROLES, default=[], help='local and/or frontier model')
    parser.add_argument('--alias', action='append', default=[], help='Registered HedgeDoc source alias; repeat up to three times')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9-]{8,80}', args.run_id):
        parser.error('Invalid run ID')
    if len(args.alias) > MAX_SOURCES or len(set(args.alias)) != len(args.alias):
        parser.error('Select at most three distinct HedgeDoc aliases')
    if not 256 <= args.max_tokens <= 4096 or not 30 <= args.timeout <= 1200 or not 0 <= args.temperature <= 1:
        parser.error('Invalid generation parameters')
    try:
        args.results_dir.mkdir(parents=True, exist_ok=True)
        with (args.results_dir / '.model-only.lock').open('a+') as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError('Another direct-model benchmark is already running') from exc
            run = execute(args.settings, args.results_dir, args.run_id,
                          args.timeout, args.max_tokens, args.temperature, aliases=args.alias, roles=args.role or ['local'])
    except Exception as exc:
        print('BENCHMARK ABORT: ' + str(exc), file=sys.stderr, flush=True)
        try:
            args.results_dir.mkdir(parents=True, exist_ok=True)
            path = args.results_dir / (args.run_id + '.json')
            if not path.exists():
                write_atomic(path, json.dumps({'id': args.run_id, 'status': 'failed',
                                               'error': str(exc), 'attempts': []}, indent=2))
        except OSError:
            pass
        return 1
    print(f"BENCHMARK {run['status']}: {args.results_dir / (args.run_id + '.md')}", flush=True)
    return 0 if run['status'] == 'completed' else 2


if __name__ == '__main__':
    sys.exit(main())
