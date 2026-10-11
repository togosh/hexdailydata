"""Exact finite operating authority; denied-boundary fixtures never permit sockets."""
import hashlib,json,time,os,re,math,datetime
from pathlib import Path
REPO=Path(__file__).resolve().parents[2]
POLICY=json.loads((REPO/'config/repeatable-operating-public-1.json').read_bytes())
LIVE=POLICY['format'];BOUNDARY='unified-operating-denied-boundary-1'
def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def live(a):
    if a.get('operatingFormat')!=LIVE:return False
    if a.get('authorityTaskId')!=POLICY['task'] or a.get('synthetic') is not False or a.get('parentMode')!='OWNER_AUTHORIZED_PUBLIC':raise ValueError('Exact live operating mode')
    return True
def boundary(a):return a.get('operatingFormat')==BOUNDARY

def bounded_config(start):
    p=POLICY['public']
    return dict(format=LIVE,mode='OWNER_AUTHORIZED_PUBLIC',startsAt=start,expiresAt=start+2400,
        admissionEndsAt=start+1200,dispatchEndsAt=start+2220,
        families={f:dict(enabled=True,period=v['periodSeconds'],deadline=v['deadlineSeconds']) for f,v in p['families'].items()},
        total=p['protocolReservationLimits'],rolling=p['rolling'],storage=dict(bytes=4294967296,entries=100000,jobs=37),
        participants=dict(maximumWindowBlocks=4096,maximumActivationBlocks=4096),
        maximumJobsByFamily={f:v['maximumJobs'] for f,v in p['families'].items()},
        aggregate=dict(attempts=1376,bytes=503316480,objects=3100000))

def validate_counters(a,state,config):
    p=POLICY['public'];limits={}
    for kind,b in p['protocolReservationLimits'].items():
        limits.update({kind+'Attempts':b['attempts'],kind+'Extras':b['extras'],kind+'ChargedBytes':b['bytes']})
        bucket=state['totals'][kind]
        if set(bucket)!=set(b) or any(type(bucket[k]) is not int or not 0<=bucket[k]<=b[k] for k in b):raise ValueError('Operating durable counters')
    limits.update(attempts=1376,extras=166,chargedBytes=503316480,chargedEntities=3100000)
    if a['parentLimits']!=limits:raise ValueError('Operating parent limits')
    for key,limit in config['aggregate'].items():
        if sum(v[key] for v in state['totals'].values())>limit:raise ValueError('Operating aggregate counters')
    for kind in ('rpc','graph'):
        values=state['endpointAttempts'][kind]
        if len(values)!=2 or any(type(v) is not int or not 0<=v<=p['endpointAttemptLimits'][kind][i] for i,v in enumerate(values)) or sum(values)!=state['totals'][kind]['attempts']:raise ValueError('Operating endpoint counters')
    if (not re.fullmatch('[a-f0-9]{64}',a.get('nonce','')) or not re.fullmatch('[a-f0-9]{64}',a.get('parentNonce',''))
        or a.get('scopeSha256')!=POLICY['packetHashes']['packet/SCOPE.json'] or a.get('clockMode')!='REAL_EPOCH'
        or a.get('activationExpiresAt')!=config['expiresAt']):raise ValueError('Operating child identity/clock')
    if set(state['startedByFamily'])!=set(p['families']) or any(type(n) is not int or not 0<=n<=p['families'][f]['maximumJobs'] for f,n in state['startedByFamily'].items()):raise ValueError('Operating job count')

class ProcessClock:
    """Only epoch values cross processes. Native timeout values stay local."""
    def __init__(self,wall=time.time,mono=time.monotonic):
        self.wall=wall;self.mono=mono;self.origin={'unixSeconds':wall(),'monotonicSeconds':mono(),'pid':os.getpid()};self.last=self.origin['monotonicSeconds']
    def __call__(self):
        n=self.mono();epoch=self.origin['unixSeconds']+n-self.origin['monotonicSeconds']
        if n<self.last or abs(self.wall()-epoch)>2:raise ValueError('Operating clock discontinuity')
        self.last=n;return n
    def epoch(self):return self.to_epoch(self())
    def to_epoch(self,n):return self.origin['unixSeconds']+n-self.origin['monotonicSeconds']
    def to_mono(self,n):return self.origin['monotonicSeconds']+n-self.origin['unixSeconds']

def validate(a,root,request=None):
    root=Path(root).resolve();base=Path(POLICY['root'])
    if not live(a) or root!=base/'session'/a['job'] or a['jobRoot']!=str(root):raise ValueError('Exact live operating root')
    def raw(n):return (base/n).read_bytes()
    def read(n):return json.loads(raw(n))
    for p,h in POLICY['packetHashes'].items():
        if digest(raw(p))!=h:raise ValueError('Operating packet changed')
    pre=read('PREFLIGHT.json');plan=read('FROZEN_PLAN.json');review=read('evidence/PREFLIGHT_REVIEW.json');ready=read('evidence/READY.json');marker=read('PUBLIC_ADMISSION.json');state=read('session/OPERATING_STATE.json')
    if (pre['verdict']!='PASS' or review['verdict']!='PASS' or review['candidateCommit']!=plan['commit'] or review['planSha256']!=digest(raw('FROZEN_PLAN.json'))
        or pre['reviewSha256']!=digest(raw('evidence/PREFLIGHT_REVIEW.json')) or pre['readySha256']!=digest(raw('evidence/READY.json'))
        or digest(raw('PREFLIGHT.json'))!=a['preflightSha256'] or a['runtimeFiles']!=plan['runtimeFiles'] or pre['runtimeFiles']!=plan['runtimeFiles']
        or ready['status']!='PASS' or ready['actualPairedRegistry'] is not True or ready['freshProcess'] is not True or ready['runtimeHash']!=digest(canonical(plan['runtimeFiles']))):raise ValueError('Operating loaded/preflight binding')
    if (marker['taskId']!=POLICY['task'] or marker['output']!=str(base/'session') or marker['nonce']!=a['parentNonce'] or marker['preflightSha256']!=a['preflightSha256']
        or marker['scopeSha256']!=POLICY['packetHashes']['packet/SCOPE.json'] or marker['synthetic'] is not False or state['activation']!=a['activation']
        or state['status']!='RUNNING' or state['configSha256']!=a['parentProfileSha256'] or state['sourceBinding']!=a['sourceBindingSha256']):raise ValueError('Operating owner binding')
    start=marker['startsAt'];config=read('session/CONFIG.json');p=POLICY['public']
    if (not isinstance(start,(int,float)) or not math.isfinite(start) or config!=bounded_config(start)
        or digest(json.dumps(config,separators=(',',':')).encode())!=state['configSha256']):raise ValueError('Operating original clock/config')
    validate_counters(a,state,config)
    if (pre.get('taskId')!=POLICY['task'] or pre.get('taskRoot')!=str(base) or pre.get('synthetic') is not False
        or pre.get('scopeSha256')!=POLICY['packetHashes']['packet/SCOPE.json'] or marker.get('sourceBindingSha256')!=a['sourceBindingSha256']
        or marker.get('admissionEndsAt')!=config['admissionEndsAt'] or marker.get('expiresAt')!=config['expiresAt']):raise ValueError('Operating scope/owner document')
    ready_at=datetime.datetime.fromisoformat(ready['readyAtUtc'].replace('Z','+00:00')).timestamp()
    if (not 0<=start-ready_at<120 or ready['pid']!=marker['clockOrigin']['pid']
        or digest(canonical(a['runtimeFiles']))!=a['sourceBindingSha256']):raise ValueError('Operating fresh owner/source binding')
    if (a['allowance']!=p['childAllowances'][a['family']] or not start<=a['startedAtUnixSeconds']<start+1200
        or a['deadlineUnixSeconds']!=a['startedAtUnixSeconds']+a['allowance']['seconds'] or a['deadlineUnixSeconds']>start+2400
        or a['networkClosesAtUnixSeconds']!=min(start+2220,a['deadlineUnixSeconds']-a['allowance']['publication']-5)
        or time.time()>=a['networkClosesAtUnixSeconds']):raise ValueError('Operating fixed bounds')
    if not any(j['id']==a['job'] and j['admissionHash']==digest((root/'ADMISSION.json').read_bytes()) for j in state['active']):raise ValueError('Operating registered child')
    for name,h in plan['inputFiles'].items():
        if digest(raw(name))!=h:raise ValueError('Operating input changed')
    if a['family']=='participants':
        planraw=(root/'PLAN.json').read_bytes();q=json.loads(planraw);pin=p['participant']
        if (digest(planraw)!=a['planSha256'] or q['base']!=POLICY['selection']['participantFrontier'] or q['finalTarget']!={'number':pin['to'],'hash':None,'timestamp':None}
            or q['windows']!=[{'fromInclusive':pin['from'],'targetNumber':pin['to'],'newBlockSpan':4096}]):raise ValueError('Operating fixed participant window')
    if request is not None:
        pending=state['pending']
        if not pending or pending['job']!=a['job'] or pending['requestPath']!=str(Path(request).resolve()):raise ValueError('Operating physical reservation')
    return state
