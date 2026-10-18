"""Offline tests: same source/prompts local vs frontier and human gold frozen per run."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('model_summary_pair', HERE / 'model_summary_benchmark.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class PairedTest(TestCase):
    def test_secure_frontier_config_validation(self):
        with self.assertRaisesRegex(RuntimeError, 'not configured'):
            m.frontier_configuration(Path('/non-existent-benchmark-configuration'), {})
        with self.assertRaisesRegex(RuntimeError, 'not configured'):
            m.frontier_configuration(Path('/non-existent-benchmark-configuration'), {
                'MEMEX_BENCH_FRONTIER_BASE_URL': 'http://127.0.0.1:8080/v1',
                'MEMEX_BENCH_FRONTIER_MODEL': 'frontier',
                'MEMEX_BENCH_FRONTIER_API_KEY': 'secret'})
        with TemporaryDirectory() as tmp:
            config = Path(tmp) / '.env.memex-benchmark'
            config.write_text('MEMEX_BENCH_FRONTIER_BASE_URL=https://api.openai.com/v1\n'
                              'MEMEX_BENCH_FRONTIER_MODEL=test-frontier\n'
                              'MEMEX_BENCH_FRONTIER_API_KEY=dummy-key\n')
            self.assertEqual(m.frontier_configuration(config, {})[1], 'test-frontier')

    def test_gold_snapshot_and_paired_model_outputs(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            index = root / 'index.md'
            index.write_text('## Sources\n- [One](http://x/n/docling-one)\n## Other\n')
            gold = root / 'gold'
            gold.mkdir()
            (gold / 'docling-one.json').write_text(json.dumps({
                'source_alias': 'docling-one', 'revision': 'gold-one',
                'criteria': [{'id': 'f1', 'expectation': 'One complete fact about the chosen source.'}]}))
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'provider': 'llamacpp',
                'baseUrl': 'http://192.168.1.99:8080/v1', 'defaultModel': 'Gemma4'}))
            calls = []
            def mock_requester(base, model, source, instruction, seed, mx, timeout, temp):
                calls.append((base, model, source, instruction, seed, mx, temp))
                return {'output': f'Complete for {model}', 'finish_reason': 'stop',
                        'truncated': False, 'duration_seconds': .01, 'usage': {}}
            with patch.object(m, 'processor_pids', return_value=[]):
                report = m.execute(settings, root / 'results', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
                                   60, 2048, .35, requester=mock_requester,
                                   aliases=['docling-one'], index=index,
                                   fetcher=lambda alias, token: ('Immutable source details. ' * 30),
                                   roles=['local', 'frontier'], gold_dir=gold,
                                   frontier=('https://api.openai.com/v1', 'frontier', 'unused-secret'))
            self.assertEqual(report['status'], 'completed')
            self.assertEqual(len(calls), 10)
            self.assertEqual(len({c[2] for c in calls}), 1)
            self.assertEqual([c[3] for c in calls[:5]], [c[3] for c in calls[5:]])
            self.assertEqual({r['model_role'] for r in report['attempts']}, {'local', 'frontier'})
            self.assertNotIn('unused-secret', json.dumps(report))
            self.assertEqual(report['gold']['docling-one']['revision'], 'gold-one')
            (gold / 'docling-one.json').write_text('{}')
            self.assertEqual(json.loads((root / 'results' / (report['id'] + '.json')).read_text())['gold']['docling-one']['revision'], 'gold-one')
            self.assertEqual(report['sources'][0]['sha256'], report['sources'][0]['sha256'])

    def test_gold_rejects_invalid_criteria(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            (root / 'docling-one.json').write_text(json.dumps({'source_alias': 'docling-one',
                'criteria': [{'id': 'a', 'expectation': 'short'}]}))
            with self.assertRaisesRegex(RuntimeError, 'invalid criteria'):
                m.frozen_gold('docling-one', gold_dir=root)

if __name__ == '__main__':
    main()
