"""Seven fixed jobs, one nonrenewable parent. Reuses the maintained physical client.

Control retry pools are deliberately smaller than old standalone trials. Every
mandatory control still has its first attempt reserved; no data retry may borrow
the control pool. Nominal child ceilings overlap and are clipped at admission.
"""
import copy, json, time, os
from pathlib import Path
from durable import strict_json, encode, digest, save, utc
from capture_client import Stop, LimitReached
from retry_policy import CLASSIFICATIONS
from offline_profile import parent_limits

TASK = 'HDD-UNIFIED-REFRESH-OPERATION-R1'
MIB = 1024**2
ORDER = ['market-1','gas-1','protocol-1','participants-1','market-2','gas-2','protocol-2']
WAITS = [15,60,120,240,300]
LIMITS = {
    'market': dict(graphAttempts=24,rpcAttempts=56,graphChargedBytes=2*MIB,rpcChargedBytes=2*MIB,chargedEntities=10000,graphExtras=4,rpcExtras=0,controlGraphExtras=1,controlRpcExtras=0,seconds=600,publication=35),
    'gas': dict(graphAttempts=0,rpcAttempts=24,graphChargedBytes=0,rpcChargedBytes=6*MIB,chargedEntities=20000,graphExtras=0,rpcExtras=2,controlGraphExtras=0,controlRpcExtras=0,seconds=600,publication=35),
    'protocol': dict(graphAttempts=0,rpcAttempts=28,graphChargedBytes=0,rpcChargedBytes=6*MIB,chargedEntities=10000,graphExtras=0,rpcExtras=4,controlGraphExtras=0,controlRpcExtras=0,seconds=600,publication=35),
    'participants': dict(graphAttempts=552,rpcAttempts=24,graphChargedBytes=60*MIB,rpcChargedBytes=2*MIB,chargedEntities=120000,graphExtras=52,rpcExtras=4,controlGraphExtras=2,controlRpcExtras=0,seconds=1800,publication=180),
}
GLOBAL = dict(graphAttempts=600,rpcAttempts=240,graphChargedBytes=64*MIB,rpcChargedBytes=16*MIB,chargedEntities=200000)

def read(path): return strict_json(Path(path).read_bytes())
def atomic(path, value):
    path=Path(path); stage=path.with_suffix('.pending')
    save(stage,value); os.replace(stage,path)
def protocol(q): return 'rpc' if q['kind']=='rpc' else 'graph'
def is_control(q, closing=False): return q.get('phase') in ('control','close','close-global') or closing
def counter_subset(s):
    return {k:copy.deepcopy(s[k]) for k in [*GLOBAL,'attempts','extraAttempts','rpcEndpointAttempts','retrySpent']}

def reserve(q, controls, ordinal, counters, limits, capacity, offset, network_end, closing=False, delay=0):
    """Worst legal shared control allocation, plus this query's ordinary extras.
    Sixty seconds per control extra is conservative even across a partially used
    retry pair. Slow extras reserve only themselves and all mandatory controls.
    """
    p=protocol(q); control=is_control(q,closing)
    pools=counters['retrySpent']
    slot=('control' if control else 'data')+p.title()
    cap=limits['control'+p.title()+'Extras'] if control else limits[p+'Extras']-limits['control'+p.title()+'Extras']
    needed=int(ordinal>0)
    if pools[slot]+needed>cap: raise LimitReached('Fixed '+slot+' retry pool exhausted')
    remaining=max(0,min(2-ordinal,cap-pools[slot]-needed))
    jobs=[q]+[q]*remaining+list(controls)
    # Protect the exact remaining control pool independently for each protocol.
    wait=sum(WAITS[ordinal:ordinal+remaining]) if ordinal<2 else 0
    for kind in ('graph','rpc'):
        candidates=[c for c in controls if protocol(c)==kind]
        if control and p==kind:candidates.append(q)
        extras=max(0,limits['control'+kind.title()+'Extras']-pools['control'+kind.title()]-(needed if control and p==kind else 0))
        if control and p==kind:extras=max(0,extras-remaining)
        extras=min(extras,2*len(candidates))
        if candidates and extras:
            # Independent maxima over capacities/objects protect any eligible allocation.
            largest=max(candidates,key=capacity)
            object_max=max(c['maxRows'] for c in candidates)
            jobs.extend([{**largest,'maxRows':object_max}]*extras)
            wait+=60*extras
    finish=offset+delay+31*len(jobs)+wait
    if finish>=network_end or finish+limits['publication']>=limits['seconds']:
        raise LimitReached('Combined mandatory controls/publication deadline reserve')
    needed_counts={k:0 for k in GLOBAL}
    eps=[0,0]
    for j in jobs:
        kind=protocol(j);needed_counts[kind+'Attempts']+=1
        needed_counts[kind+'ChargedBytes']+=capacity(j)
        needed_counts['chargedEntities']+=j['maxRows']
        if kind=='rpc':eps[j['endpoint']]+=1
    for k,n in needed_counts.items():
        if counters[k]+n>limits[k]:raise LimitReached('Combined child reserve '+k)
    if any(counters['rpcEndpointAttempts'][i]+eps[i] > limits['rpcAttempts']//2 for i in (0,1)):
        raise LimitReached('Combined child endpoint reserve')
    return dict(counts=needed_counts,endpointAttempts=eps,physicalAttempts=len(jobs),waitSeconds=wait,
                finishOffset=finish,publicationSeconds=limits['publication'],slot=slot,control=control)

def effective_limits(family,parent):
    out=copy.deepcopy(LIMITS[family])
    for k in GLOBAL:out[k]=min(out[k],GLOBAL[k]-parent[k])
    if any(out[k]<0 for k in GLOBAL):raise LimitReached('Parent already exhausted')
    return out

class Combined:
    """Mixin over Session/GasSession/ProtocolSession/ParticipantSession."""
    def configure(self, admission, parent_root):
        self.admission=admission;self.parent_root=Path(parent_root)
        self.limits=admission['allowance'];self.family=admission['family']
        self.deadline=min(self.started+self.limits['seconds'],admission['deadlineMonotonic'])
        self.native_reserve=self.limits['publication']
        self.network_end=min(admission['networkSeconds'],admission['networkDeadline']-self.started)
        self.admission['networkSeconds']=self.network_end
        self.maximum_extras=self.limits['graphExtras']+self.limits['rpcExtras']
        self.retry_ordinal=0
        self.state.update(combinedJob=admission['job'],retrySpent={k:0 for k in ('dataGraph','controlGraph','dataRpc','controlRpc')},
            combinedRetryPolicy={'classification':'unchanged maintained family policy', 'ordinaryWaitsSeconds':[15,60],
            'ordinaryExtrasPerQuery':2,'optionalParticipantDataWaitsSeconds':[120,240,300],
            'jobGraphExtras':self.limits['graphExtras'],'jobRpcExtras':self.limits['rpcExtras'],
            'controlGraphExtras':self.limits['controlGraphExtras'],'controlRpcExtras':self.limits['controlRpcExtras']})
        self.storage.limit=1024**3;self.storage.entry_limit=16000
        self.persist()
    def dispatch_cutoff(self):return self.network_end
    def liabilities(self,q,remaining):return [] # reserve() uses the actual remaining control list.
    def phase_check(self,q,tail,delay=0):
        counters=self.state
        if self.state['pending'] is not None:
            counters=read(self.root/'combined-reservations'/f"{self.state['attempts']:05d}.json")['countersBefore']
        return reserve(q,self.controls,self.retry_ordinal,counters,self.limits,self.capacity,
                       self.clock()-self.started,self.network_end,self.closing,delay)
    def budget(self,q,tail,cutoff=None,is_retry=False):
        if self.closed or self.failed or self.state['pending'] is not None:raise Stop('Closed/uncertain combined job')
        reserved=self.phase_check(q,tail)
        if 'operatingFormat' in self.admission:
            parent={k:0 for k in GLOBAL};parent['rpcEndpointAttempts']=[0,0]
        else:parent=read(self.parent_root/'PARENT_ACCOUNTING.json')
        if 'operatingFormat' not in self.admission and (parent['status']!='ADMITTED' or parent['pending'] is not None or parent['job']!=self.admission['job']):
            raise Stop('Parent inactive/unknown/foreign job')
        for k,n in reserved['counts'].items():
            if parent[k]+n>parent_limits(self.admission,GLOBAL)[k]:raise LimitReached('Parent safety reserve '+k)
        if any(parent['rpcEndpointAttempts'][i]+reserved['endpointAttempts'][i]>parent_limits(self.admission,{'rpcAttempts':240})['rpcAttempts']//2 for i in (0,1)):
            raise LimitReached('Parent endpoint safety reserve')
        self.storage.check(2*sum(reserved['counts'][k] for k in ('graphChargedBytes','rpcChargedBytes'))+262144,acquisition=True)
        receipt=dict(attempt=self.state['attempts']+1,query=q,ordinal=self.retry_ordinal,
                     controls=copy.deepcopy(self.controls),closing=self.closing,countersBefore=counter_subset(self.state),
                     parentBefore=parent,offset=self.clock()-self.started,reserved=reserved)
        # The receipt's offset is the exact arithmetic input, not a later sample.
        receipt['reserved']=reserve(q,self.controls,self.retry_ordinal,self.state,self.limits,self.capacity,
                                    receipt['offset'],self.network_end,self.closing)
        self.storage.json(self.root/'combined-reservations'/f"{receipt['attempt']:05d}.json",receipt)
    def attempt(self,q,*args,**kwargs):
        if 'operatingFormat' in self.admission:
            from operating_bridge import current
            cap,value=super().attempt(q,*args,**kwargs)
            answer=current().settle(cap['attempt'],cap['closureKnown'],bool(cap.get('complete') and cap['entityRows'] is not None),
                                    cap['chargedBytes'],cap['chargedEntities'])
            self.storage.json(self.root/'parent-settlements'/f"{cap['attempt']:05d}.json",answer)
            return cap,value
        parent=read(self.parent_root/'PARENT_ACCOUNTING.json')
        if parent.get('lastClosedMonotonic') is not None:
            self.sleep(max(0,1-(self.clock()-parent['lastClosedMonotonic'])))
        cap,value=super().attempt(q,*args,**kwargs)
        # Parent reservation is made by the transport wrapper before its child.
        parent=read(self.parent_root/'PARENT_ACCOUNTING.json')
        pending=parent['pending']
        if not pending or pending['job']!=self.admission['job'] or pending['attempt']!=cap['attempt']:
            raise Stop('Parent reservation mismatch')
        p=protocol(q)
        parent[p+'ChargedBytes']+=cap['chargedBytes']-pending['bytes']
        parent['chargedEntities']+=cap['chargedEntities']-pending['objects']
        parent['observedBytes']+=cap['responseBytes']
        parent['returnedEntities']+=cap['entityRows'] or 0
        parent['unknownEntityReservations']+=0 if cap['entityRows'] is not None else q['maxRows']
        if cap['closureKnown']:
            parent['pending']=None;parent['lastClosedMonotonic']=self.clock()
        else:parent['status']='CLOSURE_OR_ACCOUNTING_UNKNOWN'
        atomic(self.parent_root/'PARENT_ACCOUNTING.json',parent)
        self.storage.json(self.root/'parent-settlements'/f"{cap['attempt']:05d}.json",parent)
        return cap,value
    def reserve_extra(self,q,is_retry):
        super().reserve_extra(q,is_retry)
        if is_retry:self.state['retrySpent'][('control' if is_control(q,self.closing) else 'data')+protocol(q).title()]+=1
    def request(self,q,optional=False):
        original=self.state['attempts']+1;prior=None;cap=None
        maximum=5 if self.family=='participants' and q['kind'] in ('changes','parents') and q['phase']=='data' else 2
        if self.family=='market' and q['kind']=='rpc':maximum=0
        try:
            for ordinal in range(maximum+1):
                self.retry_ordinal=ordinal
                if ordinal>2:
                    from retry_schedule import slow_eligible
                    if not slow_eligible(q,cap):break
                if ordinal:
                    slot=('control' if is_control(q,self.closing) else 'data')+protocol(q).title()
                    allowance=self.limits['control'+protocol(q).title()+'Extras'] if slot.startswith('control') else self.limits[protocol(q)+'Extras']-self.limits['control'+protocol(q).title()+'Extras']
                    if self.state['retrySpent'][slot]>=allowance:break
                    self.phase_check(q,[],WAITS[ordinal-1]);self.sleep(WAITS[ordinal-1])
                cap,value=self.attempt(q,[],is_retry=ordinal>0,original=original,prior=prior,retry_index=ordinal)
                if cap['usable']:return cap,value
                if not cap['retryable']:raise Stop(cap['stopReason'])
                prior=cap['attempt']
            raise Stop('COMBINED_FEED_CLOSED_RETRY_EXHAUSTION')
        except BaseException:
            self.failed=True
            raise

class ParentTransport:
    def __init__(self,session,physical):self.s=session;self.physical=physical
    def __call__(self,request,deadline,storage):
        if 'operatingFormat' in self.s.admission:
            from operating_bridge import current
            s=self.s;q=read(request)['job'];n=s.state['attempts']
            r=read(s.root/'combined-reservations'/f'{n:05d}.json')
            bridge=current()
            epoch_deadline=bridge.clock.to_epoch(deadline) if hasattr(bridge.clock,'to_epoch') else deadline
            answer=current().permit(request,q,n,s.retry_ordinal,s.capacity(q),q['maxRows'],
                                     min(epoch_deadline,s.admission['networkClosesAtUnixSeconds']),{**r['reserved']['counts'],'endpointAttempts':r['reserved']['endpointAttempts']})
            r['parentBefore']=answer['parentBefore']
            atomic(s.root/'combined-reservations'/f'{n:05d}.json',r)
            # Waiting consumed the original deadline; the exact query and controls are checked again.
            permit_deadline=(bridge.clock.to_mono(bridge.pending['expiresAt'])
                             if hasattr(bridge.clock,'to_mono') else bridge.pending['expiresAt'])
            deadline=min(deadline,s.admission['networkDeadline'],permit_deadline)
            try:
                s.phase_check(q,[])
                if s.clock()>=deadline-3:
                    raise LimitReached('Combined queued request execution reserve')
                result=self.physical(request,deadline,storage)
            except LimitReached as exc:
                # A queued permit can consume the request or control reserve.
                # Prove that no worker started, record that fact, retain the
                # full liability, and let the ordinary durable ledger settle it.
                # Storage/integrity failures deliberately do not enter this path.
                if not hasattr(bridge.clock,'epoch'):raise
                import os
                p=bridge.pending;folder=Path(request).parent
                if (not p or p['requestPath']!=str(Path(request).resolve()) or
                    p['requestSha256']!=digest(Path(request).read_bytes()) or
                    getattr(self.physical,'child',None) is not None or
                    any((folder/name).exists() for name in ('PHYSICAL_STARTED.json','PHYSICAL_CLOSED.json','NATIVE_NO_DISPATCH.json','transport.json','response.body')) or
                    (s.root.parent/'PHYSICAL_ACTIVE.lock').exists()):
                    raise Stop('Uncertain pre-dispatch ownership') from exc
                proof=dict(ownerPid=os.getpid(),permit=p['id'],nonce=p['nonce'],requestSha256=p['requestSha256'],
                    networkRequests=0,reason='COMBINED_POST_GRANT_RESERVE_REFUSAL',detail=str(exc))
                storage.json(folder/'NATIVE_NO_DISPATCH.json',proof)
                result=dict(status=None,complete=False,connectionClosed=True,childStarted=False,childReaped=False,
                    noChildStarted=True,failureKind='local_reserve_refusal',transportError=str(exc))
                storage.json(folder/'transport.json',result)
                from operating_bridge import native_closure
                native_closure(request,s.root,s.admission,dict(ownerPid=os.getpid(),workerPid=None,
                    childStarted=False,childReaped=False,exitCode=None,connectionClosed=True),bridge.clock.epoch())
                return result
            if hasattr(bridge.clock,'epoch'):
                from operating_bridge import native_closure
                native_closure(request,s.root,s.admission,self.physical.last_lifecycle,bridge.clock.epoch())
            return result
        s=self.s;p=read(s.parent_root/'PARENT_ACCOUNTING.json');q=read(request)['job']
        if p['status']!='ADMITTED' or p['pending'] is not None:raise Stop('Unknown parent physical slot')
        if s.clock()>=p['networkDeadline'] or s.clock()>=s.admission['networkDeadline']:
            raise LimitReached('Absolute parent/job network deadline')
        if p.get('lastClosedMonotonic') is not None and s.clock()<p['lastClosedMonotonic']+1:
            raise Stop('Parent physical pacing')
        kind=protocol(q);n=s.state['attempts'];size=s.capacity(q)
        p['attempts']+=1;p[kind+'Attempts']+=1;p[kind+'ChargedBytes']+=size;p['chargedEntities']+=q['maxRows']
        if kind=='rpc':p['rpcEndpointAttempts'][q['endpoint']]+=1
        ordinal=s.retry_ordinal
        if ordinal:p['extraAttempts']+=1;p[kind+'Extras']+=1
        limits=parent_limits(s.admission,{**GLOBAL,'attempts':840,'extras':76,'graphExtras':60,'rpcExtras':16,'chargedBytes':80*MIB})
        if (any(p[k]>limits[k] for k in GLOBAL) or p['attempts']>limits['attempts']
            or max(p['rpcEndpointAttempts'])>limits['rpcAttempts']//2 or p['graphExtras']>limits['graphExtras'] or p['rpcExtras']>limits['rpcExtras']
            or p['extraAttempts']>limits['extras'] or sum(p.get(k+'ChargedBytes',0) for k in ('graph','rpc','http'))>limits['chargedBytes']):
            raise LimitReached('Parent physical ceiling')
        p['pending']=dict(job=s.admission['job'],attempt=n,requestPath=str(Path(request).resolve()),bytes=size,objects=q['maxRows'])
        atomic(s.parent_root/'PARENT_ACCOUNTING.json',p)
        return self.physical(request,min(deadline,p['networkDeadline'],s.admission['networkDeadline']),storage)

def audit_reservations(root,state,capacity):
    """Saved-only arithmetic and exact lineage; semantic auditors still validate bodies."""
    root=Path(root);a=read(root/'ADMISSION.json');limits=a['allowance']
    a['networkSeconds']=read(root/'JOB_CLOCK.json')['networkSeconds']
    if a['task']!=TASK or a['job']!=state['combinedJob']:raise ValueError('Combined job identity')
    totals={k:0 for k in GLOBAL};totals.update(attempts=0,extraAttempts=0,rpcEndpointAttempts=[0,0],retrySpent={k:0 for k in ('dataGraph','controlGraph','dataRpc','controlRpc')})
    last=None
    family=a['family'];controls=[];closing=False;market_pools=set()
    if family=='participants':
        from retry_schedule import ControlReplay
        control_replay=ControlReplay()
    elif family=='market':
        from current import descriptors
        controls=descriptors()
    def signature(c):return (c['kind'],c['endpoint'],c.get('family'),c.get('method','eth_getBlockByNumber' if c['kind']=='rpc' else None),c.get('first'),c['maxRows'],capacity(c))
    for raw in (root/'LEDGER.jsonl').read_bytes().splitlines():
        c=strict_json(raw);q=c['job'];n=c['attempt'];r=read(root/'combined-reservations'/f'{n:05d}.json')
        if family=='participants':controls=control_replay.before(q,c['retry'])
        elif family in ('gas','protocol'):
            from protocol import job
            if q.get('phase')=='head' and not controls and not closing:
                controls=[job(ep,'eth_getBlockByNumber',[hex(27750330),False],1,'close') for ep in (0,1)]
                if family=='protocol':
                    from protocol import call
                    controls=[job(ep,'eth_call',call('global','0x'+'1'*64),1,'close-global') for ep in (0,1)]+controls
            if is_control(q) and not c['retry']:
                closing=True
                if not controls or signature(controls.pop(0))!=signature(q):raise ValueError('Combined control order')
        else:
            if q['kind']=='pools' and q['endpoint'] in market_pools:closing=True
            if closing and not c['retry']:
                if not controls or signature(controls.pop(0))!=signature(q):raise ValueError('Combined market control order')
            if q['kind']=='pools' and c['usable']:market_pools.add(q['endpoint'])
        # Different selected hashes/placeholder numbers share the same exact method liability.
        if list(map(signature,r['controls']))!=list(map(signature,controls)):
            raise ValueError('Independently reconstructed control reservation')
        expected_closing=closing if family!='participants' else q['phase']=='control' and q['kind'] in ('meta','rpc')
        if bool(r['closing'])!=expected_closing:raise ValueError('Combined closing phase')
        if r['query']!=q or r['ordinal']!=c['retryIndex'] or r['countersBefore']!=totals or r['attempt']!=n:
            raise ValueError('Combined reservation lineage')
        calculated=reserve(q,r['controls'],c['retryIndex'],totals,limits,capacity,r['offset'],a['networkSeconds'],r['closing'])
        if r['reserved']!=calculated or not 0<=r['offset']<=c['startOffsetSeconds']:
            raise ValueError('Combined reservation arithmetic/time')
        reserve(q,r['controls'],c['retryIndex'],totals,limits,capacity,c['startOffsetSeconds'],a['networkSeconds'],r['closing'])
        for k,v in calculated['counts'].items():
            if r['parentBefore'][k]+v>parent_limits(a,GLOBAL)[k]:raise ValueError('Combined parent reservation')
        if c['retryIndex'] and (not last or c['job']!=last['job'] or c['retryIndex']!=last['retryIndex']+1 or c['startOffsetSeconds']+.002<last['startOffsetSeconds']+last['durationSeconds']+WAITS[c['retryIndex']-1]):
            raise ValueError('Combined exact ordinal/wait')
        p=protocol(q);totals['attempts']+=1;totals[p+'Attempts']+=1;totals[p+'ChargedBytes']+=c['chargedBytes'];totals['chargedEntities']+=c['chargedEntities']
        if p=='rpc':totals['rpcEndpointAttempts'][q['endpoint']]+=1
        if c['retry']:
            totals['extraAttempts']+=1;totals['retrySpent'][('control' if r['reserved']['control'] else 'data')+p.title()]+=1
        last=c
        if family=='participants' and c['usable'] and q['kind']!='rpc':
            control_replay.observe(q,read(root/f'captures/{n:05d}/response.body')['data'])
    if any(state[k]!=v for k,v in totals.items()):raise ValueError('Combined saved accounting mismatch')
    return totals
