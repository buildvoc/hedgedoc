"""Adaptive claim extraction: source preservation and strict fail-closed behavior."""
import unittest
import provisional_outcome_evaluator as ev

SUMMARY = ('The report is factual and should explain why risk is inherently low. '
           'It should inform the fire risk assessment and must not claim compliance. '
           'The building address and inspection dates should be included. ') * 7

class AdaptiveTests(unittest.TestCase):
    def test_partition_reassembles_exact_input(self):
        for chunk in [SUMMARY[:1100], 'A' * 230 + ' ' + 'B' * 240]:
            a,b=ev.split_failed_extract_chunk(chunk)
            self.assertEqual(a+b,chunk)
            self.assertTrue(a.strip() and b.strip())

    def test_truncation_retries_smaller_and_checks_provenance(self):
        calls=[]
        def invoke(system,user):
            chunk=user.split('=== UNTRUSTED CANDIDATE SUMMARY ===\n',1)[1].rsplit('\n=== END ===',1)[0]
            calls.append(chunk)
            if len(chunk)>300:
                raise ev.OutputTruncated('length')
            quote='The report is factual and should explain why risk is inherently low.'
            if quote in chunk:
                return {'claims':[{'id':'c1','text':quote,'summary_quote':quote}]}
            return {'claims':[]}
        result=ev.extract(SUMMARY,invoke)
        self.assertGreater(len(calls),4)
        self.assertEqual(result[0]['id'],'c1')
        self.assertEqual(len(result),1)
        self.assertTrue(all(ev.exact_excerpt(row['summary_quote'],SUMMARY) for row in result))

    def test_minimum_chunk_truncation_is_explicit_failure(self):
        def always_truncate(s,u):
            raise ev.OutputTruncated('length')
        with self.assertRaisesRegex(ValueError, 'Claim extraction still truncates'):
            ev.extract(SUMMARY,always_truncate)

    def test_provenance_against_input_chunk_not_other_part(self):
        quote='The report is factual and should explain why risk is inherently low.'
        def invoke(s,u):
            return {'claims':[{'id':'c1','text':quote,'summary_quote':quote}]}
        other='This separate passage has unrelated content and contains no matching quote at all.'
        with self.assertRaisesRegex(ValueError,'evidence not found in its input chunk'):
            ev.extract_chunk_adaptively(other,'test prompt',invoke)

    def test_non_truncated_invalid_json_cannot_be_silently_skipped(self):
        with self.assertRaisesRegex(ValueError,'Invalid/empty/truncated claim inventory'):
            ev.extract(SUMMARY,lambda s,u:{'claims':[]})

if __name__=='__main__': unittest.main()
