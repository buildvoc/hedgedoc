#!/usr/bin/env python3
"""Isolated offline checks: no llama.cpp calls, no real queue/wiki writes."""
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('model_benchmark', HERE / 'model_summary_benchmark.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

COMPLETE_TEXT = '''Reports need no prescribed template. They are factual and inherently low risk.
The report informs the building FRA. It does not confirm compliance with building regulations.
If Figure 1 shows low risk, the signatories' competence must be stated.
The appraiser and organization, report date and inspection date, building address,
building use and dimensions and age, explanation of low risk, and dutyholder statutory duties should be listed.'''

class TestBenchmark(unittest.TestCase):
    def test_fixture_is_exact_original(self):
        text = m.FIXTURE.read_text()
        for item in ('14.1', '14.2', '14.3', '14.4', 'a)', 'h)', 'should'):
            self.assertIn(item, text)
        self.assertNotIn('memex-source-pages', text)

    def test_rule_count_and_false_positive_warning(self):
        result = m.score(COMPLETE_TEXT)
        self.assertEqual(result['coverage_total'], 14)
        self.assertTrue(result['checks']['14.1-informs-FRA'])
        self.assertTrue(result['checks']['14.3-Figure-1-condition'])
        self.assertTrue(result['checks']['14.4b-report-and-inspection-dates'])
        self.assertGreater(result['coverage_proxy'], 10)

    def test_omitted_condition_detected_as_proxy_only(self):
        result = m.score('The report describes external walls and includes an appraisal.')
        self.assertIn('14.3-Figure-1-condition', result['missing_proxy'])
        self.assertIn('14.4h-statutory-dutyholder-info', result['missing_proxy'])

    def test_settings_reject_arbitrary_endpoint(self):
        with TemporaryDirectory() as d:
            f = Path(d) / 'settings.json'
            f.write_text(json.dumps({'provider': 'llamacpp', 'baseUrl': 'https://evil.invalid/v1', 'defaultModel': 'x'}))
            with self.assertRaisesRegex(RuntimeError, 'Unexpected llama.cpp URL'):
                m.validated_settings(f)

    def test_five_independent_model_calls_save_outputs(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'provider': 'llamacpp',
                'baseUrl': 'http://192.168.1.99:8080/v1', 'defaultModel': 'Gemma4-test'}))
            arguments = []
            def stub(base, model, source, prompt, seed, maximum, timeout, temperature):
                arguments.append((prompt, seed, source, base, model))
                return {'output': COMPLETE_TEXT, 'finish_reason': 'stop', 'truncated': False,
                        'duration_seconds': 0.1, 'usage': {'total_tokens': 123}}
            with patch.object(m, 'processor_pids', return_value=[]):
                outcome = m.execute(settings, root / 'results', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                                    60, 2048, .35, requester=stub)
            self.assertEqual(outcome['status'], 'completed')
            self.assertEqual(len(outcome['attempts']), 5)
            self.assertEqual(len(arguments), 5)
            self.assertEqual(arguments[0][0], m.PROMPT_A)
            self.assertTrue(all(x[0] == m.PROMPT_B for x in arguments[1:]))
            self.assertEqual(len({x[1] for x in arguments}), 5)
            self.assertTrue((root / 'results' / 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md').exists())
            self.assertEqual(json.loads((root / 'results' / 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json').read_text())['status'], 'completed')

    def test_processing_guard_aborts_without_writes(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            settings = root / 'settings.json'
            settings.write_text('{}')
            with patch.object(m, 'processor_pids', return_value=['123 python3 -u memex/process_queue_batch.py']):
                with self.assertRaisesRegex(RuntimeError, 'processing is active'):
                    m.execute(settings, root / 'results', 'aaaa-bbbb', 60, 2048, 0.35)
            self.assertFalse((root / 'results').exists())

    def test_truncation_retained_and_not_marked_complete(self):
        with TemporaryDirectory() as d:
            root = Path(d)
            settings = root / 'settings.json'
            settings.write_text(json.dumps({'provider':'llamacpp', 'baseUrl':'http://192.168.1.99:8080/v1','defaultModel':'x'}))
            def truncated(*args):
                return {'output': 'Incomplete', 'finish_reason': 'length', 'truncated': True,
                        'duration_seconds': .1, 'usage': {}}
            with patch.object(m, 'processor_pids', return_value=[]):
                outcome = m.execute(settings, root / 'results', 'aaa', 60, 2048, .35, requester=truncated)
            self.assertEqual(outcome['status'], 'incomplete')

if __name__ == '__main__':
    unittest.main(verbosity=2)
