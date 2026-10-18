"""Source-grounded single-call Gold outcome tests. No live network."""
import json
import unittest
import provisional_outcome_evaluator as ev

SOURCE = ('14.1 Report should inform the building fire risk assessment. '\
          '14.2 Report should not declare compliance with building regulations. '\
          '14.3 The appraiser statement of competence is conditional.')
SUMMARY = ('The report should inform the fire risk assessment.\n'
           'The report confirms building regulations compliance.')
FACTS = [
    {'id': '14-1', 'expectation': 'Report should inform FRA'},
    {'id': '14-2', 'expectation': 'Should not state building regs compliance'},
    {'id': '14-3', 'expectation': 'Conditional competence statement'},
]

def sample():
    return {'decisions':[
        {'id':'14-1','verdict':'covered','summary_ids':['s1'],'source_id':'p1','reason':'FRA stated'},
        {'id':'14-2','verdict':'incorrect','summary_ids':['s2'],'source_id':'p1','reason':'Compliance claim reverses requirement'},
        {'id':'14-3','verdict':'missing','summary_ids':[],'source_id':None,'reason':'No competence'},
    ], 'unsupported_ids':[]}

class DirectGoldVerdicts(unittest.TestCase):
    def test_one_call_complete_outcomes_and_real_summary_spans(self):
        calls=[]
        def fake(s,u): calls.append(json.loads(u)); return sample()
        result=ev.judge_direct_once(SOURCE,SUMMARY,FACTS,fake)
        self.assertEqual(len(calls),1)
        self.assertEqual(result['request_count'],1)
        self.assertEqual(result['grades'],{'14-1':'covered','14-2':'incorrect','14-3':'missing'})
        self.assertEqual(result['claims'][0]['text'], ev.numbered_summary_units(SUMMARY)[0]['text'])
        self.assertEqual(result['claims'][0]['matched_fact_ids'],['14-1'])
        self.assertEqual(result['scores']['status'],'incomplete')
        self.assertIsNone(result['scores']['precision'])
        self.assertIsNone(result['scores']['f1_style'])
        self.assertAlmostEqual(result['scores']['recall'],1/3)

    def test_invalid_summary_reference_fails_closed_without_another_call(self):
        calls=[]; data=sample(); data['decisions'][0]['summary_ids']=['s999']
        def fake(*_): calls.append(1); return data
        with self.assertRaisesRegex(ValueError, 'nonexistent summary location'):
            ev.judge_direct_once(SOURCE,SUMMARY,FACTS,fake)
        self.assertEqual(calls,[1])

    def test_missing_fact_rejected(self):
        data=sample(); data['decisions'].pop()
        with self.assertRaisesRegex(ValueError, 'omitted/duplicated'):
            ev.judge_direct_once(SOURCE,SUMMARY,FACTS,lambda *_: data)

    def test_unsupported_summary_unit_is_provisional_claim(self):
        data=sample(); data['unsupported_ids']=['s2']
        res=ev.judge_direct_once(SOURCE,SUMMARY,FACTS,lambda *_: data)
        self.assertEqual(res['claims'][1]['verdict'], 'uncertain')
        self.assertGreater(res['uncertain'],0)
        self.assertIsNone(res['scores']['recall'])

    def test_empty_inventory_does_not_fabricate_claims(self):
        data={'decisions':[{'id':f['id'],'verdict':'missing','summary_ids':[], 'source_id':None,'reason':'not stated'} for f in FACTS]}
        res=ev.judge_direct_once(SOURCE,SUMMARY,FACTS,lambda *_: data)
        self.assertEqual(res['claims'],[])
        self.assertEqual(res['scores']['recall'],0)

    def test_oversize_input_never_sent(self):
        with self.assertRaisesRegex(ValueError, 'nothing truncated'):
            ev.judge_direct_once(SOURCE*150,SUMMARY,FACTS,lambda *_: self.fail('called model'))

if __name__ == '__main__': unittest.main()
