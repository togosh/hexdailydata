"""Focused composed tests of the maintained collectors with the new parent gate.
Fixtures are injected; socket/DNS/physical-child functions are forbidden.
"""
import sys,os,json,tempfile,importlib.util,time,copy,socket,subprocess,hashlib
from pathlib import Path
W=Path(__file__).resolve().parents[2];R=Path(os.environ['HDD_TASK_ROOT']);family=sys.argv[1]
def forbidden(*a,**k):raise AssertionError('OFFLINE_NETWORK_OR_CHILD_FORBIDDEN')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=subprocess.Popen=forbidden
folder={'market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[family]
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts'/folder),str(W/'scripts/market-refresh')]
from durable import encode,strict_json,digest,save
from combined import Combined,ParentTransport,LIMITS,GLOBAL,TASK,reserve,audit_reservations,read
from capture_client import Session,Stop,LimitReached
plan=read(R/'REQUEST_PLAN.json')['participant'];plan=copy.deepcopy(plan)
plan['finalTarget']={'number':27754425,'hash':'0x'+format(27754425,'064x'),'timestamp':plan['base']['timestamp']+40960}
root=Path(tempfile.mkdtemp(prefix='synthetic-'+family+'-',dir=R/'temp'))
(root/'reference').mkdir();(root/'evidence').mkdir()
save(root/'SCOPE.json',plan)
if family=='market':save(root/'reference/ROUND_2_SEALED.json',{'synthetic':True,'pin':{'number':27754425,'hash':'0x'+'1'*64,'parentHash':'0x'+'2'*64,'timestamp':int(time.time())-300}})
os.environ['HDD_TASK_ROOT']=str(root)
spec=importlib.util.spec_from_file_location('reused_fixture',W/'tests'/folder/'client_test.py')
old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
if family=='participants':old.PLAN=plan
import collector
Base={'market':Session,'gas':getattr(old,'GasSession',None),'protocol':getattr(old,'ProtocolSession',None),'participants':getattr(old,'ParticipantSession',None)}[family]
class Bound(Combined,Base):pass
initial=read(R/'evidence/ADMITTED_SEED.json')['initial']
cases=[]
def make(label,transport=None):
    parent=root/label;parent.mkdir();job=parent/(family+'-1');job.mkdir()
    clock=old.Clock();limits=copy.deepcopy(LIMITS[family]);network=limits['seconds']-limits['publication']-5
    a=dict(task=TASK,combinedJob=True,family=family,job=family+'-1',allowance=limits,initial=copy.deepcopy(initial),
           networkSeconds=network,networkDeadline=network,deadlineMonotonic=limits['seconds'])
    if family=='market':a['sourceFiles']=collector.source_binding()
    save(job/'ADMISSION.json',a);save(job/'JOB_CLOCK.json',{'networkSeconds':network})
    parent_state={k:0 for k in GLOBAL};parent_state.update(status='ADMITTED',job=a['job'],pending=None,lastClosedMonotonic=None,networkDeadline=network,
        attempts=0,extraAttempts=0,graphExtras=0,rpcExtras=0,observedBytes=0,returnedEntities=0,unknownEntityReservations=0,rpcEndpointAttempts=[0,0])
    save(parent/'PARENT_ACCOUNTING.json',parent_state)
    s=Bound(job,None,copy.deepcopy(plan),clock,clock.sleep,True) if family=='participants' else Bound(job,None,clock,clock.sleep,True)
    s.configure(a,parent)
    if transport is None:transport=old.Composed() if family=='market' else old.Fixture(clock,holders=650) if family=='participants' else old.Transport()
    s.transport=ParentTransport(s,transport)
    return s,clock,transport

if family=='protocol':
    import protocol
    import capture_client
    from datetime import datetime,timezone
    virtual_wall=time.time()+86400
    time.time=lambda:virtual_wall
    synthetic_utc=lambda:datetime.fromtimestamp(virtual_wall,timezone.utc).isoformat()
    capture_client.utc=collector.utc=synthetic_utc
    # Explicit synthetic bytecode at this test seam; the real runtime hash gate is unchanged.
    synthetic_code='60'*20989
    protocol.CODE_SHA=hashlib.sha256(bytes.fromhex(synthetic_code)).hexdigest()
    class Dynamic:
        def __init__(self,seed,new=0,tamper=False):self.seed=seed;self.new=new;self.tamper=tamper;self.timestamp=int(time.time())-20
        def __call__(self,path,deadline,storage):
            q=read(path)['job'];m=q['method'];p=q['params'];k=protocol.kind(q)
            end=self.seed['end'];d=end+self.new;n=max(27760000,self.seed['number']+10);t=self.timestamp
            def packed(day):return self.seed['tail'][day-(end-2)] if day<end else str((1234567890123<<72)+987654321+day)
            if m=='eth_chainId':v='0x171'
            elif m=='eth_getBlockByNumber':
                number=n+2 if p[0]=='latest' else int(p[0],16)
                v=dict(number=hex(number),hash='0x'+protocol.word(number),parentHash='0x'+protocol.word(number-1),timestamp=hex(t),transactions=[])
            elif m=='eth_getCode':v='0x'+synthetic_code
            elif k=='global':v='0x'+''.join(protocol.word(x) for x in [10000000000,12000000000000,123456,0,d,99000000000000,0,0,0,0,t,90000000000,0])
            elif k=='supply':v='0x'+protocol.word(90000000000)
            elif k=='range':
                args=p[0]['data'][10:];a,b=int(args[:64],16),int(args[64:],16);words=[int(packed(i)) for i in range(a,b)]
                if self.tamper:words[0]+=1
                v='0x'+''.join(protocol.word(x) for x in [32,b-a,*words])
            else:v='0x'+''.join(protocol.word(int(x)) for x in protocol.unpack(int(packed(int(p[0]['data'][10:],16)))))
            raw=encode({'jsonrpc':'2.0','id':1,'result':v});(path.parent/'response.body').write_bytes(raw)
            return dict(status=200,complete=True,framingValidated=True,connectionClosed=True,childReaped=True,headers=[['Content-Length',str(len(raw))]],expectedBodyBytes=len(raw),framingKind='content-length',wireBodyBytes=len(raw),wireBodySha256=digest(raw))
    seed=copy.deepcopy(initial['protocol'])
    for label,new in [('empty',0),('append',1),('next-admitted-tail',0)]:
        s,c,tr=make(label,Dynamic(seed,new));s.admission['initial']['protocol']=copy.deepcopy(seed);save(s.root/'ADMISSION.json',s.admission)
        result=collector.run_cycles(s,1,lambda m,d:{'ok':True,'cycle':m['cycle']},seed)
        update=read(s.root/'ROUND_1_UPDATE.json');assert result['appendedDays']==new
        assert update['ledgerAppend']['from']==seed['end'];s.close('synthetic closed')
        audit_reservations(s.root,s.state,s.capacity)
        cases.append(dict(case=label,attempts=s.state['attempts'],fromDay=seed['end'],append=new))
        if new:seed={'end':seed['end']+new,'number':read(s.root/'ROUND_1_AUDIT.json')['details']['context']['number'],'tail':(seed['tail']+update['ledgerAppend']['words'])[-2:]}
    s,c,tr=make('tamper',Dynamic(initial['protocol'],tamper=True))
    try:collector.run_cycles(s,1,lambda m,d:{'ok':True,'cycle':m['cycle']},initial['protocol']);raise AssertionError('Tampered tail accepted')
    except Stop:pass
    assert not (s.root/'ROUND_1_UPDATE.json').exists();s.close('synthetic refused')
    cases.append(dict(case='overlap tamper refused before publication',attempts=s.state['attempts']))
elif family=='participants':
    s,c,f=make('composed');s.storage.json(s.root/'FRONTIER.json',{'completedWindows':0})
    proof_clock=old.Tests();exchange=proof_clock.exchange(s,f)
    collector.run_window(s,1,plan['base'],exchange,{k:set() for k in ('tokenHolders','stakeStarts','parents')})
    s.close('synthetic completed');audit_reservations(s.root,s.state,s.capacity)
    pages=[q['first'] for q in f.queries if q['kind']=='changes' and q['phase']=='data' and q['family']=='tokenHolders']
    assert pages==[100]*5+[500,500];cases.append(dict(case='actual pages, independent parent, witnesses, growth and saved auditor',attempts=s.state['attempts'],pages=pages))
    errors={'errors':[{'message':'Store error: database unavailable'}]}
    s,c,f=make('slow');s.transport=ParentTransport(s,old.Fixture(c,holders=1,replies=[errors]*5))
    s.controls=collector.controls(1)
    q=old.make_job(plan,1,'changes',pin=plan['finalTarget'],family='tokenHolders')
    cap,_=s.request(q);assert cap['retryIndex']==5;assert all(n in c.waits for n in [15,60,120,240,300]);s.close('synthetic slow success')
    cases.append(dict(case='one exact six-attempt data ordinal, shared parent charges and five reserved waits',attempts=s.state['attempts']))
else:
    for ordinal in ([1,2] if family=='gas' else [1]):
        s,c,f=make('composed-'+str(ordinal))
        if family=='gas':
            initial_gas={'number':None,'observedAtUtc':'2026-10-08T00:00:00Z','firstRound':ordinal==1}
            s.admission['initial']['gas']=initial_gas;save(s.root/'ADMISSION.json',s.admission)
            result=collector.run_cycles(s,1,lambda m,d:{'ok':True,'cycle':m['cycle']},initial_gas)
            if ordinal==2:assert not any(q['phase'] in ('history','witness') for q in f.queries)
        else:result=collector.run_cycles(s,1,lambda m,d:{'ok':True,'cycle':m['cycle']},old.PIN)
        s.close('synthetic closed');assert result['status']=='COMPLETE_FINITE_TRIAL';audit_reservations(s.root,s.state,s.capacity)
        cases.append(dict(case='actual collector, closed bodies, parent charging and semantic auditor round '+str(ordinal),attempts=s.state['attempts']))

# Every actual client must refuse a child allowance incapable of reserving its next response.
s,c,f=make('exhausted')
q=old.rpc_job(0,'eth_chainId',[]) if family=='market' else old.make_job(plan,1,'rpc','opening',method='eth_chainId') if family=='participants' else old.job(0,'eth_chainId',[])
s.limits['rpcAttempts']=0
try:s.request(q);raise AssertionError('Child allowance renewed')
except LimitReached:pass
assert s.state['attempts']==0;assert read(s.parent_root/'PARENT_ACCOUNTING.json')['attempts']==0;s.close('synthetic predispatch refusal')
cases.append({'case':'child allowance cannot renew; zero physical dispatch on insufficient mandatory reserve'})
save(R/'evidence'/('CLIENT_'+family+'_'+str(time.time_ns())+'.json'),dict(status='PASS',family=family,synthetic=True,externalRequests=0,root=str(root),cases=cases))
print(json.dumps(dict(status='PASS',family=family,cases=cases,root=str(root))))
