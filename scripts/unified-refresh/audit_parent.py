"""Saved-only global replay; no provider imports or mutable execution."""
import json,hashlib,sys
sys.dont_write_bytecode=True
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
KEYS=['attempts','extraAttempts','graphAttempts','rpcAttempts','graphExtras','rpcExtras',
      'graphChargedBytes','rpcChargedBytes','chargedEntities','observedBytes','returnedEntities','unknownEntityReservations']
ORDER=['market-1','gas-1','protocol-1','participants-1','market-2','gas-2','protocol-2']
def read(p):return json.loads(Path(p).read_bytes())
def audit(root):
    if (Path(root)/'PROFILE.json').exists():return audit_profile(root)
    root=Path(root);totals={k:0 for k in KEYS};eps=[0,0];last=None;jobs=[]
    for name in ORDER:
        d=root/name
        if not d.exists():continue
        a=read(d/'ADMISSION.json');clock=read(d/'JOB_CLOCK.json');state=read(d/'ACCOUNTING.json')
        if a['job']!=name:raise ValueError('Parent job order/admission')
        count=0
        for line in (d/'LEDGER.jsonl').read_bytes().splitlines():
            c=json.loads(line);n=c['attempt'];count+=1
            r=read(d/'combined-reservations'/f'{n:05d}.json');before=r['parentBefore']
            if before['jobAdmissionSha256']!=hashlib.sha256((d/'ADMISSION.json').read_bytes()).hexdigest():raise ValueError('Exclusive job admission binding')
            if any(before[k]!=totals[k] for k in KEYS) or before['rpcEndpointAttempts']!=eps or before['pending'] is not None or before['job']!=name:
                raise ValueError('Parent preceding counter lineage')
            if last is not None and before['lastClosedMonotonic']!=last:raise ValueError('Parent closure lineage')
            start=clock['startedMonotonic']+c['startOffsetSeconds']
            if last is not None and start+.002<last+1:raise ValueError('Global post-closure pacing')
            p='rpc' if c['job']['kind']=='rpc' else 'graph'
            totals['attempts']+=1;totals[p+'Attempts']+=1;totals[p+'ChargedBytes']+=c['chargedBytes'];totals['chargedEntities']+=c['chargedEntities']
            totals['observedBytes']+=c['responseBytes'];totals['returnedEntities']+=c['entityRows'] or 0
            if c['entityRows'] is None:totals['unknownEntityReservations']+=c['job']['maxRows']
            if c['retry']:totals['extraAttempts']+=1;totals[p+'Extras']+=1
            if p=='rpc':eps[c['job']['endpoint']]+=1
            ceilings={'attempts':840,'graphAttempts':600,'rpcAttempts':240,'graphExtras':60,'rpcExtras':16,'graphChargedBytes':64*1024**2,'rpcChargedBytes':16*1024**2,'chargedEntities':200000}
            if any(totals[k]>v for k,v in ceilings.items()) or max(eps)>120:raise ValueError('Parent replay ceiling')
            settled=read(d/'parent-settlements'/f'{n:05d}.json')
            if any(settled[k]!=totals[k] for k in KEYS) or settled['rpcEndpointAttempts']!=eps:
                raise ValueError('Parent settlement charge lineage')
            if not c['closureKnown'] or settled['pending'] is not None:raise ValueError('Unknown parent closure; charges retained, reconciliation incomplete')
            last=settled['lastClosedMonotonic']
            if last+.002<start+c['durationSeconds']:raise ValueError('Early parent closure')
        if count!=state['attempts'] or state['status']!='CLOSED' or state['pending'] is not None:raise ValueError('Child closure/accounting')
        jobs.append({'job':name,'attempts':count,'closed':True})
    final=read(root/'PARENT_ACCOUNTING.json')
    if any(final[k]!=v for k,v in totals.items()) or final['rpcEndpointAttempts']!=eps or final['pending'] is not None or final['status']!='CLOSED':
        raise ValueError('Final parent reconciliation')
    if final['lastClosedMonotonic']!=last:raise ValueError('Final closure lineage')
    return dict(status='PASS',savedOnly=True,jobs=jobs,totals=totals,rpcEndpointAttempts=eps)

def audit_profile(root):
    """Reconcile every native subdivision in finite order, including GET liabilities."""
    root=Path(root);profile=read(root/'PROFILE.json');keys=KEYS+['httpAttempts','httpExtras','httpChargedBytes']
    profile_hash=hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    final=read(root/'PARENT_ACCOUNTING.json')
    live=profile.get('format')=='unified-five-feed-public-qualification-2'
    if live:
        from public_profile import ROOT,TASK,PROFILE_HASH,PACKET,is_public,digest
        if root.resolve()!=ROOT/'session' or profile_hash!=PROFILE_HASH:raise ValueError('Saved public root/profile')
        marker=read(ROOT/'PUBLIC_ADMISSION.json');pre=read(ROOT/'PREFLIGHT.json');plan=read(ROOT/'FROZEN_PLAN.json');review=read(ROOT/'evidence/PREFLIGHT_REVIEW.json')
        if (marker['taskId']!=TASK or marker['nonce']!=final['nonce'] or marker['profileSha256']!=profile_hash
            or final['preflightSha256']!=digest((ROOT/'PREFLIGHT.json').read_bytes()) or review['verdict']!='PASS'
            or review['planSha256']!=digest((ROOT/'FROZEN_PLAN.json').read_bytes()) or review['candidateCommit']!=plan['commit']
            or pre['reviewSha256']!=digest((ROOT/'evidence/PREFLIGHT_REVIEW.json').read_bytes())
            or pre['readySha256']!=digest((ROOT/'evidence/READY.json').read_bytes())
            or any(digest((ROOT/p).read_bytes())!=h for p,h in PACKET.items())):raise ValueError('Saved public binding')
    if final['profileSha256']!=profile_hash or final['limits']!=profile['parent']:
        raise ValueError('Profile parent identity/limits')
    totals={k:0 for k in keys};eps=[0,0];last=None;jobs=[]
    for j in profile['jobs']:
        d=root/j['id']
        if not d.exists():continue
        a=read(d/'ADMISSION.json')
        ah=hashlib.sha256((d/'ADMISSION.json').read_bytes()).hexdigest()
        if (a['job']!=j['id'] or a['family']!=j['family'] or (not live and (not a['synthetic'] or a['parentMode']!='OFFLINE_ONLY'))
            or a['parentProfileSha256']!=profile_hash or a['parentLimits']!=profile['parent']):
            raise ValueError('Profile child identity/limits')
        if live and (not is_public(a) or a['parentNonce']!=final['nonce'] or a['preflightSha256']!=final['preflightSha256']
                     or a['runtimeFiles']!=plan['runtimeFiles'] or a['jobRoot']!=str(d)
                     or any(a['allowance'][k]>v for k,v in j['bounds'].items())):raise ValueError('Saved public child binding')
        if (d/'DISPATCH_SKIPPED.json').exists():
            skipped=read(d/'DISPATCH_SKIPPED.json');fact=read(root/(j['id']+'-SKIPPED.json'))
            if (skipped['jobAdmissionSha256']!=ah or skipped['parentProfileSha256']!=profile_hash
                or skipped['closure']!='NO_CHILD' or fact['closure']!='NO_CHILD' or fact['status']!='SKIPPED'
                or fact['reason']!=skipped['reason'] or fact['job']!=j['id']
                or skipped['reason'] not in ('CANCELLED_DURING_PREPARATION','MISSED_DUE_DURING_PREPARATION','PREPARATION_CONSUMED_RESERVE')
                or any((d/name).exists() for name in ('ACCOUNTING.json','NATIVE_CLOSURE.json','LEDGER.jsonl','JOB_CLOCK.json','RESULT.json'))):
                raise ValueError('Prepared no-child dispatch evidence')
            jobs.append(dict(job=j['id'],attempts=0,closure='NO_CHILD'))
            continue
        state=read(d/'ACCOUNTING.json');native=read(d/'NATIVE_CLOSURE.json')
        if (native['exit']['code'] not in (0,2) or native['exit']['signal'] or native['killed']
            or native['closureProtocolError'] or not native['resultMatchesClosedMessage'] or not native['accountingMatchesResult']):
            raise ValueError('Profile native identity/closure')
        trade=j['family']=='trade'
        captures=state['requests'] if trade else [json.loads(x) for x in (d/'LEDGER.jsonl').read_bytes().splitlines()]
        clock=None if trade else read(d/'JOB_CLOCK.json')
        for c in captures:
            n=c['attempt'];p='http' if trade else 'rpc' if c['job']['kind']=='rpc' else 'graph'
            if trade:
                reservation=read(d/'parent-reservations'/f'{n:05d}.json')
                if reservation['jobAdmissionSha256']!=ah:raise ValueError('GET exclusive child binding')
                if reservation['rpcEndpointAttempts']!=eps:raise ValueError('GET endpoint counter lineage')
                start=reservation['pending']['startedMonotonic']
                charged=2162688;objects=c['chargedObjects'];observed=c['wireBytes']+c['headerBytes']
                returned=objects if c['complete'] else 0;unknown=0 if c['complete'] else objects;extra=c['retryOrdinal']
                folder=d/f'{n:02d}';body=folder/'response.body'
                if body.exists():raw=body.read_bytes()
                else:
                    # A reaped terminal worker may never have produced a body.
                    # This is uncertainty charged in full, never an empty success.
                    if (c['complete'] is not False or c['closed'] is not True
                        or c['native']['reaped'] is not True or c['bodyBytes']!=0 or c['wireBytes']!=0
                        or c['bodySha256']!=hashlib.sha256(b'').hexdigest() or c['chargedObjects']!=20000
                        or c['status'] is not None or c.get('transportComplete') is not False
                        or c!=read(folder/'AUDIT.json')
                        or state['closureKnown'] is not True):raise ValueError('GET missing-body closure/uncertainty evidence')
                    meta=read(folder/'response.json') if (folder/'response.json').exists() else {}
                    if meta.get('complete') or meta.get('status') is not None:raise ValueError('GET missing accepted body')
                    if c==captures[-1]:
                        if read(d/'RESULT.json')['status']!='PARTIAL':raise ValueError('GET missing terminal body')
                    else:
                        phase=(folder/'PHASES.ndjson').read_bytes()
                        nxt=captures[captures.index(c)+1]
                        if (c['failureKind']!='timeout' or c['native']['timeout'] is not True or c['integrityFailure']
                            or c['retryOrdinal']!=0 or nxt['retryOrdinal']!=1 or nxt['attempt']!=n+1
                            or any(nxt[k]!=c[k] for k in ('method','url','label','nonce'))
                            or len(phase)!=c['phaseBytes'] or hashlib.sha256(phase).hexdigest()!=c['phaseSha256']
                            or not any(json.loads(line).get('event')=='dns_tcp_tls_connection_begin' for line in phase.splitlines())):
                            raise ValueError('GET missing-body retry lineage')
                    raw=b''
                if hashlib.sha256(raw).hexdigest()!=c['bodySha256'] or len(raw)!=c['bodyBytes'] or not c['closed']:
                    raise ValueError('GET saved body/closure')
                for key in keys:
                    inc={'attempts':1,'httpAttempts':1,'extraAttempts':extra,'httpExtras':extra,'httpChargedBytes':charged,'chargedEntities':20000}.get(key,0)
                    if reservation[key]!=totals[key]+inc:raise ValueError('GET reservation lineage '+key)
            else:
                before=read(d/'combined-reservations'/f'{n:05d}.json')['parentBefore']
                if before['jobAdmissionSha256']!=ah or any(before[k]!=totals[k] for k in keys) or before['rpcEndpointAttempts']!=eps or before['pending'] is not None:
                    raise ValueError('POST preceding counter/admission lineage')
                start=clock['startedMonotonic']+c['startOffsetSeconds'];charged=c['chargedBytes'];objects=c['chargedEntities']
                observed=c['responseBytes'];returned=c['entityRows'] or 0;unknown=0 if c['entityRows'] is not None else c['job']['maxRows'];extra=int(c['retry'])
                if p=='rpc':eps[c['job']['endpoint']]+=1
            if last is not None and start+.002<last+1:raise ValueError('Global post-closure pacing')
            totals['attempts']+=1;totals[p+'Attempts']+=1;totals['extraAttempts']+=extra;totals[p+'Extras']+=extra
            totals[p+'ChargedBytes']+=charged;totals['chargedEntities']+=objects;totals['observedBytes']+=observed
            totals['returnedEntities']+=returned;totals['unknownEntityReservations']+=unknown
            settled=read(d/'parent-settlements'/f'{n:05d}.json')
            if any(settled[k]!=totals[k] for k in keys) or settled['rpcEndpointAttempts']!=eps or settled['pending'] is not None:
                raise ValueError('Profile settlement lineage')
            for k,v in profile['parent'].items():
                if k in totals and totals[k]>v:raise ValueError('Parent ceiling '+k)
            if sum(totals[k+'ChargedBytes'] for k in ('graph','rpc','http'))>profile['parent']['chargedBytes']:raise ValueError('Combined byte ceiling')
            last=settled['lastClosedMonotonic']
        if len(captures)!=state['attempts'] or state['status']!='CLOSED' or state['pending'] is not None:raise ValueError('Profile child closure')
        jobs.append(dict(job=j['id'],attempts=len(captures)))
    if any(final[k]!=v for k,v in totals.items()) or final['rpcEndpointAttempts']!=eps or final['status']!='CLOSED' or final['pending'] is not None or final['lastClosedMonotonic']!=last:
        raise ValueError('Profile final reconciliation')
    return dict(status='PASS',synthetic=not live,savedOnly=True,totals=totals,jobs=jobs,externalRequests=totals['attempts'] if live else 0)
if __name__=='__main__':
    import sys
    print(json.dumps(audit(sys.argv[1]),indent=2))
