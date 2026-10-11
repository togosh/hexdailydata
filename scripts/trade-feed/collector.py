"""One consumed admission; three original slots, never an outer retry."""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import time,queue,threading
sys.path.insert(0,str(Path(__file__).resolve().parent))
from client import Session,TASK,URLS,W,strict_json,digest,save,SlotMissed
from authority import validate_authority, trade_profile, OPERATING_AUTHORITIES, OPERATING_R2_AUTHORITY

def closure_frame(root, result, authority):
    # R2's 66-attempt accounting can exceed the unchanged 32 KiB IPC frame cap.
    # Bind the already durable local report, rather than send its full ledger twice.
    if authority == OPERATING_R2_AUTHORITY:
        raw = (root/'RESULT.json').read_bytes()
        if not 0 < len(raw) <= 524288: raise ValueError('Closed result bound')
        if strict_json(raw) != result: raise ValueError('Closed result mismatch')
        return {'type':'closed','resultBytes':len(raw),'resultSha256':digest(raw)}
    return {'type':'closed','result':result}

def start_reader(incoming, stream=None):
    """Keep the owner command pipe in the collector, including its waiting read."""
    stream = sys.stdin if stream is None else stream
    def reader():
        for line in stream:
            try:
                if len(line)>32768:raise ValueError('IPC bound')
                incoming.put(strict_json(line))
            except BaseException as e:incoming.put({'ok':False,'reason':str(e)})
        incoming.put({'ok':False,'reason':'Owner input closed'})
    thread = threading.Thread(target=reader,daemon=True)
    thread.start()
    return thread

def collect(session,exchange,clock=time.monotonic,sleep=time.sleep,outcomes=None):
    markets=session.get(URLS[0],'markets')
    exchange('markets',0,markets=markets)
    anchor=clock();previous_end=anchor;outcomes=[] if outcomes is None else outcomes
    profile=getattr(session,'profile',trade_profile({}))
    for cycle,offset in enumerate(range(0,profile['cycles']*60,60),profile.get('first_cycle',1)):
        slot=anchor+offset
        if previous_end>slot or (profile['maximum_start_lag'] is not None and clock()>slot+profile['maximum_start_lag']):
            reason='Preceding cycle occupied scheduled slot' if previous_end>slot else 'Scheduled dispatch more than five seconds late'
            answer=exchange('skipped',cycle,reason=reason,offsetSeconds=offset)
            outcomes.append({'cycle':cycle,'status':'SKIPPED','offsetSeconds':offset})
            if profile['maximum_start_lag'] is not None:previous_end=clock()
            continue
        sleep(max(0,slot-clock()));session.check(65)
        if profile['maximum_start_lag'] is not None and clock()>slot+profile['maximum_start_lag']:
            exchange('skipped',cycle,reason='Wake more than five seconds late',offsetSeconds=offset)
            outcomes.append({'cycle':cycle,'status':'SKIPPED','offsetSeconds':offset});previous_end=clock();continue
        exchange('begin',cycle)
        try:
            btc=session.get(URLS[1],f'BTC_{cycle}',slot_deadline=slot+5) if profile['maximum_start_lag'] is not None else session.get(URLS[1],f'BTC_{cycle}')
        except SlotMissed as e:
            exchange('skipped',cycle,reason=str(e),offsetSeconds=offset)
            outcomes.append({'cycle':cycle,'status':'SKIPPED','offsetSeconds':offset});previous_end=clock();continue
        eth=session.get(URLS[2],f'ETH_{cycle}')
        answer=exchange('qualified',cycle,btc=btc,eth=eth)
        outcomes.append({'cycle':cycle,'status':answer['outcome'],'offsetSeconds':offset})
        previous_end=clock()
    return outcomes

def main():
    if len(sys.argv)!=2:
        print('No requests. Exact bound session required.');return 0
    root=Path(sys.argv[1]).resolve();a=strict_json((root/'ADMISSION.json').read_bytes())
    assert a['task']==TASK and a['family']=='trade' and a['jobRoot']==str(root) and a['synthetic'] is False
    validate_authority(a, root)
    assert 0<=time.time()-a['startedAtUnixSeconds']<=30
    for p,h in a['runtimeFiles'].items():assert digest((W/p).read_bytes())==h,p
    session=Session(root,a);incoming=queue.Queue()
    start_reader(incoming)
    def exchange(kind,cycle,**extra):
        session.check(31)
        msg={'type':kind,'cycle':cycle,'expiresAtUnixSeconds':time.time()+30,**extra}
        print(__import__('json').dumps(msg),flush=True)
        answer=incoming.get(timeout=30)
        if not answer.get('ok') or answer.get('cycle')!=cycle:raise ValueError('Owner refused: '+str(answer))
        return answer
    outcomes=[];status='PARTIAL';reason='Not completed'
    try:
        operating=a.get('authorityTaskId') in OPERATING_AUTHORITIES
        outcomes=collect(session,exchange,outcomes=outcomes if operating else None)
        status='COMPLETE_FRESH_CYCLES' if len(outcomes)==session.profile['cycles'] and all(o['status']=='QUALIFIED' for o in outcomes) else 'PARTIAL'
        reason='All original slots accounted'
    except BaseException as e:reason=type(e).__name__+': '+str(e)
    finally:session.close(reason)
    result={'status':status,'accounting':session.state,'cycles':outcomes,'networkSessionCount':1,'noAutomaticRestart':True}
    save(root/'RESULT.json',result)
    print(__import__('json').dumps(closure_frame(root,result,a.get('authorityTaskId'))),flush=True)
    return 0 if status.startswith('COMPLETE_') else 2
if __name__=='__main__':sys.exit(main())
