"""Exact public qualification authority, independent of all consumed grants."""
import json,re,time,datetime,math,sys
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'market-refresh'))
from durable import strict_json,digest

TASK='HDD-UNIFIED-REFRESH-PUBLIC-QUALIFICATION-R2'
PROFILE='unified-five-feed-public-qualification-2'
ROOT=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\unified-refresh-public-qualification-r2')
PROFILE_HASH='4be3bc10f5702140177c7753e6d5281d8c766a821f82ea6c55728ea95bde17c4'
PACKET={'packet/SCOPE.json':'74da822b99a6fab67e859044d0f6ea3efac43f6fcd0afb64abec96c9d9bec8c5',
        'packet/INPUTS.json':'15ba1c74180836f3a2126017819a2832b9b134438762d8d569b3bd260dc3eb03',
        'packet/PUBLIC_PROFILE.json':'3f1b44f0fe4719d893f9bcfabc4f3d72f6d789c1b9b2df496f87a7b8eee5bbad'}
def canonical_hash(value):return digest(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())
def is_public(a):
    if a.get('unifiedProfileId')!=PROFILE:return False
    if (a.get('authorityTaskId')!=TASK or a.get('synthetic') is not False or a.get('parentMode')!='OWNER_AUTHORIZED_PUBLIC'
        or a.get('parentProfileSha256')!=PROFILE_HASH or not re.fullmatch('[a-f0-9]{64}',a.get('parentNonce',''))
        or not re.fullmatch('[a-f0-9]{64}',a.get('preflightSha256',''))):raise ValueError('Exact public child authority')
    return True

def validate_documents(a,root,profile,marker,pre,ready,review,plan,parent):
    if not is_public(a) or root!=ROOT/'session'/a['job'] or a['jobRoot']!=str(root):raise ValueError('Exact public root')
    if canonical_hash(profile)!=PROFILE_HASH or profile['format']!=PROFILE or profile['mode']!='OWNER_AUTHORIZED_PUBLIC':raise ValueError('Exact public profile')
    jobs=[j for j in profile['jobs'] if j['id']==a['job']]
    if len(jobs)!=1 or jobs[0]['family']!=a['family'] or not jobs[0]['enabled']:raise ValueError('Public job binding')
    job=jobs[0]
    if a.get('scopeSha256')!=PACKET['packet/SCOPE.json'] or not re.fullmatch('[a-f0-9]{64}',a.get('nonce','')):raise ValueError('Public scope/child nonce')
    if a['parentLimits']!=profile['parent'] or parent['limits']!=profile['parent']:raise ValueError('Public parent limits')
    if set(a['allowance'])!=set(job['bounds']) or any(type(a['allowance'][k]) not in (int,float) or not math.isfinite(a['allowance'][k]) or a['allowance'][k]<0 or a['allowance'][k]>v for k,v in job['bounds'].items()):raise ValueError('Public child limits')
    if a['allowance']['publication']!=job['bounds']['publication']:raise ValueError('Public publication reserve')
    if a['family']=='trade' and a.get('tradeSlot')!=job['tradeSlot']:raise ValueError('Public trade slot')
    if (marker['taskId']!=TASK or marker['output']!=str(ROOT/'session') or marker['synthetic'] is not False
        or marker['nonce']!=a['parentNonce'] or marker['preflightSha256']!=a['preflightSha256']
        or marker['scopeSha256']!=PACKET['packet/SCOPE.json'] or marker['profileSha256']!=PROFILE_HASH):raise ValueError('Public marker binding')
    if (pre['taskId']!=TASK or pre['taskRoot']!=str(ROOT) or pre['synthetic'] is not False or pre['verdict']!='PASS'
        or pre['profileSha256']!=PROFILE_HASH or pre['scopeSha256']!=PACKET['packet/SCOPE.json']
        or pre['runtimeFiles']!=plan['runtimeFiles'] or a['runtimeFiles']!=plan['runtimeFiles']
        or review['verdict']!='PASS' or review['candidateCommit']!=plan['commit']
        or ready['status']!='PASS' or ready['actualPairedRegistry'] is not True or ready['freshProcess'] is not True
        or ready['runtimeHash']!=canonical_hash(plan['runtimeFiles'])):raise ValueError('Public preflight/loaded binding')
    if (parent['taskId']!=TASK or parent['status']!='ADMITTED' or parent['job']!=a['job'] or parent['nonce']!=a['parentNonce']
        or parent['profileSha256']!=PROFILE_HASH or parent['preflightSha256']!=a['preflightSha256']):raise ValueError('Public parent binding')
    for key in ('graphAttempts','rpcAttempts','httpAttempts','graphExtras','rpcExtras','httpExtras','attempts','chargedEntities'):
        if type(parent[key]) is not int or parent[key]<0 or parent[key]>profile['parent'][key]:raise ValueError('Public parent counters')
    if parent['attempts']!=sum(parent[k+'Attempts'] for k in ('graph','rpc','http')) or parent['extraAttempts']!=sum(parent[k+'Extras'] for k in ('graph','rpc','http')):raise ValueError('Public counter arithmetic')
    if len(parent['rpcEndpointAttempts'])!=2 or any(type(v) is not int or v<0 for v in parent['rpcEndpointAttempts']) or sum(parent['rpcEndpointAttempts'])!=parent['rpcAttempts']:raise ValueError('Public endpoint counters')
    if parent['extraAttempts']>profile['parent']['extras'] or max(parent['rpcEndpointAttempts'])>profile['parent']['rpcAttempts']//2:raise ValueError('Public extras/endpoints')
    if any(type(parent[k+'ChargedBytes']) is not int or parent[k+'ChargedBytes']<0 or parent[k+'ChargedBytes']>profile['parent'][k+'ChargedBytes'] for k in ('graph','rpc','http')) or sum(parent[k+'ChargedBytes'] for k in ('graph','rpc','http'))>profile['parent']['chargedBytes']:raise ValueError('Public bytes')
    start=datetime.datetime.fromisoformat(parent['startedAt'].replace('Z','+00:00')).timestamp()
    if abs(parent['networkClosesAtUnixSeconds']-(start+profile['parent']['seconds']-profile['parent']['closingReserve']))>.01 or a['deadlineUnixSeconds']>start+job['deadline']+.01:raise ValueError('Original public clock binding')
    if a['deadlineUnixSeconds']>parent['networkClosesAtUnixSeconds'] or a['networkClosesAtUnixSeconds']>a['deadlineUnixSeconds']-a['allowance']['publication']-5:raise ValueError('Public deadline binding')

def validate_authority(a,root,request=None):
    root=Path(root).resolve()
    def raw(name):return (ROOT/name).read_bytes()
    def read(name):return strict_json(raw(name))
    for name,h in PACKET.items():
        if digest(raw(name))!=h:raise ValueError('Public packet changed')
    pre=read('PREFLIGHT.json');plan=read('FROZEN_PLAN.json');ready=read('evidence/READY.json');review=read('evidence/PREFLIGHT_REVIEW.json')
    if (digest(raw('PREFLIGHT.json'))!=a['preflightSha256'] or digest(raw('evidence/READY.json'))!=pre['readySha256']
        or digest(raw('evidence/PREFLIGHT_REVIEW.json'))!=pre['reviewSha256'] or digest(raw('FROZEN_PLAN.json'))!=review['planSha256']):raise ValueError('Public document digest')
    parent=read('session/PARENT_ACCOUNTING.json')
    validate_documents(a,root,read('packet/PUBLIC_PROFILE.json'),read('PUBLIC_ADMISSION.json'),pre,ready,review,plan,parent)
    if digest((root/'ADMISSION.json').read_bytes())!=parent['jobAdmissionSha256']:raise ValueError('Public exclusive child')
    for name,h in plan['inputFiles'].items():
        if digest(raw(name))!=h:raise ValueError('Public input changed')
    if time.time()>=min(parent['networkClosesAtUnixSeconds'],a['networkClosesAtUnixSeconds']):raise ValueError('Public dispatch expired')
    if a['family']=='participants':
        p=strict_json((root/'PLAN.json').read_bytes())
        if digest((root/'PLAN.json').read_bytes())!=a['planSha256'] or p['base']['number']!=27754425 or p['finalTarget']['number']!=27758521 or p['windows']!=[{'fromInclusive':27754425,'targetNumber':27758521,'newBlockSpan':4096}]:raise ValueError('Public fixed participant window')
    if request is not None:
        q=strict_json(Path(request).read_bytes());pending=parent['pending']
        if not pending or pending['job']!=a['job']:raise ValueError('Public physical reservation missing')
        if a['family']=='trade':
            if pending['attempt']!=q['attempt'] or q['nonce']!=a['nonce']:raise ValueError('Public GET reservation')
        elif pending['requestPath']!=str(Path(request).resolve()):raise ValueError('Public POST reservation')
    return parent
