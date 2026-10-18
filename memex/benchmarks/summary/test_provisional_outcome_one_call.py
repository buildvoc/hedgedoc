"""One-call judge tests: no network, no writable project files."""
import json
import unittest
import provisional_outcome_evaluator as ev

SOURCE=('Clause 14 says the report should inform the fire risk assessment. '
        'The report is not a certificate of building regulation compliance. '
        'The appraiser should include the building address.')
SUMMARY=('The report should inform the fire risk assessment. '
         'The report certifies building regulations compliance.')
GOLD=[{'id':'14-1','expectation':'FRA informed'},
      {'id':'14-2','expectation':'Not regulations compliance'},
      {'id':'14-4c','expectation':'Include address'}]

class OneCallTests(unittest.TestCase):
    def fixtures(self):
        units=ev.numbered_summary_units(SUMMARY)
        self.assertEqual(len(units),2)
        return {'units':[
            {'id':'s1','items':[{'text':'The report should inform the fire risk assessment',
              'verdict':'supported','source_id':'p1'}]},
            {'id':'s2','items':[{'text':'The report certifies building regulations compliance',
              'verdict':'contradicted','source_id':'p1'}]}],
            'facts':[{'id':'14-1','verdict':'covered','matches':['s1.1']},
                     {'id':'14-2','verdict':'incorrect','matches':['s2.1']},
                     {'id':'14-4c','verdict':'missing','matches':[]}]}
    def test_one_and_only_one_provider_request(self):
        calls=[]; result=self.fixtures()
        def invoke(system, user):
            calls.append(json.loads(user))
            return result
        answer=ev.judge_once(SOURCE,SUMMARY,GOLD,invoke)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]['summary_units'][1]['text'],
                         'The report certifies building regulations compliance.')
        self.assertEqual(answer['grades'],{'14-1':'covered','14-2':'incorrect','14-4c':'missing'})
        self.assertEqual(answer['request_count'],1)
        self.assertEqual(answer['claims'][0]['matched_fact_ids'],['14-1'])
        self.assertEqual(answer['claims'][0]['evidence'],SOURCE)
        scored=ev.provisional_scores(answer)
        self.assertAlmostEqual(scored['precision'],0.5)
        self.assertAlmostEqual(scored['recall'],1/3)
    def test_generated_quotes_not_required(self):
        r=self.fixtures(); r['units'][0]['items'][0]['summary_quote']='invented model quote'
        got=ev.judge_once(SOURCE,SUMMARY,GOLD,lambda s,u:r)
        self.assertEqual(got['grades']['14-1'],'covered')
        self.assertEqual(got['claims'][0]['evidence'],SOURCE)
    def test_missing_unit_fails_no_second_call(self):
        r=self.fixtures(); r['units'].pop()
        calls=[]
        def run(s,u): calls.append(1); return r
        with self.assertRaisesRegex(ValueError,'omitted or duplicated'):
            ev.judge_once(SOURCE,SUMMARY,GOLD,run)
        self.assertEqual(len(calls),1)
    def test_invalid_source_id_never_supported(self):
        r=self.fixtures(); r['units'][0]['items'][0]['source_id']='p999'
        got=ev.judge_once(SOURCE,SUMMARY,GOLD,lambda s,u:r)
        self.assertEqual(got['claims'][0]['verdict'],'uncertain')
        self.assertEqual(got['grades']['14-1'],'unrated')
        self.assertEqual(ev.provisional_scores(got)['status'],'incomplete')
    def test_missing_fact_fails(self):
        r=self.fixtures(); r['facts'].pop()
        with self.assertRaisesRegex(ValueError,'omitted or duplicated'):
            ev.judge_once(SOURCE,SUMMARY,GOLD,lambda s,u:r)
    def test_unknown_claim_match_fails(self):
        r=self.fixtures(); r['facts'][0]['matches']=['s99.1']
        with self.assertRaisesRegex(ValueError,'unknown/duplicate'):
            ev.judge_once(SOURCE,SUMMARY,GOLD,lambda s,u:r)
    def test_empty_claim_inventory_fails(self):
        r=self.fixtures()
        for u in r['units']: u['items']=[]
        with self.assertRaisesRegex(ValueError,'No candidate factual claims'):
            ev.judge_once(SOURCE,SUMMARY,GOLD,lambda s,u:r)
    def test_long_source_not_clipped_or_called(self):
        def fail(*x): self.fail('should not call LLM')
        with self.assertRaisesRegex(ValueError,'no text clipped'):
            ev.judge_once(SOURCE*200,SUMMARY,GOLD,fail)
    def test_truncated_response_no_retry(self):
        calls=[]
        def invoke(s,u):
            calls.append(1)
            raise ev.OutputTruncated('length')
        with self.assertRaises(ev.OutputTruncated):
            ev.judge_once(SOURCE,SUMMARY,GOLD,invoke)
        self.assertEqual(len(calls),1)
    def test_source_passages_reference_exact_source(self):
        passages=ev.numbered_passages(SOURCE)
        self.assertEqual(' '.join(p['text'] for p in passages),SOURCE)
    def test_unit_nonliteral_text_marked_uncertain(self):
        r=self.fixtures(); r['units'][0]['items'][0]['text']='Unrelated galaxies and meteorites'
        got=ev.judge_once(SOURCE,SUMMARY,GOLD,lambda s,u:r)
        self.assertEqual(got['grades']['14-1'],'unrated')

if __name__=='__main__': unittest.main()
