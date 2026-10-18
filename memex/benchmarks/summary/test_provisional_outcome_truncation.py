"""Offline regression tests for 4096-token guard / batched fallback."""
import json
import unittest
import provisional_outcome_evaluator as ev

SOURCE = ('Clause 14 says the report should inform the fire risk assessment. '
          'The report is not a certificate of building regulation compliance. '
          'The appraiser should include the building address.')
SUMMARY = ('The report should inform the fire risk assessment. '
           'The report certifies building regulations compliance.')
GOLD = [
 {'id':'14-1','expectation':'The report informs the FRA'},
 {'id':'14-2','expectation':'It does not certify compliance'},
 {'id':'14-4c','expectation':'Appraiser includes building address'},
]
CLAIMS = [
 {'id':'c1','text':'The report should inform the fire risk assessment','summary_quote':'The report should inform the fire risk assessment.'},
 {'id':'c2','text':'The report certifies building regulations compliance','summary_quote':'The report certifies building regulations compliance.'},
]

class BatchingTests(unittest.TestCase):
    def test_judge_falls_back_and_preserves_complete_decisions(self):
        calls=[]
        def invoke(sys_prompt, user):
            calls.append(sys_prompt)
            if 'For EVERY claim' in sys_prompt:
                raise ev.OutputTruncated('finish_reason=length')
            batch=json.loads(user)
            if 'candidate_claims' in batch and 'frozen_gold_facts' not in batch:
                ids={c['id'] for c in batch['candidate_claims']}
                decisions={
                  'c1': {'id':'c1','verdict':'supported','source_quote':'report should inform the fire risk assessment','reason':'source'},
                  'c2': {'id':'c2','verdict':'contradicted','source_quote':'not a certificate of building regulation compliance','reason':'source'}
                }
                return {'claim_decisions':[decisions[k] for k in ids]}
            ids={f['id'] for f in batch['frozen_gold_facts']}
            decisions={
               '14-1':{'id':'14-1','verdict':'covered','matched_claim_ids':['c1'],'summary_quote':'report should inform the fire risk assessment','reason':'covered'},
               '14-2':{'id':'14-2','verdict':'incorrect','matched_claim_ids':[],'summary_quote':'','reason':'reversed'},
               '14-4c':{'id':'14-4c','verdict':'missing','matched_claim_ids':[],'summary_quote':'','reason':'missing'}
            }
            return {'fact_decisions':[decisions[k] for k in ids]}
        x=ev.judge(SOURCE,SUMMARY,GOLD,CLAIMS,invoke)
        self.assertEqual(x['grades'],{'14-1':'covered','14-2':'incorrect','14-4c':'missing'})
        self.assertEqual(x['uncertain'],0)
        self.assertEqual(ev.provisional_scores(x)['status'],'provisional')
        self.assertEqual(len(calls),3)

    def test_batched_judge_refuses_missing_decision(self):
        def invoke(sys_prompt, user):
            if 'For EVERY claim' in sys_prompt:
                raise ev.OutputTruncated('length')
            return {'claim_decisions':[]}
        with self.assertRaisesRegex(ValueError,'Incomplete or duplicate'):
            ev.judge(SOURCE,SUMMARY,GOLD,CLAIMS,invoke)

    def test_single_batched_item_remains_truncated_and_fails_safely(self):
        def invoke(*args):
            raise ev.OutputTruncated('length')
        with self.assertRaisesRegex(ValueError,'Single-item judge output truncated'):
            ev.judge(SOURCE,SUMMARY,GOLD,CLAIMS[:1],invoke)

    def test_extraction_truncation_chunks_without_clipping(self):
        a='The report should explain that it informs the building fire risk assessment. '
        b='The report should never certify compliance with building regulations. '
        summary=('## Intro\n\n'+a*12+'\n\n'+'## Limitations\n\n'+b*12)
        self.assertGreater(len(summary),1200)
        calls=[]
        def invoke(system,user):
            calls.append(user)
            if len(calls)==1:
                raise ev.OutputTruncated('length')
            chunk=user.split('=== UNTRUSTED CANDIDATE SUMMARY ===\n',1)[1].rsplit('\n=== END ===',1)[0]
            phrase=a.strip() if a.strip() in chunk else b.strip()
            return {'claims':[{'id':'c1','text':phrase,'summary_quote':phrase}]}
        result=ev.extract(summary,invoke)
        self.assertEqual(len(result),2)
        self.assertEqual([r['id'] for r in result],['c1','c2'])
        self.assertTrue(all(ev.exact_excerpt(r['summary_quote'],summary) for r in result))

if __name__=='__main__': unittest.main()
