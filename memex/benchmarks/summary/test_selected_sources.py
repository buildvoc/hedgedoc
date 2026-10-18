#!/usr/bin/env python3
"""Isolated selected-source benchmark checks; no live HedgeDoc or llama.cpp."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('summary_model', HERE / 'model_summary_benchmark.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class TestSelectedSources(TestCase):
    def test_manifest_allows_only_source_notes(self):
        with TemporaryDirectory() as tmp:
            index = Path(tmp) / 'index.md'
            index.write_text('''# Memex Index
## Sources
- [PAS 64](http://192.168.1.142:8180/n/docling-batch-one) — example
- [Bramshott](http://192.168.1.142:8180/n/docling-batch-two) — example
- [Bad](http://192.168.1.142:8180/n/memex-wiki-source-summary-bad)
## Trails
- [Other](http://192.168.1.142:8180/n/unrelated)
''')
            rows = m.read_catalogue(index)
            self.assertEqual([r['alias'] for r in rows], ['docling-batch-one', 'docling-batch-two'])
            with self.assertRaisesRegex(RuntimeError, 'registered Memex source'):
                m.select_sources(['memex-wiki-source-summary-bad'], index=index, fetcher=lambda *_: 'x'*300)
            with self.assertRaisesRegex(RuntimeError, 'one to three'):
                m.select_sources(['docling-batch-one']*2, index=index, fetcher=lambda *_:'x'*300)

    def test_docling_text_extraction_and_size_limit(self):
        raw = '---\ntitle: Source\n---\n# Docling\n' + json.dumps({
            'schema_name':'DoclingDocument', 'texts':[
                {'text':'Page 1 content on report 14.1 should be available.', 'label':'text'},
                {'text':'Page 1 content on report 14.1 should be available.', 'label':'text'},
                {'text':'Page number 48', 'label':'page_footer'},
                {'text':'Clause 14.2 specifies that a report should not claim building-regulation compliance.', 'label':'text'},
                {'text':'\n'.join(['Clause 14.3 is conditional on Figure 1.']*8), 'label':'text'},
            ]})
        text = m.source_text(raw)
        self.assertIn('14.2', text)
        self.assertNotIn('Page number 48', text)
        self.assertEqual(text.count('Page 1 content'), 1)
        with self.assertRaisesRegex(RuntimeError, 'refusing truncated benchmark'):
            m.source_text('A' * (m.MAX_SOURCE_CHARS+1))

    def test_two_notes_generate_ten_direct_calls_without_wiki(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'index.md').write_text('''## Sources
- [Source A](http://x/n/docling-source-a)
- [Source B](http://x/n/docling-source-b)
## End
''')
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'provider':'llamacpp','baseUrl':'http://192.168.1.99:8080/v1','defaultModel':'mock-gemma4'}))
            calls = []
            def requester(base, model, source, instruction, seed, max_tokens, timeout, temperature):
                calls.append((source, instruction, seed))
                return {'output': 'A meaningful thematic summary from the original evidence.',
                        'finish_reason':'stop','truncated':False,'duration_seconds':.01,'usage':{}}
            with patch.object(m, 'processor_pids', return_value=[]):
                result = m.execute(settings, root / 'results', '7c142903-8b5b-4bc2-910d-a65fefcafdf5',
                                   60, 2048, .35, requester=requester,
                                   aliases=['docling-source-a','docling-source-b'], index=root/'index.md',
                                   fetcher=lambda alias, token: 'Original passage for ' + alias + ' ' * 300)
            self.assertEqual(len(calls), 10)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(len(result['sources']), 2)
            self.assertTrue(result['sources'][0]['sha256'])
            self.assertEqual({x['source_alias'] for x in result['attempts']}, {'docling-source-a','docling-source-b'})
            self.assertEqual(result['attempts'][0]['score']['coverage_total'], 0)
            self.assertEqual(result['attempts'][5]['name'], 'A-baseline')
            self.assertTrue((root / 'results' / (result['id'] + '.md')).exists())


if __name__ == '__main__':
    main(verbosity=2)
