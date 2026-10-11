"""A parent pending reservation precedes each unchanged feed-specific HTTP gate."""
import sys,json,time,importlib.util
sys.dont_write_bytecode=True
from pathlib import Path
HERE=Path(__file__).resolve().parent

def operating_physical_enter(request,root,a,clock):
    """Shared physical gate, also used by the denied-network response fixture.
    A fixture substitutes only response I/O after this real permit validation.
    """
    import hashlib,os
    from operating_bridge import admitted
    if not admitted(a):raise ValueError('Exact operating admission')
    root=Path(root);request=Path(request);now=clock()
    state=json.loads((root.parent/'OPERATING_STATE.json').read_bytes());p=state.get('pending')
    if (state['status']!='RUNNING' or not p or p['job']!=a['job'] or state['activation']!=a['activation']
        or p['requestPath']!=str(request.resolve()) or p['requestSha256']!=hashlib.sha256(request.read_bytes()).hexdigest()
        or now>=p['expiresAt'] or not any(j['id']==a['job'] and j['admissionHash']==hashlib.sha256((root/'ADMISSION.json').read_bytes()).hexdigest() for j in state['active'])):
        raise ValueError('Operating physical permit binding')
    for name,h in a['runtimeFiles'].items():
        if hashlib.sha256((HERE.parents[1]/name).read_bytes()).hexdigest()!=h:raise ValueError('Frozen operating source changed')
    req=json.loads(request.read_bytes())
    if a['family']=='trade':
        from client import exact_request
        exact_request(req['method'],req['url'])
    else:
        q=req['job']
        if a['family']=='participants':
            from queries import validate_job,plan_valid
            raw=(root/'PLAN.json').read_bytes()
            if hashlib.sha256(raw).hexdigest()!=a['planSha256']:raise ValueError('Operating frozen plan')
            plan=json.loads(raw)
            if (root/'RESOLVED_PLAN.json').exists():
                resolved=json.loads((root/'RESOLVED_PLAN.json').read_bytes())
                if {**resolved,'finalTarget':plan['finalTarget']}!=plan or resolved['finalTarget']['number']!=plan['finalTarget']['number']:raise ValueError('Operating resolved plan')
                plan=resolved
            plan_valid(plan)
            frontier=json.loads((root/'FRONTIER.json').read_bytes())
            if q['window']!=frontier['completedWindows']+1:raise ValueError('Operating predecessor publication')
            if q['kind']!='rpc':
                binding=json.loads((root/f"WINDOW_{q['window']}_BINDING.json").read_bytes())
                if q['pin'] not in (binding['base'],binding['target']):raise ValueError('Operating uncorroborated pin')
            method,url,body=validate_job(q,plan)
        elif a['family']=='market':
            from task_queries import validate_job
            method,url,body=validate_job(q)
        else:
            from protocol import validate_job
            method,url,body=validate_job(q)
        if method!=req['method'] or url!=req['url'] or body!=(request.parent/'request.body').read_bytes():raise ValueError('Operating physical query changed')
    raw=json.dumps(dict(permit=p['id'],nonce=p['nonce'],job=a['job'],attempt=p['attempt'],at=now)).encode()
    with (root.parent/'PHYSICAL_ACTIVE.lock').open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    with (request.parent/'PHYSICAL_STARTED.json').open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    # Re-read after hashing and durable writes, immediately before response I/O.
    final=json.loads((root.parent/'OPERATING_STATE.json').read_bytes())
    if clock()>=p['expiresAt'] or final['status']!='RUNNING' or final.get('pending')!=p:
        raise ValueError('Operating final physical deadline/ownership')
    return raw

def operating_physical_close(request,root,token,now):
    import os
    root=Path(root);request=Path(request);lock=root.parent/'PHYSICAL_ACTIVE.lock'
    if lock.read_bytes()!=token:raise ValueError('Operating physical closure owner')
    value={**json.loads(token),'closedAt':now,'connectionClosed':True,'childReaped':True,'syntheticResponse':True}
    with (request.parent/'PHYSICAL_CLOSED.json').open('x') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
    lock.unlink()

def main():
    request=Path(sys.argv[1]).resolve();root=request.parents[2]
    a=json.loads((root/'ADMISSION.json').read_bytes())
    if 'operatingFormat' in a:raise ValueError('Operating mode has no public network authority')
    parent=json.loads((root.parent/'PARENT_ACCOUNTING.json').read_bytes())
    if (a['task']!='HDD-UNIFIED-REFRESH-OPERATION-R1' or parent['status']!='ADMITTED'
        or parent['job']!=a['job'] or parent['pending']['requestPath']!=str(request)
        or time.time()>=min(parent['networkClosesAtUnixSeconds'],a['networkClosesAtUnixSeconds'])):
        raise ValueError('Unbound/expired parent request')
    folder={'market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[a['family']]
    sys.path[:0]=[str(HERE),str(HERE.parent/folder),str(HERE.parent/'market-refresh')]
    from durable import digest
    if a.get('unifiedProfileId') is not None:
        from public_profile import is_public,validate_authority
        if not is_public(a):raise ValueError('Offline profile cannot perform network requests')
        validate_authority(a,root,request)
    if digest((root/'ADMISSION.json').read_bytes())!=parent['jobAdmissionSha256']:
        raise ValueError('Exclusive child admission changed')
    repo=HERE.parents[1]
    for path,h in a['runtimeFiles'].items():
        if digest((repo/path).read_bytes())!=h:raise ValueError('Frozen combined runtime changed')
    file=HERE.parent/folder/('http_worker.py' if a['family']=='market' else 'worker.py')
    spec=importlib.util.spec_from_file_location('bound_feed_worker',file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.main()

if __name__=='__main__':main()
