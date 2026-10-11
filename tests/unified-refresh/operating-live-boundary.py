"""Hard-denied actual worker entries; only final response I/O is substituted.

The policy ROOT is relocated inside the task's synthetic fixture and every
document is labelled SYNTHETIC. No actual admission or base is opened.
"""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import json,hashlib,time,os,copy,importlib.util,importlib.machinery,subprocess,uuid
W=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts/trade-feed'),str(W/'scripts/market-refresh')]
import operating_authority as authority
T=Path(authority.POLICY['root'])
def deny(event,args):
    if event.startswith('socket.'):raise PermissionError('HARD_DENIED_NETWORK')
sys.addaudithook(deny)
def raw(p):return Path(p).read_bytes()
def read(p):return json.loads(raw(p))
def sha(b):return hashlib.sha256(b).hexdigest()
def put(p,v):
    p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,separators=(',',':'))+'\n',encoding='utf-8')
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def worker_case(base,family,case):
    fixture=base/(family+'-'+case);fixture.mkdir();policy=copy.deepcopy(authority.POLICY);policy['root']=str(fixture);authority.POLICY=policy
    source=T/'reference/native-boundary'
    original=next(p for p in source.iterdir() if p.is_dir() and p.name.startswith(family+'-'))
    a=read(original/'ADMISSION.json');job=fixture/'session'/a['job'];job.mkdir(parents=True)
    request=job/('01' if family=='trade' else 'captures/00001')/'request.json';request.parent.mkdir(parents=True)
    old_request=original/request.relative_to(job);q=read(old_request)
    start=time.time();config=authority.bounded_config(start)
    runtime={str(p.relative_to(W)).replace('\\','/'):sha(raw(p)) for folder in ('scripts/unified-refresh','scripts/trade-feed','scripts/market-refresh','scripts/participant-refresh','scripts/gas-feed','scripts/protocol-feed') for p in (W/folder).iterdir() if p.is_file() and p.suffix in ('.py','.mjs','.json')}
    runtime['config/repeatable-operating-public-1.json']=sha(raw(W/'config/repeatable-operating-public-1.json'))
    a.update(operatingFormat=authority.LIVE,authorityTaskId=policy['task'],parentMode='OWNER_AUTHORIZED_PUBLIC',synthetic=False,jobRoot=str(job),
        startedAtUnixSeconds=start,deadlineUnixSeconds=start+a['allowance']['seconds'],activationExpiresAt=start+2400,
        networkClosesAtUnixSeconds=min(start+2220,start+a['allowance']['seconds']-a['allowance']['publication']-5),
        runtimeFiles=runtime,parentNonce='b'*64,sourceBindingSha256=sha(authority.canonical(runtime)),
        scopeSha256=policy['packetHashes']['packet/SCOPE.json'],parentProfileSha256=sha(json.dumps(config,separators=(',',':')).encode()))
    a['sourceFiles']={p.name:sha(raw(p)) for p in (W/'scripts/market-refresh').iterdir() if p.is_file() and p.suffix in ('.py','.json')}
    if family=='trade':q['dispatchByUnixSeconds']=a['networkClosesAtUnixSeconds']-65
    else:(request.parent/'request.body').write_bytes(raw(old_request.parent/'request.body'))
    put(request,q)
    if family=='participants':
        plan=read(original/'PLAN.json');plan.update(operatingFormat=authority.LIVE,base=policy['selection']['participantFrontier'],finalTarget={'number':27766713,'hash':None,'timestamp':None},windows=[{'fromInclusive':27762617,'targetNumber':27766713,'newBlockSpan':4096}])
        a['initial']['participant']['base']=plan['base'];put(job/'PLAN.json',plan);a['planSha256']=sha(raw(job/'PLAN.json'))
        put(job/'FRONTIER.json',dict(completedWindows=0,pin=plan['base']))
    for n,h in policy['packetHashes'].items():
        dest=fixture/n;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw(T/n));assert sha(raw(dest))==h
    plan=dict(commit='SYNTHETIC',runtimeFiles=runtime,inputFiles={});put(fixture/'FROZEN_PLAN.json',plan)
    review=dict(verdict='PASS',syntheticFixture=True,candidateCommit='SYNTHETIC',planSha256=sha(raw(fixture/'FROZEN_PLAN.json')));put(fixture/'evidence/PREFLIGHT_REVIEW.json',review)
    ready=dict(status='PASS',syntheticFixture=True,actualPairedRegistry=True,freshProcess=True,runtimeHash=sha(authority.canonical(runtime)),pid=os.getpid(),readyAtUtc=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat());put(fixture/'evidence/READY.json',ready)
    pre=dict(verdict='PASS',taskId=policy['task'],taskRoot=str(fixture),synthetic=False,syntheticFixture=True,runtimeFiles=runtime,scopeSha256=a['scopeSha256'],reviewSha256=sha(raw(fixture/'evidence/PREFLIGHT_REVIEW.json')),readySha256=sha(raw(fixture/'evidence/READY.json')));put(fixture/'PREFLIGHT.json',pre)
    a['preflightSha256']=sha(raw(fixture/'PREFLIGHT.json'))
    ready['readyAtUtc']=__import__('datetime').datetime.fromtimestamp(start-1,__import__('datetime').timezone.utc).isoformat();put(fixture/'evidence/READY.json',ready)
    pre['readySha256']=sha(raw(fixture/'evidence/READY.json'));put(fixture/'PREFLIGHT.json',pre);a['preflightSha256']=sha(raw(fixture/'PREFLIGHT.json'))
    marker=dict(taskId=policy['task'],output=str(fixture/'session'),nonce=a['parentNonce'],preflightSha256=a['preflightSha256'],scopeSha256=a['scopeSha256'],synthetic=False,syntheticFixture=True,startsAt=start,admissionEndsAt=start+1200,expiresAt=start+2400,sourceBindingSha256=a['sourceBindingSha256'],clockOrigin={'pid':os.getpid()});put(fixture/'PUBLIC_ADMISSION.json',marker)
    put(fixture/'session/CONFIG.json',config);put(job/'ADMISSION.json',a)
    protocol='http' if family=='trade' else 'rpc';totals={k:dict(attempts=0,bytes=0,objects=0,extras=0) for k in ('http','graph','rpc')};totals[protocol]['attempts']=1
    pending=dict(id=1,nonce='c'*64,job=a['job'],attempt=1,requestPath=str(request),requestSha256=sha(raw(request)),expiresAt=start+30)
    state=dict(status='RUNNING',activation=a['activation'],sourceBinding=a['sourceBindingSha256'],configSha256=a['parentProfileSha256'],pending=pending,totals=totals,endpointAttempts=dict(rpc=[int(family!='trade'),0],graph=[0,0]),startedByFamily={f:int(f==family) for f in policy['public']['families']},active=[dict(id=a['job'],admissionHash=sha(raw(job/'ADMISSION.json')))])
    put(fixture/'session/OPERATING_STATE.json',state)
    accounting=dict(status='ADMITTED',attempts=1,rpcEndpointAttempts=[1,0],graphAttempts=0,rpcAttempts=1,pending={('request' if family=='trade' else 'requestPath'):str(request)})
    put(job/'ACCOUNTING.json',accounting)
    if case=='expired':state['pending']['expiresAt']=start-1;put(fixture/'session/OPERATING_STATE.json',state)
    if case=='tampered-permit':state['pending']['requestSha256']='0'*64;put(fixture/'session/OPERATING_STATE.json',state)
    if case=='synthetic-live':a['synthetic']=True;put(job/'ADMISSION.json',a)
    if case=='changed-config':config['aggregate']['attempts']+=1;put(fixture/'session/CONFIG.json',config)
    if case=='missing-loaded':ready['actualPairedRegistry']=False;put(fixture/'evidence/READY.json',ready)
    if case=='changed-source':a['runtimeFiles']['scripts/unified-refresh/worker.py']='0'*64;put(job/'ADMISSION.json',a)
    if case=='foreign-root':authority.POLICY={**policy,'root':str(fixture/'foreign')}
    reached=[];orig=importlib.machinery.SourceFileLoader.exec_module
    def exec_module(loader,m):
        orig(loader,m)
        if m.__name__ in ('bound_feed_worker','bounded_get'):
            def response_only(*args,**kwargs):
                reached.append(dict(module=m.__name__,args=[str(x)[:250] for x in args[:3]]))
                # Deliberately no socket, no data qualification, no fabricated close.
            m.perform=response_only
    importlib.machinery.SourceFileLoader.exec_module=exec_module
    entry=W/('scripts/trade-feed/worker.py' if family=='trade' else 'scripts/unified-refresh/worker.py')
    sys.argv=[str(entry),str(request)] if family=='trade' else [str(entry),str(request),str(request.parent/'response.body'),str(request.parent/'transport.json'),a['nonce']]
    failure=None
    try:load('actual_worker_entry',entry).main()
    except BaseException as e:failure=type(e).__name__+': '+str(e)
    finally:importlib.machinery.SourceFileLoader.exec_module=orig
    if case=='pass':assert len(reached)==1 and failure is None,(family,reached,failure)
    else:assert not reached and failure,(family,case,reached,failure)
    return dict(family=family,case=case,status='PASS',actualEntry=str(entry.relative_to(W)),responseIoReached=bool(reached),refusal=failure,networkRequests=0,realBaseAdmissions=0)

if __name__=='__main__':
    if len(sys.argv)==4:
        result=worker_case(Path(sys.argv[1]),sys.argv[2],sys.argv[3]);print(json.dumps(result));sys.exit(0)
    base=T/'fixtures'/('actual-live-entry-'+uuid.uuid4().hex);base.mkdir()
    cases=[(f,'pass') for f in ('trade','market','gas','protocol','participants')]+[('trade',c) for c in ('expired','tampered-permit','synthetic-live','changed-config','missing-loaded','changed-source','foreign-root')]
    results=[]
    for f,c in cases:
        r=subprocess.run([sys.executable,'-I','-S',__file__,str(base),f,c],stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=40)
        result=dict(family=f,case=c,exit=r.returncode,stdout=r.stdout,stderr=r.stderr)
        results.append(result);put(base/'RESULTS.json',results)
        if r.returncode:raise AssertionError(result)
    print(json.dumps(dict(status='PASS',fixture=str(base),cases=len(results),networkRequests=0,baseAdmissions=0)))
