#!/usr/bin/env python3
"""Create the curated PAS 9980 Gold HedgeDoc note once via its documented Markdown API.

Never overwrites an existing note and never writes to Memex queue, wiki or index.
"""
from __future__ import annotations
from pathlib import Path
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = Path('/data/projects/hedgedoc')
ALIAS = 'memex-gold-summary-pas9980-clause14-page48'
API = 'http://127.0.0.1:3100/api/v2/notes/' + ALIAS
NOTE = Path(__file__).with_name('pas9980-clause14-gold-note.md')

def token_from_env(path: Path) -> str:
    token = os.environ.get('MEMEX_API_TOKEN', '').strip()
    if token: return token
    for line in path.read_text(encoding='utf-8').splitlines():
        match = re.match(r'^\s*(?:export\s+)?MEMEX_API_TOKEN\s*=\s*(.*?)\s*$', line)
        if match: return match.group(1).strip('"\' ')
    raise RuntimeError('MEMEX_API_TOKEN missing from .env.memex')

def main() -> int:
    content = NOTE.read_text(encoding='utf-8')
    if not (content.startswith('---\ntype: document\nokf_type: Concept\n') and '\nstatus: draft\n' in content):
        raise RuntimeError('Gold note does not match the requested document YAML template')
    token = token_from_env(ROOT / '.env.memex')
    headers = {'Authorization': 'Bearer ' + token}
    # Preflight: creation only, never edit or replace an existing note.
    req = urllib.request.Request(API + '/content', headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            if response.status == 200:
                print(f'EXISTS: {ALIAS} — existing content preserved')
                print(f'LINK: http://192.168.1.142:8180/n/{ALIAS}')
                return 0
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise RuntimeError(f'Cannot verify note nonexistence: HedgeDoc HTTP {e.code}') from e
    req = urllib.request.Request(API, data=content.encode('utf-8'),
                                 headers={**headers, 'Content-Type': 'text/markdown'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            if response.status not in (200, 201):
                raise RuntimeError(f'Unexpected HedgeDoc create response HTTP {response.status}')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'HedgeDoc Gold note creation failed HTTP {e.code} (no overwrite attempted)') from e
    print(f'CREATED: {ALIAS}')
    print(f'LINK: http://192.168.1.142:8180/n/{ALIAS}')
    print('NEXT: verify this synthesized draft against the source, then import in Gold Review and Save Gold Set.')
    return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        print(f'STOP: {e}', file=sys.stderr)
        sys.exit(1)
