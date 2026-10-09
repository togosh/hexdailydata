"""Focused R2 actual client/page/auditor tests. No provider/DNS calls."""
import sys, os, copy, json, tempfile, unittest, shutil
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import client_test as previous
from session import ParticipantSession
from collector import run_window, controls
from audit import audit_captures, audit_window
from capture_client import Stop, LimitReached
from queries import make_job, validate_job
from durable import strict_json, encode, digest
from retry_schedule import VERSION, WAITS, requirements, slow_eligible
R=previous.R; PLAN=previous.PLAN
KNOWN=strict_json((R/'reference-r1/session/captures/00009/response.body').read_bytes())
MISSING={'errors':[{'message':'Store error: store error: prepared statement "__diesel_stmt_0" does not exist'}]}
DATABASE={'errors':[{'message':'Store error: database unavailable'}]}
UNNAMED={'errors':[{'message':'Store error: store error: unnamed prepared statement does not exist'}]}
RESULTS=[]


class TargetFixture(previous.Fixture):
    def __init__(self, clock, sequence):
        super().__init__(clock)
        self.sequence=list(sequence)
        self.trigger='changes'

    def __call__(self, path, deadline, storage):
        q=strict_json(path.read_bytes())['job']
        if q['kind']==self.trigger and q['phase']=='data' and (self.trigger=='parents' or q['family']=='tokenHolders' and q['cursor'] is None) and self.sequence:
            self.replies=[self.sequence.pop(0)]
        return super().__call__(path, deadline, storage)


class Tests(unittest.TestCase):
    def new(self, sequence=()):
        root=Path(tempfile.mkdtemp(prefix='retry-r2-',dir=R/'evidence/fixtures'))
        c=previous.Clock();f=TargetFixture(c,sequence)
        s=ParticipantSession(root,f,PLAN,c,c.sleep,True)
        s.storage.json(root/'FRONTIER.json',{'completedWindows':0})
        self.addCleanup(lambda:s.close('Synthetic focused closure'))
        return s,c,f

    def window(self, sequence):
        s,c,f=self.new(sequence)
        run_window(s,1,PLAN['base'],previous.Tests.exchange(self,s,f),{k:set() for k in ('tokenHolders','stakeStarts','parents')})
        s.close('Synthetic complete window')
        proof=audit_window(s.root,1,PLAN,s.state)
        self.assertTrue(proof['complete'])
        self.assertTrue((s.root/'window-01/tokenHolders/00001.ndjson').exists())
        RESULTS.append({'case':self.id(),'root':str(s.root),'status':'PASS','accounting':s.state})
        return s,c,f

    def test_known_r1_sequence_actual_page_and_auditor(self):
        s,c,f=self.window([KNOWN,KNOWN])
        self.assertEqual(s.state['extraAttempts'],2)
        self.assertEqual(s.state['retryScheduleVersion'],VERSION)

    def test_success_on_sixth_mixed_classifications_and_audit_tampering(self):
        s,c,f=self.window([KNOWN,MISSING,DATABASE,UNNAMED,{'errors':KNOWN['errors']+MISSING['errors']}])
        self.assertEqual(s.state['extraAttempts'],5)
        lines=[strict_json(x) for x in (s.root/'LEDGER.jsonl').read_bytes().splitlines()]
        attempts=[x for x in lines if x['job']['kind']=='changes' and x['job']['family']=='tokenHolders' and x['job']['cursor'] is None and x['job']['phase']=='data']
        self.assertEqual([x['retryIndex'] for x in attempts],list(range(6)))
        self.assertEqual(len({x['requestSha256'] for x in attempts}),1)
        for a,b,wait in zip(attempts,attempts[1:],WAITS):
            self.assertGreaterEqual(b['startOffsetSeconds']-a['startOffsetSeconds']-a['durationSeconds']+.001,wait)
        mutations={
            'early':lambda cap:cap.update(startOffsetSeconds=cap['startOffsetSeconds']-1),
            'seventh':lambda cap:cap.update(retryIndex=6),
            'reset':lambda cap:cap.update(retryIndex=1),
            'query':lambda cap:cap['job'].update(first=500),
            'control':lambda cap:cap['job'].update(phase='control'),
            'ineligible':lambda cap:cap.update(classification=None),
        }
        for name,change in mutations.items():
            target=Path(tempfile.mkdtemp(prefix='audit-'+name+'-',dir=R/'evidence/fixtures'))
            shutil.copytree(s.root,target,dirs_exist_ok=True)
            changed=copy.deepcopy(lines);cap=changed[attempts[3]['attempt']-1]
            change(cap)
            (target/cap['capture']).write_bytes(encode(cap));(target/'LEDGER.jsonl').write_bytes(b''.join(encode(x) for x in changed))
            with self.assertRaises((ValueError,KeyError,StopIteration)):
                audit_captures(target,PLAN,s.state,terminal=True)
        target=Path(tempfile.mkdtemp(prefix='audit-reserve-',dir=R/'evidence/fixtures'))
        shutil.copytree(s.root,target,dirs_exist_ok=True)
        path=target/'reservations/00001.json';r=strict_json(path.read_bytes());r['controls']=[];path.write_bytes(encode(r))
        with self.assertRaisesRegex(ValueError,'Independent dispatch reservation'):audit_captures(target,PLAN,s.state,terminal=True)

    def test_six_error_exhaustion_no_page_or_frontier_advance(self):
        s,c,f=self.new([KNOWN]*6)
        with self.assertRaisesRegex(Stop,'exhausted'):run_window(s,1,PLAN['base'],lambda *x:None,{k:set() for k in ('tokenHolders','stakeStarts','parents')})
        s.close('Synthetic six-error exhaustion')
        self.assertEqual(s.state['attempts'],14);self.assertEqual(s.state['extraAttempts'],5)
        self.assertFalse((s.root/'window-01/tokenHolders/00001.ndjson').exists())
        self.assertEqual(strict_json((s.root/'FRONTIER.json').read_bytes())['completedWindows'],0)
        audit_captures(s.root,PLAN,s.state,terminal=True)
        RESULTS.append({'case':self.id(),'status':'PASS','root':str(s.root),'accounting':s.state})

    def test_parent_slow_retry_and_actual_predispatch_refusals(self):
        s,c,f=self.new([KNOWN]*3);f.trigger='parents'
        run_window(s,1,PLAN['base'],previous.Tests.exchange(self,s,f),{k:set() for k in ('tokenHolders','stakeStarts','parents')})
        s.close('Synthetic parent success');audit_window(s.root,1,PLAN,s.state)
        for reason in ('deadline','shared'):
            s,c,f=self.new([KNOWN]*6)
            if reason=='deadline':
                actual=s.attempt
                def stalled(*args,**kwargs):
                    cap,data=actual(*args,**kwargs)
                    if cap['job']['kind']=='changes' and cap['retryIndex']==2:c.n=2100
                    return cap,data
                s.attempt=stalled
            else:
                # Explicit synthetic historical-extra budget fixture, not downloaded coverage.
                s.state['graphExtraAttempts']=58;s.state['extraAttempts']=58
            with self.assertRaises(LimitReached):run_window(s,1,PLAN['base'],lambda *x:None,{k:set() for k in ('tokenHolders','stakeStarts','parents')})
            self.assertEqual(s.state['attempts'],11)
            self.assertIsNone(s.state['pending'])
            self.assertNotIn(120,c.waits)

    def test_prohibitions_and_immediate_previous_failure(self):
        cases=[([KNOWN,KNOWN,'timeout'],3),([KNOWN,KNOWN,(503,b'gateway')],3),
               ([KNOWN]*3+['timeout'],4),([KNOWN,KNOWN,{'errors':[{'message':'unknown'}]}],3),
               ([KNOWN,KNOWN,{'data':{},'errors':KNOWN['errors']}],3),
               ([KNOWN,KNOWN,{'errors':KNOWN['errors']+[{'message':'unknown'}]}],3),
               ([KNOWN,KNOWN,'unknown'],3),([KNOWN,KNOWN,(429,b'rate limited')],3),
               ([KNOWN,KNOWN,b'{'],3)]
        for sequence,attempts in cases:
            s,c,f=self.new();s.begin_window(1);s.controls=controls(1);f.replies=list(sequence)
            q=make_job(PLAN,1,'changes',pin=f.pin(PLAN['windows'][0]['targetNumber']),family='tokenHolders')
            with self.assertRaises(Stop):s.request(q)
            self.assertEqual(s.state['attempts'],attempts)
        for kind,phase in [('meta','opening'),('changes','control'),('witness','control'),('rpc','opening')]:
            s,c,f=self.new();s.begin_window(1);f.replies=[KNOWN]*6
            kw={'pin':f.pin(PLAN['windows'][0]['targetNumber'])}
            if kind=='changes':kw.update(family='tokenHolders')
            if kind=='witness':kw.update(family='tokenHolders',ids=['0x01'],first=1)
            if kind=='rpc':kw={'endpoint':0,'method':'eth_chainId'}
            with self.assertRaises(Stop):s.request(make_job(PLAN,1,kind,phase,**kw))
            self.assertLessEqual(s.state['attempts'],3)

    def test_controls_reserve_optional_refusal_and_cancellation(self):
        s,c,f=self.new();s.begin_window(1);s.controls=controls(1)
        q=make_job(PLAN,1,'changes',pin=f.pin(PLAN['windows'][0]['targetNumber']),family='tokenHolders')
        initial=requirements(q,s.controls,0,s.state,0)
        self.assertEqual(initial['ordinaryControls'],18);self.assertEqual(initial['physicalAttemptsReserved'],57)
        self.assertEqual(initial['finishOffsetBound'],3192)
        for ordinal in range(3,6):requirements(q,s.controls,ordinal,s.state,0,WAITS[ordinal-1])
        s.state['graphExtraAttempts']=60
        with self.assertRaisesRegex(ValueError,'graph extra'):requirements(q,s.controls,3,s.state,0,120)
        s.state['graphExtraAttempts']=0
        with self.assertRaisesRegex(ValueError,'deadline'):requirements(q,s.controls,3,s.state,2100,120)
        refusal={'status':'PASS','initial':initial,'nearDeadline':{'elapsedSeconds':2100,'nextWaitSeconds':120,'dispatched':False},'slowStepsReserveOnlyNextAttempt':True}
        (R/'evidence/RESERVE_CALCULATION.json').write_bytes(encode(refusal))
        s2,c2,f2=self.new([KNOWN]*3)
        def cancelled(n):
            if n==120:raise KeyboardInterrupt('Synthetic cancellation during long wait')
            c2.sleep(n)
        s2.sleep=cancelled
        with self.assertRaises(KeyboardInterrupt):run_window(s2,1,PLAN['base'],lambda *x:None,{k:set() for k in ('tokenHolders','stakeStarts','parents')})
        self.assertEqual(s2.state['attempts'],11);self.assertIsNone(s2.state['pending'])

    def test_r1_full_page_reference_and_identical_second_request(self):
        s,c,f=self.new([KNOWN,KNOWN]);reference=strict_json((R/'R1_COMPARISON.json').read_bytes());s.reference=reference
        old_pin=f.pin;f.pin=lambda n:reference['target'] if n==reference['target']['number'] else old_pin(n)
        old_rows=f.data_rows;f.holders=100
        f.data_rows=lambda family,window,side='after':reference['rows'] if family=='tokenHolders' else old_rows(family,window,side)
        run_window(s,1,PLAN['base'],previous.Tests.exchange(self,s,f),{k:set() for k in ('tokenHolders','stakeStarts','parents')})
        self.assertEqual(strict_json((s.root/'R1_FIRST_PAGE_COMPARISON.json').read_bytes())['rows'],100)
        queries=[q for q in f.queries if q['kind']=='changes' and q['family']=='tokenHolders' and q['phase']=='data']
        self.assertEqual(digest(validate_job(queries[-1],PLAN)[2]),reference['failedSecondPageRequestSha256'])
        s.close('Synthetic exact R1 comparison');audit_window(s.root,1,PLAN,s.state)


if __name__=='__main__':
    runner=unittest.TextTestRunner(verbosity=2);result=runner.run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests))
    (R/'evidence/RETRY_R2_TESTS.json').write_bytes(encode({'status':'PASS' if result.wasSuccessful() else 'FAIL','tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'synthetic':True,'externalRequests':0,'cases':RESULTS}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
