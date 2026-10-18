"""Offline contracts: document-level reference summary, frozen gold, safe note creation."""
from __future__ import annotations
import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import urllib.error

BASE = Path(__file__).resolve().parent

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    instance = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(instance)
    return instance

class GoldSummaryAlias(unittest.TestCase):
    def test_human_gold_summary_without_atomic_fact_rows_is_valid(self):
        m = module('gold_summary_benchmark', BASE / 'model_summary_benchmark.py')
        with TemporaryDirectory() as folder:
            root = Path(folder)
            summary = '# Gold Reference Summary\n\n' + 'Full synthesized source coverage. ' * 15
            (root / 'fixture-64-PAS-9980.json').write_text(json.dumps({
                'source_alias': 'fixture-64-PAS-9980', 'revision': 'human-1',
                'gold_note_alias': 'memex-gold-summary-pas9980-clause14-page48',
                'gold_summary': summary,
                'gold_summary_sha256': hashlib.sha256(summary.encode()).hexdigest(),
                'criteria': [],
            }))
            gold = m.frozen_gold('fixture-64-PAS-9980', gold_dir=root)
            self.assertEqual(gold['gold_summary'], summary)
            self.assertEqual(gold['criteria'], [])
            self.assertEqual(gold['gold_note_alias'], 'memex-gold-summary-pas9980-clause14-page48')

    def test_content_hash_tampering_is_rejected(self):
        m = module('gold_summary_benchmark2', BASE / 'model_summary_benchmark.py')
        with TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'fixture-64-PAS-9980.json').write_text(json.dumps({
                'source_alias': 'fixture-64-PAS-9980', 'revision': 'human-1',
                'gold_summary': 'Complete synthesized document. ' * 15,
                'gold_summary_sha256': '0' * 64,
                'criteria': [],
            }))
            with self.assertRaisesRegex(RuntimeError, 'hash mismatch'):
                m.frozen_gold('fixture-64-PAS-9980', gold_dir=root)

    def test_curated_note_uses_standard_yaml_and_is_not_source_json(self):
        note = (BASE / 'pas9980-clause14-gold-note.md').read_text()
        self.assertTrue(note.startswith('---\ntype: document\nokf_type: Concept\n'))
        for line in ('tags: []', 'status: draft', 'sources: []', '# Gold Reference Summary'):
            self.assertIn(line, note)
        self.assertNotIn('"schema_name": "DoclingDocument"', note)
        self.assertIn('should', note)

    def test_note_creation_refuses_to_overwrite_existing(self):
        m = module('gold_note_create', BASE / 'create_pas9980_gold_note.py')
        class Found:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
        with patch.object(m, 'token_from_env', return_value='hidden'), patch.object(m.urllib.request, 'urlopen', return_value=Found()) as call:
            self.assertEqual(m.main(), 0)
            self.assertEqual(call.call_count, 1)
            self.assertIsNone(call.call_args[0][0].data)

    def test_create_uses_markdown_and_does_not_put_token_in_url(self):
        m = module('gold_note_create2', BASE / 'create_pas9980_gold_note.py')
        class Made:
            status = 201
            def __enter__(self): return self
            def __exit__(self, *args): return False
        def side_effect(req, **kwargs):
            if req.data is None:
                raise urllib.error.HTTPError(req.full_url, 404, 'not found', {}, None)
            self.assertEqual(req.get_method(), 'POST')
            self.assertEqual(req.headers['Authorization'], 'Bearer hidden')
            self.assertTrue(req.headers['Content-type'].startswith('text/markdown'))
            self.assertNotIn('hidden', req.full_url)
            return Made()
        with patch.object(m, 'token_from_env', return_value='hidden'), patch.object(m.urllib.request, 'urlopen', side_effect=side_effect) as call:
            self.assertEqual(m.main(), 0)
            self.assertEqual(call.call_count, 2)

if __name__ == '__main__': unittest.main()
