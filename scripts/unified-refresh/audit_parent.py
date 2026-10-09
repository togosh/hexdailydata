"""Saved-only global replay; no provider imports or mutable execution."""
import json,hashlib
from pathlib import Path
KEYS=['attempts','extraAttempts','graphAttempts','rpcAttempts','graphExtras','rpcExtras',
      'graphChargedBytes','rpcChargedBytes','chargedEntities','observedBytes','returnedEntities','unknownEntityReservations']
ORDER=['market-1','gas-1','protocol-1','participants-1','market-2','gas-2','protocol-2']
def read(p):return json.loads(Path(p).read_bytes())
def audit(root):
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
if __name__=='__main__':
    import sys
    print(json.dumps(audit(sys.argv[1]),indent=2))
