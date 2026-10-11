"""Replay the saved remaining-time boundary without network or serving bases."""
import json, sys, tempfile, copy
from pathlib import Path
sys.dont_write_bytecode = True
W = Path(__file__).resolve().parents[2]
R = Path(sys.argv[1]).resolve()
sys.path[:0] = [str(W/'scripts/market-refresh')]
def deny(event, args):
    if event.startswith('socket.'):
        raise AssertionError('NETWORK_DENIED')
sys.addaudithook(deny)
from capture_client import WorkerTransport, LimitReached

cases = []
for operating, remaining in [(True, 2.120), (True, 3), (True, 3.001), (False, 2.120)]:
    root = Path(tempfile.mkdtemp(prefix='dispatch-', dir=R))
    request = root/'captures/00001/request.json'
    request.parent.mkdir(parents=True)
    request.write_text('{}', encoding='utf-8')
    calls = []
    class Child:
        pid = 1
        returncode = 0
        def wait(self, timeout): calls.append({'wait': timeout})
    def spawn(*args, **kwargs):
        calls.append({'spawn': True})
        return Child()
    # Setting the instance flag also permits this regression test against the
    # previous implementation, which lacked the operating dispatch check.
    worker = WorkerTransport('offline', clock=lambda: 100, popen=spawn)
    worker.operating = operating
    refused = False
    try:
        worker(request, 100+remaining, None)
    except LimitReached:
        refused = True
    expected = operating and remaining <= 3
    cases.append(dict(operating=operating, remainingSeconds=remaining,
                      refused=refused, expectedRefusal=expected, calls=calls))

# Compose the actual gas request, reservation, capture, ledger and enclosing
# no-dispatch emitter with the exact saved delay. Only permit IPC/time is injected.
sys.path[:0] = [str(W/'scripts/unified-refresh'), str(W/'scripts/gas-feed')]
from operating_authority import ProcessClock, POLICY
from combined import Combined, ParentTransport, LIMITS, GLOBAL, atomic
from session import GasSession
from protocol import job
from capture_client import Stop
from durable import digest, strict_json
import operating_bridge
root = Path(tempfile.mkdtemp(prefix='queued-gas-', dir=R))
child_root = root/'gas-00000001'
clock_value = [100.]
clock = ProcessClock(wall=lambda: 1791746853.5883424+clock_value[0], mono=lambda: clock_value[0])
limits = copy.deepcopy(LIMITS['gas'])
a = dict(task='HDD-UNIFIED-REFRESH-OPERATION-R1', family='gas', job=child_root.name,
         operatingFormat='unified-operating-denied-boundary-1', synthetic=True,
         authorityTaskId=POLICY['task'], parentMode='DENIED_NETWORK_TEST', clockMode='REAL_EPOCH',
         parentLimits={**GLOBAL},
         allowance=limits, deadlineMonotonic=700., networkSeconds=560., networkDeadline=660.,
         networkClosesAtUnixSeconds=clock.to_epoch(660.))
class Bound(Combined, GasSession): pass
s = Bound(child_root, None, clock, lambda n: clock_value.__setitem__(0,clock_value[0]+n), True)
s.configure(a, root)
class Bridge:
    pending = None
    def __init__(self): self.clock = clock
    def permit(self, path, q, attempt, ordinal, size, objects, expires, reserved):
        started = clock()
        clock_value[0] += 12.880
        self.pending = dict(id=1, job=a['job'], attempt=attempt, nonce='fixture',
            requestPath=str(path.resolve()), requestSha256=digest(path.read_bytes()),
            querySha256=digest(json.dumps(q,sort_keys=True,separators=(',',':')).encode()),
            protocol='rpc', endpoint=str(q['endpoint']), closureMode=a['operatingFormat'],
            bytes=size, objects=objects, at=clock.epoch(), expiresAt=expires)
        atomic(root/'OPERATING_STATE.json', dict(status='RUNNING',pending=self.pending))
        self.timing=dict(start=started, grant=clock(), originalDeadline=clock.to_mono(expires),
                        delaySeconds=clock()-started, usableWorkerSeconds=clock.to_mono(expires)-clock()-2)
        return dict(parentBefore={k:0 for k in GLOBAL}, permit=self.pending)
    def settle(self, attempt, closed, complete, size, objects):
        assert closed and not complete and size==1048576 and objects==128
        return dict(syntheticIpcOnly=True, closed=closed, complete=complete, bytes=size, objects=objects)
bridge=Bridge()
operating_bridge._bridge=bridge
def no_spawn(*args, **kwargs): raise AssertionError('QUEUED_REQUEST_MUST_NOT_SPAWN')
s.transport=ParentTransport(s,WorkerTransport('fixture',clock=clock,popen=no_spawn,operating=True))
try:
    s.request(job(0,'eth_getBlockByNumber',['latest',False],1,'head'))
except Stop as exc:
    assert str(exc)=='Unusable response: local_reserve_refusal'
else: raise AssertionError('Queued request accepted')
s.close('Synthetic queued refusal')
cap=strict_json((child_root/'captures/00001/capture.json').read_bytes())
assert cap['chargedBytes']==1048576 and cap['chargedEntities']==128
assert not cap['usable'] and not cap['retryable'] and not cap['childStarted']
assert cap['closureKnown'] and cap['closedWithinDeadline'] and s.state['pending'] is None
assert s.state['attempts']==1 and s.state['extraAttempts']==0
assert len((child_root/'LEDGER.jsonl').read_bytes().splitlines())==1
assert abs(bridge.timing['usableWorkerSeconds']-.120)<.00001
cases.append(dict(case='actual gas client after 12.880-second synthetic permit wait',
                  root=str(root), timing=bridge.timing, capture=cap, status='PASS'))

result = dict(status='PASS' if all(c.get('refused')==c.get('expectedRefusal') for c in cases) else 'FAIL',
              synthetic=True, networkRequests=0, baseAdmissions=0, cases=cases)
with (R/(sys.argv[2] if len(sys.argv)>2 else 'QUEUED_DISPATCH_CHECKS.json')).open('x', encoding='utf-8') as out:
    json.dump(result, out, indent=2)
print(json.dumps(result, indent=2))
raise SystemExit(0 if result['status']=='PASS' else 1)
