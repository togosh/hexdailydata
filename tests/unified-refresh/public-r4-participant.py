"""Actual R4 participant client, page writer and full auditor; injected bodies only.

The sole authority seam relocates the exact R4 root to a labelled fixture. All
socket/DNS/process creation is denied. This cannot create a public admission.
"""
import sys,os,json,copy,tempfile,importlib.util,socket,subprocess
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
T=Path(os.environ['HDD_TASK_ROOT']).resolve()
assert T.name=='unified-refresh-public-qualification-r4'
def deny(*a,**k):raise AssertionError('NETWORK_OR_CHILD_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=subprocess.Popen=deny
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts/participant-refresh'),str(W/'scripts/market-refresh')]
from durable import save,strict_json,digest
import public_profile,audit,collector
from combined import Combined,ParentTransport,LIMITS,TASK,GLOBAL
from session import ParticipantSession
from capture_client import Stop
root=Path(tempfile.mkdtemp(prefix='r4-participant-',dir=T/'fixtures'))
config=public_profile.authority(public_profile.R4_PROFILE)
base=json.loads((T/'packet/INPUTS.json').read_bytes())['targetWindow']['base']
target=dict(number=config['target'],hash='0x'+format(config['target'],'064x'),timestamp=base['timestamp']+40960)
plan=dict(combinedJob=True,unifiedProfileId=config['profile'],base=base,finalTarget=target,
    windows=[dict(fromInclusive=base['number'],targetNumber=target['number'],newBlockSpan=4096)],
    graphqlEndpoint='https://graph.pulsechain.com/subgraphs/name/pulsechain/hex',
    rpcEndpoints=['https://rpc.pulsechain.com/','https://rpc-pulsechain.g4mm4.io/'],
    deployment='QmSsv8uvNLbfJCQARk7xd9iNouNmaoqZCrqEwRaFCHJMCw',maximumBlockStep=4096,
    limits=dict(maximumAffectedParents=50000,maximumChangedKeysPerFamily=100000))
save(root/'SCOPE.json',plan);os.environ['HDD_TASK_ROOT']=str(root)
spec=importlib.util.spec_from_file_location('fixture',W/'tests/participant-refresh/client_test.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
class Bound(Combined,ParticipantSession):pass
original_authority=public_profile.authority
cases=[]
for extra in (3,5):
    trial=root/('ordinal-'+str(extra));trial.mkdir();parent=trial/'session';parent.mkdir();job=parent/'participants-1';job.mkdir()
    clock=fixture.Clock();limits=copy.deepcopy(LIMITS['participants']);network=limits['seconds']-limits['publication']-5
    raw_plan={**plan,'finalTarget':{'number':target['number'],'hash':None,'timestamp':None}}
    save(job/'PLAN.json',raw_plan)
    a=dict(task=TASK,combinedJob=True,family='participants',job='participants-1',jobRoot=str(job),
        allowance=limits,initial={'participant':{'base':base}},networkSeconds=network,networkDeadline=network,deadlineMonotonic=limits['seconds'],
        unifiedProfileId=config['profile'],authorityTaskId=config['task'],synthetic=False,parentMode='OWNER_AUTHORIZED_PUBLIC',
        parentProfileSha256=config['profileHash'],parentNonce='a'*64,preflightSha256='b'*64,
        scopeSha256=config['packet']['packet/SCOPE.json'],planSha256=digest((job/'PLAN.json').read_bytes()),
        parentLimits=json.loads((T/'packet/PUBLIC_PROFILE.json').read_bytes())['parent'])
    save(job/'ADMISSION.json',a);save(job/'JOB_CLOCK.json',{'networkSeconds':network})
    ps={k:0 for k in GLOBAL};ps.update(status='ADMITTED',job=a['job'],pending=None,lastClosedMonotonic=None,
        networkDeadline=network,attempts=0,extraAttempts=0,graphExtras=0,rpcExtras=0,observedBytes=0,
        returnedEntities=0,unknownEntityReservations=0,rpcEndpointAttempts=[0,0])
    save(parent/'PARENT_ACCOUNTING.json',ps)
    s=Bound(job,None,copy.deepcopy(raw_plan),clock,clock.sleep,True);s.configure(a,parent)
    class Replies(fixture.Fixture):
        def __init__(self):super().__init__(clock);self.remaining=extra
        def __call__(self,path,deadline,storage):
            q=strict_json(path.read_bytes())['job']
            eligible = (q['kind']=='changes' and q['family']=='tokenHolders') if extra==3 else q['kind']=='parents'
            if self.remaining and eligible and q['phase']=='data':
                self.replies=[{'errors':[{'message':'Store error: database unavailable'}]}];self.remaining-=1
            return super().__call__(path,deadline,storage)
    responses=Replies();s.transport=ParentTransport(s,responses)
    s.storage.json(job/'FRONTIER.json',{'completedWindows':0})
    def fixture_authority(profile):
        out=original_authority(profile)
        return {**out,'root':trial} if profile==config['profile'] else out
    with patch.object(public_profile,'authority',fixture_authority):
        collector.run_window(s,1,base,fixture.Tests().exchange(s,responses),{k:set() for k in ('tokenHolders','stakeStarts','parents')})
        s.close('Synthetic completed; no public requests')
        resolved=strict_json((job/'RESOLVED_PLAN.json').read_bytes())
        proof=audit.audit_window(job,1,resolved,s.state);assert proof['complete']
        for field,value in [('number',base['number']-1),('hash','0x'+'1'*64),('timestamp',base['timestamp']+1)]:
            changed=copy.deepcopy(resolved);changed['base'][field]=value
            try:audit.audit_window(job,1,changed,s.state)
            except ValueError:pass
            else:raise AssertionError('Wrong predecessor accepted '+field)
        caps=[json.loads(b) for b in (job/'LEDGER.jsonl').read_bytes().splitlines()]
        accepted=next(i for i,c in enumerate(caps) if c['retryIndex']==extra and c['usable'])
        assert all(n in clock.waits for n in [15,60,120,240,300][:extra])
        # Mutate actual saved replay, not only the classifier.
        original_read=Path.read_bytes
        for label,mutate in [('query',lambda x:x[accepted]['job'].__setitem__('query',x[accepted]['job']['query']+' ')),
                             ('wait',lambda x:x[accepted].__setitem__('startOffsetSeconds',x[accepted-1]['startOffsetSeconds']+x[accepted-1]['durationSeconds']+1)),
                             ('ordinal',lambda x:x[accepted].__setitem__('retryIndex',6))]:
            def changed(p):
                b=original_read(p)
                if p==job/'LEDGER.jsonl':
                    x=[json.loads(v) for v in b.splitlines()];mutate(x);return b'\n'.join(json.dumps(v).encode() for v in x)+b'\n'
                return b
            with patch.object(Path,'read_bytes',changed):
                try:audit.audit_window(job,1,resolved,s.state)
                except ValueError:pass
                else:raise AssertionError('Saved replay accepted '+label)
        legacy={**resolved,'unifiedProfileId':'unified-five-feed-offline-1'}
        try:audit.audit_window(job,1,legacy,s.state)
        except ValueError as e:assert str(e)=='One exact retry ordinal'
        else:raise AssertionError('Old policy broadened')
        q=caps[accepted]['job'];previous=caps[accepted-1]
        for change in [{'phase':'control'},{'kind':'rpc'}]:assert audit.retry_maximum({**q,**change},previous,False,True)==2
        for change in [{'usable':True},{'closureKnown':False},{'classification':'unknown'}]:assert audit.retry_maximum(q,{**previous,**change},False,True)==2
    cases.append(dict(ordinal=extra,root=str(job),attempts=s.state['attempts'],proof=proof,waits=clock.waits,
        fullCollectorPageWriterAuditor=True,refused=['wrong predecessor number/hash/time','wrong query','short wait','excessive ordinal','old profile','control','rpc','data-with-error','unknown closure','unknown classification']))
save(root/'RESULT.json',dict(status='PASS',synthetic=True,rootAuthorityRelocationOnly=True,externalRequests=0,baseAdmissions=0,cases=cases))
print(json.dumps(dict(status='PASS',root=str(root),ordinals=[3,5],externalRequests=0,baseAdmissions=0)))
