"""One admitted subdivision; never creates a public parent or renews a budget."""
import sys, time, queue, threading, json
sys.dont_write_bytecode=True
from pathlib import Path
HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]

def main(offline_fixture=False):
    if len(sys.argv)!=2:raise ValueError('Exact admitted job directory required')
    root=Path(sys.argv[1]).resolve()
    a=json.loads((root/'ADMISSION.json').read_bytes());family=a['family']
    folder={'market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[family]
    sys.path[:0]=[str(HERE),str(HERE.parent/folder),str(HERE.parent/'market-refresh')]
    from durable import strict_json,digest,save,utc
    from capture_client import Session,WorkerTransport
    from combined import TASK,Combined,ParentTransport,read,atomic
    from offline_profile import admitted,closed_frame
    unified=admitted(a)
    from public_profile import is_public,validate_authority
    public=is_public(a)
    if public:
        if offline_fixture:raise ValueError('Public admission cannot inject transport')
        validate_authority(a,root)
    if a['task']!=TASK or a['jobRoot']!=str(root) or (a.get('synthetic') and not offline_fixture):
        raise ValueError('Exact public subdivision admission')
    for name,h in a['runtimeFiles'].items():
        if digest((REPO/name).read_bytes())!=h:raise ValueError('Frozen runtime changed')
    operating='operatingFormat' in a
    real_bridge=None
    if operating and a.get('clockMode')=='REAL_EPOCH':
        from operating_bridge import initialize_real
        real_bridge=initialize_real(root,a)
    if operating:
        from operating_bridge import current
        parent=read(root.parent/'OPERATING_STATE.json')
        if parent['status']!='RUNNING' or parent['activation']!=a['activation'] or not any(
            j['id']==a['job'] and j['admissionHash']==digest((root/'ADMISSION.json').read_bytes()) for j in parent['active']):
            raise ValueError('Exact operating child registration')
        parent={'networkDeadline':time.monotonic()+a['networkClosesAtUnixSeconds']-time.time()}
    else:
        parent=read(root.parent/'PARENT_ACCOUNTING.json')
        if parent['status']!='ADMITTED' or parent['job']!=a['job'] or parent['pending'] is not None:
            raise ValueError('Unknown parent admission')
        if digest((root/'ADMISSION.json').read_bytes())!=parent['jobAdmissionSha256']:
            raise ValueError('Exclusive child admission changed')
    if (root/'ACCOUNTING.json').exists():raise ValueError('Job already admitted; never resume')
    import collector
    if family=='participants':
        from session import ParticipantSession as Base
        plan=read(root/'PLAN.json')
    elif family=='gas':
        from session import GasSession as Base
    elif family=='protocol':
        from session import ProtocolSession as Base
    else:Base=Session
    class Bound(Combined,Base):pass
    now=real_bridge.clock() if real_bridge else time.monotonic();wall=real_bridge.clock.epoch() if real_bridge else time.time()
    if 'networkDeadline' not in parent:
        parent['networkDeadline']=now+parent['networkClosesAtUnixSeconds']-wall
        atomic(root.parent/'PARENT_ACCOUNTING.json',parent)
    a['deadlineMonotonic']=now+a['deadlineUnixSeconds']-wall
    a['networkDeadline']=min(parent['networkDeadline'],now+a['networkClosesAtUnixSeconds']-wall)
    a['networkSeconds']=a['networkDeadline']-now
    if real_bridge:
        a['deadlineMonotonic']=real_bridge.clock.to_mono(a['deadlineUnixSeconds'])
        a['networkDeadline']=real_bridge.clock.to_mono(a['networkClosesAtUnixSeconds'])
        a['networkSeconds']=a['networkDeadline']-now
    clock_args=dict(clock=real_bridge.clock,sleep=real_bridge.sleep) if real_bridge else {}
    s=Bound(root,None,plan,synthetic=offline_fixture,**clock_args) if family=='participants' else Bound(root,None,synthetic=offline_fixture,**clock_args)
    s.configure(a,root.parent)
    if offline_fixture:s.state['mode']='SYNTHETIC_OFFLINE_TEST';s.persist()
    save(root/'JOB_CLOCK.json',dict(startedMonotonic=s.started,networkSeconds=s.network_end,
         deadlineMonotonic=s.deadline,networkDeadline=a['networkDeadline'],recordedAt=utc()))
    s.transport=ParentTransport(s,WorkerTransport(a['nonce'],worker_path=HERE/'worker.py'))
    incoming=current().incoming if operating else queue.Queue()
    def reader():
        try:
            for line in sys.stdin:
                if len(line)>32768:raise ValueError('IPC bound')
                incoming.put(strict_json(line))
        finally:incoming.put(None)
    if not operating:threading.Thread(target=reader,daemon=True).start()
    def exchange(message,deadline):
        allowance=min(180 if family=='participants' else 30,deadline-s.clock(),s.deadline-s.clock())
        if allowance<=0:raise ValueError('No publication time')
        message['expiresAtUnixSeconds']=time.time()+allowance
        if unified and not public and not real_bridge:message['syntheticClockUnixSeconds']=time.time()
        print(json.dumps(message),flush=True)
        try:answer=incoming.get(timeout=allowance)
        except queue.Empty:raise ValueError('Publication acknowledgement unknown')
        key='window' if family=='participants' else 'cycle'
        if not isinstance(answer,dict) or answer.get('ok') is not True or answer.get(key)!=message[key]:
            raise ValueError('Parent acknowledgement refused/unknown')
        return answer
    try:
        if family=='participants':
            base=collector.run_window(s,1,plan['base'],exchange,{k:set() for k in ('tokenHolders','stakeStarts','parents')})
            result=dict(status='COMPLETE_SCOPED_CATCHUP',completedWindows=1,frontier=base)
        elif family=='market':result=collector.run_cycles(s,1,exchange,a['initial']['market'])
        else:result=collector.run_cycles(s,1,exchange,a['initial'][family])
    except BaseException as e:
        result=dict(status='PARTIAL',failure=type(e).__name__+': '+str(e),
                    feedLocalClosedExhaustion=str(e)=='COMBINED_FEED_CLOSED_RETRY_EXHAUSTION')
    finally:
        s.close(result.get('failure','Combined job closed'))
        result.update(accounting=s.state,parentSubdivision=True,networkSessionCount=0,synthetic=bool(a.get('synthetic')),noAutomaticRestart=True,indexer='PARKED')
        s.storage.json(root/'RESULT.json',result)
        print(json.dumps(closed_frame(root,result) if unified else {'type':'closed','result':result}),flush=True)
    return 0 if result['status'].startswith('COMPLETE_') else 2

if __name__=='__main__':raise SystemExit(main())
