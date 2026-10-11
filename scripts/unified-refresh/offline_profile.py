"""Exact offline subdivision. This is never a public admission mechanism."""
import re,time
from pathlib import Path
from durable import strict_json, save, digest

TASK = 'HDD-UNIFIED-REFRESH-INTEGRATION-R2'
PROFILE = 'unified-five-feed-offline-1'

def admitted(a):
    from operating_bridge import admitted as operating_admitted
    if operating_admitted(a):return True
    from public_profile import is_public
    if is_public(a):return True
    if 'unifiedProfileId' not in a:return False
    if (a.get('unifiedProfileId') != PROFILE or a.get('authorityTaskId') != TASK
            or a.get('synthetic') is not True or a.get('parentMode') != 'OFFLINE_ONLY'
            or not re.fullmatch('[a-f0-9]{64}',a.get('parentProfileSha256',''))):
        raise ValueError('Exact offline profile authority required')
    return True

def parent_limits(a, legacy):
    return a['parentLimits'] if admitted(a) else legacy

def closed_frame(root,result):
    raw=(Path(root)/'RESULT.json').read_bytes()
    if not 0<len(raw)<=524288 or strict_json(raw)!=result:raise ValueError('Closed result identity/bound')
    return dict(type='closed',resultBytes=len(raw),resultSha256=digest(raw))

class TradeParent:
    """Same durable single physical slot; GET charges remain conservative."""
    def __init__(self,root,a,clock,sleep,wall=None):
        if not admitted(a) or a['family']!='trade':raise ValueError('Offline trade parent required')
        self.root=Path(root);self.a=a;self.clock=clock;self.sleep=sleep;self.wall=wall or clock
        self.file=self.root.parent/'PARENT_ACCOUNTING.json'
        for name in ('parent-reservations','parent-settlements'):(self.root/name).mkdir()
    def read(self):return strict_json(self.file.read_bytes())
    def write(self,p):
        from combined import atomic
        atomic(self.file,p)
    def before(self,q):
        if 'operatingFormat' in self.a:
            from operating_bridge import current
            request=self.root/f"{q['attempt']:02d}"/'request.json'
            answer=current().permit(request,q,q['attempt'],q['retryOrdinal'],2162688,20000,
                                    min(self.wall()+30,self.a['networkClosesAtUnixSeconds']-65))
            save(self.root/'parent-reservations'/f"{q['attempt']:05d}.json",answer)
            return
        p=self.read();a=self.a;b=a['allowance'];lim=a['parentLimits']
        if (p['status']!='ADMITTED' or p['job']!=a['job'] or p['pending'] is not None
                or p['jobAdmissionSha256']!=digest((self.root/'ADMISSION.json').read_bytes())):
            raise ValueError('Parent GET slot/admission unknown')
        if p.get('lastClosedMonotonic') is not None:self.sleep(max(0,1-(self.clock()-p['lastClosedMonotonic'])))
        if self.wall()+65>=min(p['networkClosesAtUnixSeconds'],a['networkClosesAtUnixSeconds']):
            raise ValueError('Parent GET closure reserve')
        n=q['attempt'];extra=q['retryOrdinal']
        # Remaining child and parent bounds are both enforced before dispatch.
        if n>b['httpAttempts'] or n*2162688>b['httpChargedBytes']:
            raise ValueError('Child GET budget')
        p['attempts']+=1;p['httpAttempts']+=1;p['extraAttempts']+=extra;p['httpExtras']+=extra
        p['httpChargedBytes']+=2162688;p['chargedEntities']+=20000
        if (p['attempts']>lim['attempts'] or p['httpAttempts']>lim['httpAttempts']
                or p['httpExtras']>lim['httpExtras'] or p['extraAttempts']>lim['extras']
                or p['httpChargedBytes']>lim['httpChargedBytes'] or p['chargedEntities']>lim['chargedEntities']
                or sum(p[k+'ChargedBytes'] for k in ('graph','rpc','http'))>lim['chargedBytes']):
            raise ValueError('Parent GET budget')
        p['pending']=dict(job=a['job'],attempt=n,bytes=2162688,objects=20000,startedMonotonic=self.clock())
        self.write(p);save(self.root/'parent-reservations'/f'{n:05d}.json',p)
    def after(self,row):
        if 'operatingFormat' in self.a:
            from operating_bridge import current
            answer=current().settle(row['attempt'],row['closed'],row['complete'],2162688,row['chargedObjects'])
            save(self.root/'parent-settlements'/f"{row['attempt']:05d}.json",answer)
            return
        p=self.read();pending=p['pending']
        if not pending or pending['job']!=self.a['job'] or pending['attempt']!=row['attempt']:
            raise ValueError('Parent GET settlement mismatch')
        p['chargedEntities']+=row['chargedObjects']-pending['objects']
        p['observedBytes']+=row['wireBytes']+row['headerBytes']
        p['returnedEntities']+=row['chargedObjects'] if row['complete'] else 0
        p['unknownEntityReservations']+=0 if row['complete'] else row['chargedObjects']
        if row['closed']:p['pending']=None;p['lastClosedMonotonic']=self.clock()
        else:p['status']='CLOSURE_OR_ACCOUNTING_UNKNOWN'
        self.write(p);save(self.root/'parent-settlements'/f"{row['attempt']:05d}.json",p)
