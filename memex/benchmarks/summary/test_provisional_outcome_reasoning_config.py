"""Judge's llama.cpp request disables thinking without changing server settings."""
import io
import json
import unittest
from unittest import mock

import provisional_outcome_evaluator as evaluator


class JudgeRequestTests(unittest.TestCase):
    def call(self, *, finish_reason='stop', content='{"claims":[]}'):
        sent = {}

        def fake_urlopen(req, timeout):
            sent['url'] = req.full_url
            sent['timeout'] = timeout
            sent['payload'] = json.loads(req.data)
            body = {'choices': [{'finish_reason': finish_reason,
                                 'message': {'content': content}}]}
            return io.BytesIO(json.dumps(body).encode('utf-8'))

        with mock.patch.object(evaluator.urlrequest, 'urlopen', fake_urlopen):
            if finish_reason == 'length':
                with self.assertRaises(evaluator.OutputTruncated):
                    evaluator.model_json('http://127.0.0.1:8080/v1', 'gemma4:26b', 'rules', 'data')
                return sent
            result = evaluator.model_json('http://127.0.0.1:8080/v1', 'gemma4:26b', 'rules', 'data')
            self.assertEqual(result, {'claims': []})
        return sent

    def test_thinking_disabled_only_for_request(self):
        sent = self.call()
        body = sent['payload']
        self.assertEqual(body['reasoning_effort'], 'none')
        self.assertEqual(body['chat_template_kwargs'], {'enable_thinking': False})
        self.assertEqual(body['response_format'], {'type': 'json_object'})
        self.assertEqual(body['max_tokens'], 4096)
        self.assertFalse(body['stream'])
        self.assertEqual(body['messages'][1]['content'], 'data')
        self.assertEqual(sent['url'], 'http://127.0.0.1:8080/v1/chat/completions')

    def test_truncation_still_refused(self):
        self.assertEqual(self.call(finish_reason='length')['payload']['reasoning_effort'], 'none')

    def test_malformed_json_still_refused(self):
        with self.assertRaises(json.JSONDecodeError):
            self.call(content='{"claims":')


if __name__ == '__main__':
    unittest.main()
