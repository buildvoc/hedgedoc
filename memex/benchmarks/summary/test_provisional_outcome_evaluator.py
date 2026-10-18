"""Offline tests; no live provider or HedgeDoc calls."""
import unittest
import provisional_outcome_evaluator as ev

SOURCE = ('Clause 14 says the report should inform the fire risk assessment. '
          'The report is not a certificate of building regulation compliance. '
          'The appraiser should include the building address.')
SUMMARY = ('The report should inform the fire risk assessment. '
           'The report certifies building regulations compliance.')
GOLD = [{'id':'14-1','expectation':'Report informs fire risk assessment'},
        {'id':'14-2','expectation':'Report does not certify building regulation compliance'},
        {'id':'14-4c','expectation':'Report includes building address'}]
CLAIMS = [{'id':'c1','text':'The report should inform the fire risk assessment',
           'summary_quote':'The report should inform the fire risk assessment.'},
          {'id':'c2','text':'The report certifies building regulations compliance',
           'summary_quote':'The report certifies building regulations compliance.'}]

class Tests(unittest.TestCase):
    def test_exact_evidence_normalizes_whitespace_only(self):
        self.assertTrue(ev.exact_excerpt('report should inform the fire risk assessment', SOURCE))
        self.assertFalse(ev.exact_excerpt('report MUST inform fire risk assessment',SOURCE))
    def test_complete_proposal_and_scores(self):
        def invoke(system, user):
            if 'EVERY claim' in system:
                return {'claim_decisions':[
                     {'id':'c1','verdict':'supported','source_quote':'report should inform the fire risk assessment','reason':'Direct source support'},
                     {'id':'c2','verdict':'contradicted','source_quote':'not a certificate of building regulation compliance','reason':'Opposite assertion'}],
                     'fact_decisions':[
                     {'id':'14-1','verdict':'covered','matched_claim_ids':['c1'], 'summary_quote':'The report should inform the fire risk assessment','reason':'Accurately covered'},
                     {'id':'14-2','verdict':'incorrect','matched_claim_ids':[], 'summary_quote':'', 'reason':'Compliance reversed'},
                     {'id':'14-4c','verdict':'missing','matched_claim_ids':[], 'summary_quote':'', 'reason':'Address omitted'}]}
            raise AssertionError('Unexpected model request')
        result=ev.judge(SOURCE,SUMMARY,GOLD,CLAIMS,invoke)
        self.assertEqual(result['grades'], {'14-1':'covered','14-2':'incorrect','14-4c':'missing'})
        self.assertEqual(result['claims'][0]['matched_fact_ids'],['14-1'])
        scores=ev.provisional_scores(result)
        self.assertAlmostEqual(scores['precision'],0.5)
        self.assertAlmostEqual(scores['recall'],1/3)
        self.assertAlmostEqual(scores['f1_style'],0.4)
    def test_invalid_evidence_refuses_supported(self):
        def invoke(system,user):
            return {'claim_decisions':[
                {'id':'c1','verdict':'supported','source_quote':'NEVER SEEN THIS QUOTE','reason':'test'},
                {'id':'c2','verdict':'not_in_source','source_quote':'','reason':'test'}],
                'fact_decisions':[
                    {'id':'14-1','verdict':'covered','matched_claim_ids':['c1'],
                     'summary_quote':CLAIMS[0]['summary_quote'],'reason':'test'},
                    {'id':'14-2','verdict':'missing','matched_claim_ids':[],'summary_quote':'','reason':'test'},
                    {'id':'14-4c','verdict':'missing','matched_claim_ids':[],'summary_quote':'','reason':'test'}]}
        got=ev.judge(SOURCE,SUMMARY,GOLD,CLAIMS,invoke)
        self.assertEqual(got['claims'][0]['verdict'],'uncertain')
        self.assertEqual(got['grades']['14-1'],'unrated')
        self.assertEqual(got['scores'] if 'scores' in got else ev.provisional_scores(got)['status'],'incomplete')
    def test_truncation(self):
        with self.assertRaises(ValueError):
            ev.extract(SUMMARY,lambda s,u:{'claims':[]})
    def test_no_unsupported_claims_as_verified(self):
        self.assertEqual(ev.provisional_scores({'claims':[], 'grades':{},'uncertain':1})['status'],'incomplete')

if __name__=='__main__': unittest.main()
