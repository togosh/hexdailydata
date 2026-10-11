"""Focused denied-network clock/queue/cancellation and actual Session lifecycle checks."""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
from unittest.mock import patch
import time,json,os,copy,queue,uuid,subprocess,io,contextlib
W=Path(__file__).resolve().parents[2];T=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\repeatable-refresh-public-qualification-r1')
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts/trade-feed'),str(W/'scripts/market-refresh')]
def deny(event,args):
    if event.startswith('socket.'):raise PermissionError('DENIED_NETWORK')
sys.addaudithook(deny)
from operating_authority import ProcessClock
from operating_bridge import Bridge
from client import Session,worker_native,native_window
from durable import save,strict_json,digest
if len(sys.argv)==3 and sys.argv[1]=='cancel-child':
    from operating_bridge import initialize_real
    root=Path(sys.argv[2]);b=initialize_real(root,strict_json((root/'ADMISSION.json').read_bytes()))
    try:b.sleep(300)
    except ValueError as e:
        assert 'owner refused' in str(e);print('CANCELLED_ON_OWNER_EOF');sys.exit(0)
    raise AssertionError('Unexpected wait completion')
R=T/'fixtures'/('time-checks-'+uuid.uuid4().hex);R.mkdir()
cases=[]
class Time:
    def __init__(self):self.wall=1791736000.;self.mono=42.
    def advance(self,n):self.wall+=n;self.mono+=n
for seconds in (240,300):
    t=Time();c=ProcessClock(wall=lambda:t.wall,mono=lambda:t.mono)
    assert c.to_epoch(50)==1791736008 and c.to_mono(1791736008)==50
    b=Bridge.__new__(Bridge);b.a=dict(activation='fixture',job='fixture',deadlineUnixSeconds=t.wall+600,activationExpiresAt=t.wall+2400);b.ordinal=0;b.admission_hash='0'*64;b.clock=c
    class Delayed:
        def get(self,timeout):
            t.advance(timeout)
            if t.mono<42+seconds:raise queue.Empty()
            return dict(ok=True,now=t.wall)
    b.incoming=Delayed()
    with contextlib.redirect_stdout(io.StringIO()):b.sleep(seconds)
    assert c()==42+seconds;cases.append(dict(case='virtual-IPC-wait',seconds=seconds,status='PASS'))
    b.incoming=queue.Queue();b.incoming.put(None);before=time.monotonic()
    try:
        with contextlib.redirect_stdout(io.StringIO()):b.sleep(300)
    except ValueError as e:assert 'owner refused' in str(e)
    else:raise AssertionError('EOF not cancelled')
    assert time.monotonic()-before<.1;cases.append(dict(case='owner-EOF-cancels-wait',seconds=seconds,status='PASS'))
    t.wall+=5
    try:c()
    except ValueError:pass
    else:raise AssertionError('Wall jump accepted')

template=strict_json((T/'fixtures/operating-native-boundary-ACloLq/operating/trade-00000001/ADMISSION.json').read_bytes())
for delay in (20,31):
    root=R/('queue-'+str(delay))/'trade-00000001';root.mkdir(parents=True);(root/'temp').mkdir()
    t=Time();a=copy.deepcopy(template);a.update(jobRoot=str(root),startedAtUnixSeconds=t.wall,deadlineUnixSeconds=t.wall+600,networkClosesAtUnixSeconds=t.wall+560)
    save(root/'ADMISSION.json',a);called=[];settled=[]
    class Parent:
        def before(self,q):
            request=root/f"{q['attempt']:02d}"/'request.json'
            p=dict(id=1,nonce='fixture',job=a['job'],attempt=1,requestPath=str(request),requestSha256=digest(request.read_bytes()),expiresAt=t.wall+30,bytes=2162688,objects=20000,closureMode=a['operatingFormat'])
            save(root.parent/'OPERATING_STATE.json',dict(pending=p))
            t.advance(delay);return p
        def after(self,row):settled.append(row)
    child=R/'no-network-child.py'
    if not child.exists():child.write_text("import sys\nsys.addaudithook(lambda e,a: (_ for _ in ()).throw(PermissionError('DENIED')) if e.startswith('socket.') else None)\nassert sys.stdin.buffer.read()==b''\n",encoding='utf-8')
    def runner(args,env,wait,reap):
        called.append((wait,reap));return worker_native([sys.executable,'-I','-S',str(child)],env,wait,reap)
    s=Session(root,a,runner=runner,mono=lambda:t.mono,wall=lambda:t.wall,sleep=t.advance,parent_accounting=Parent())
    try:s.get('https://www.bitstamp.net/api/v2/markets/','markets')
    except ValueError:pass
    else:raise AssertionError('Bodyless worker accepted')
    s.close('Expected focused local failure')
    assert len(settled)==1 and s.state['pending'] is None and s.state['chargedObjects']==20000 and s.state['chargedBytes']==2162688
    proof=strict_json((root/'01/PHYSICAL_CLOSED.json').read_bytes())
    if delay==20:
        assert called and 0<called[0][0]<=7.9 and called[0][1]==2
        assert proof['native']['childStarted'] and proof['native']['childReaped'] and proof['native']['workerPid']!=os.getpid()
    else:
        assert not called and proof['noChildStarted'] and proof['native']['workerPid'] is None
    cases.append(dict(case='actual-Session-delayed-permit',queueSeconds=delay,nativeWindows=called,fullChargeRetained=True,noChildStarted=proof['noChildStarted'],status='PASS'))
    if delay==20:
        from operating_bridge import native_closure
        failed=root/'receipt-failure'/'request.json';failed.parent.mkdir();failed.write_bytes((root/'01/request.json').read_bytes())
        p=copy.deepcopy(strict_json((root.parent/'OPERATING_STATE.json').read_bytes())['pending']);p['requestPath']=str(failed)
        save(root.parent/'OPERATING_STATE.json',dict(pending=p))
        token=dict(permit=p['id'],nonce=p['nonce'],job=a['job'],attempt=1,workerPid=proof['native']['workerPid'])
        save(failed.parent/'PHYSICAL_STARTED.json',token);(root.parent/'PHYSICAL_ACTIVE.lock').write_bytes((failed.parent/'PHYSICAL_STARTED.json').read_bytes())
        original_open=Path.open
        def fail_receipt(path,*args,**kwargs):
            if path==failed.parent/'PHYSICAL_CLOSED.json':raise OSError('SYNTHETIC_RECEIPT_WRITE_FAILURE')
            return original_open(path,*args,**kwargs)
        with patch.object(Path,'open',fail_receipt):
            try:native_closure(failed,root,a,proof['native'],t.wall)
            except OSError as e:assert 'SYNTHETIC_RECEIPT' in str(e)
            else:raise AssertionError('Receipt failure bypassed')
        assert (root.parent/'PHYSICAL_ACTIVE.lock').exists() and not (failed.parent/'PHYSICAL_CLOSED.json').exists()
        cases.append(dict(case='actual-reaped-worker-receipt-failure',status='PASS',protectionRetained=True,synthetic=True))

cancel=R/'cancel';cancel.mkdir();now=time.time();a=copy.deepcopy(template);a.update(jobRoot=str(cancel),deadlineUnixSeconds=now+600,activationExpiresAt=now+2400)
save(cancel/'ADMISSION.json',a)
child=subprocess.Popen([sys.executable,'-I','-S',__file__,'cancel-child',str(cancel)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
first=child.stdout.readline();assert json.loads(first)['type']=='operating-wait'
began=time.monotonic();child.stdin.close();child.stdin=None;out,err=child.communicate(timeout=3)
assert child.returncode==0 and 'CANCELLED_ON_OWNER_EOF' in out and time.monotonic()-began<3
cases.append(dict(case='actual-native-300s-wait-cancelled-by-owner-EOF',status='PASS',elapsedSeconds=time.monotonic()-began,childReaped=True,pid=child.pid))
save(R/'RESULT.json',dict(status='PASS',cases=cases,externalRequests=0,realBaseAdmissions=0))
print(json.dumps(dict(status='PASS',fixture=str(R),cases=len(cases),externalRequests=0,realBaseAdmissions=0)))
