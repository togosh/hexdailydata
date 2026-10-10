"""One consumed admission; three original slots, never an outer retry."""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import time,queue,threading
sys.path.insert(0,str(Path(__file__).resolve().parent))
from client import Session,TASK,URLS,W,strict_json,digest,save
from authority import validate_authority

def collect(session,exchange,clock=time.monotonic,sleep=time.sleep):
    markets=session.get(URLS[0],'markets')
    exchange('markets',0,markets=markets)
    anchor=clock();previous_end=anchor;outcomes=[]
    for cycle,offset in enumerate((0,60,120),1):
        slot=anchor+offset
        if previous_end>slot:
            answer=exchange('skipped',cycle,reason='Preceding cycle occupied scheduled slot',offsetSeconds=offset)
            outcomes.append({'cycle':cycle,'status':'SKIPPED','offsetSeconds':offset});continue
        sleep(max(0,slot-clock()));session.check(65)
        exchange('begin',cycle)
        btc=session.get(URLS[1],f'BTC_{cycle}');eth=session.get(URLS[2],f'ETH_{cycle}')
        answer=exchange('qualified',cycle,btc=btc,eth=eth)
        outcomes.append({'cycle':cycle,'status':answer['outcome'],'offsetSeconds':offset})
        previous_end=clock()
    return outcomes

def main():
    root=Path(sys.argv[1]).resolve();a=strict_json((root/'ADMISSION.json').read_bytes())
    assert a['task']==TASK and a['family']=='trade' and a['jobRoot']==str(root) and a['synthetic'] is False
    validate_authority(a, root)
    assert 0<=time.time()-a['startedAtUnixSeconds']<=30
    for p,h in a['runtimeFiles'].items():assert digest((W/p).read_bytes())==h,p
    session=Session(root,a);incoming=queue.Queue()
    def reader():
        for line in sys.stdin:
            try:
                if len(line)>32768:raise ValueError('IPC bound')
                incoming.put(strict_json(line))
            except BaseException as e:incoming.put({'ok':False,'reason':str(e)})
        incoming.put({'ok':False,'reason':'Owner input closed'})
    threading.Thread(target=reader,daemon=True).start()
    def exchange(kind,cycle,**extra):
        session.check(31)
        msg={'type':kind,'cycle':cycle,'expiresAtUnixSeconds':time.time()+30,**extra}
        print(__import__('json').dumps(msg),flush=True)
        answer=incoming.get(timeout=30)
        if not answer.get('ok') or answer.get('cycle')!=cycle:raise ValueError('Owner refused: '+str(answer))
        return answer
    outcomes=[];status='PARTIAL';reason='Not completed'
    try:
        outcomes=collect(session,exchange)
        status='COMPLETE_FRESH_CYCLES' if all(o['status']=='QUALIFIED' for o in outcomes) else 'PARTIAL'
        reason='All original slots accounted'
    except BaseException as e:reason=type(e).__name__+': '+str(e)
    finally:session.close(reason)
    result={'status':status,'accounting':session.state,'cycles':outcomes,'networkSessionCount':1,'noAutomaticRestart':True}
    save(root/'RESULT.json',result)
    print(__import__('json').dumps({'type':'closed','result':result}),flush=True)
    return 0 if status.startswith('COMPLETE_') else 2
if __name__=='__main__':sys.exit(main())
