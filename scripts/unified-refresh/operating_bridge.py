"""Exact offline operating IPC. Only the coordinator owns global liabilities.

No network activation or cookie/credential behavior is introduced here.
"""
import sys,json,queue,threading,hashlib,re,time
from pathlib import Path
TASK='HDD-REPEATABLE-REFRESH-OPERATIONS-R1'
FORMAT='unified-operating-offline-1'
_bridge=None

def admitted(a):
    if 'operatingFormat' not in a:return False
    from operating_authority import live,boundary,POLICY
    if live(a):return True
    if boundary(a):
        if a.get('authorityTaskId')!=POLICY['task'] or a.get('synthetic') is not True or a.get('parentMode')!='DENIED_NETWORK_TEST' or a.get('clockMode')!='REAL_EPOCH' or a.get('family') not in POLICY['public']['childAllowances'] or POLICY['public']['families'][a['family']].get('enabled') is False:raise ValueError('Exact denied operating mode')
        return True
    if (a['operatingFormat']!=FORMAT or a.get('authorityTaskId')!=TASK or a.get('synthetic') is not True
        or a.get('parentMode')!='OFFLINE_ONLY' or not re.fullmatch(r'[a-f0-9]{64}',a.get('parentProfileSha256',''))
        or not re.fullmatch(r'[a-f0-9]{64}',a.get('sourceBindingSha256',''))
        or not re.fullmatch(r'[a-z]+-[0-9]{8}',a.get('job',''))):raise ValueError('Exact operating offline binding')
    return True

class Bridge:
    def __init__(self,root,a,clock):
        if not admitted(a):raise ValueError('Offline operating admission required')
        self.root=Path(root);self.a=a;self.clock=clock;self.ordinal=0;self.pending=None
        self.incoming=queue.Queue();self.admission_hash=hashlib.sha256((self.root/'ADMISSION.json').read_bytes()).hexdigest()
        def reader():
            try:
                for line in sys.stdin:
                    if len(line)>32768:raise ValueError('IPC bound')
                    self.incoming.put(json.loads(line))
            finally:self.incoming.put(None)
        threading.Thread(target=reader,daemon=True).start()
    def exchange(self,kind,**fields):
        self.ordinal+=1
        message=dict(type='operating-'+kind,activation=self.a['activation'],job=self.a['job'],
          admissionSha256=self.admission_hash,ordinal=self.ordinal,**fields)
        print(json.dumps(message,separators=(',',':')),flush=True)
        # The pipe reader reports EOF immediately. A live wait can exceed 120s,
        # but may never survive the originally admitted job/activation deadline.
        if hasattr(self.clock,'epoch'):
            deadline=min(self.a['deadlineUnixSeconds'],self.a['activationExpiresAt'])
            while True:
                remaining=deadline-self.clock.epoch()
                if remaining<=0:raise ValueError('Operating IPC original deadline')
                try:answer=self.incoming.get(timeout=min(1,remaining));break
                except queue.Empty:continue
        else:answer=self.incoming.get(timeout=120)
        if not isinstance(answer,dict) or answer.get('ok') is not True:raise ValueError('Operating owner refused: '+str(answer))
        if hasattr(self.clock,'epoch'):
            if abs(answer['now']-self.clock.epoch())>2:raise ValueError('Operating IPC clock disagreement')
        else:
            if answer['now']<self.clock.n:raise ValueError('Operating clock regression')
            self.clock.n=answer['now']
        return answer
    def sleep(self,seconds):
        if seconds>0:self.exchange('wait',seconds=seconds)
    def permit(self,request,q,attempt,ordinal,size,objects,expires,reserved=None):
        if self.pending is not None:raise ValueError('Unsettled operating permit')
        raw=Path(request).read_bytes();kind='http' if q.get('method')=='GET' else 'rpc' if q['kind']=='rpc' else 'graph'
        answer=self.exchange('permit',requestPath=str(Path(request).resolve()),requestSha256=hashlib.sha256(raw).hexdigest(),
          querySha256=hashlib.sha256(json.dumps(q,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
          protocol=kind,endpoint=str(q.get('url',q.get('endpoint'))),attempt=attempt,retry=ordinal,bytes=size,objects=objects,
          expiresAt=expires,reserved=reserved)
        p=answer['permit']
        now=self.clock.epoch() if hasattr(self.clock,'epoch') else self.clock()
        if p['job']!=self.a['job'] or p['requestSha256']!=hashlib.sha256(raw).hexdigest() or p['attempt']!=attempt or p['expiresAt']<=now:raise ValueError('Invalid operating permit')
        self.pending=p;return answer
    def settle(self,attempt,closed,complete,size,objects):
        p=self.pending
        if not p or p['attempt']!=attempt:raise ValueError('Operating settlement identity')
        receipt=Path(p['requestPath']).parent/('AUDIT.json' if self.a['family']=='trade' else 'capture.json')
        answer=self.exchange('settle',permitId=p['id'],nonce=p['nonce'],attempt=attempt,closed=closed,complete=complete,bytes=size,objects=objects,
                             receiptSha256=hashlib.sha256(receipt.read_bytes()).hexdigest())
        if closed:self.pending=None
        return answer

def initialize(root,a,clock):
    global _bridge
    if _bridge is not None:raise ValueError('Operating bridge already initialized')
    _bridge=Bridge(root,a,clock);return _bridge
def current():
    if _bridge is None:raise ValueError('No offline operating owner')
    return _bridge

def initialize_real(root,a):
    from operating_authority import ProcessClock,live,boundary,validate
    if live(a):validate(a,root)
    elif not boundary(a):raise ValueError('Real clock operating mode required')
    clock=ProcessClock();bridge=initialize(root,a,clock)
    with (Path(root)/'PROCESS_CLOCK.json').open('x',encoding='utf-8') as f:json.dump(clock.origin,f)
    return bridge

def native_closure(request,root,a,life,now):
    # Avoid the family modules named worker.py shadowing the shared closure code.
    import importlib.util
    spec=importlib.util.spec_from_file_location('operating_native_closure',Path(__file__).with_name('worker.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.record_native_closure(request,root,a,life,now)
