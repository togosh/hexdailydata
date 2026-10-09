"""Finite serial current collector. Publication is acknowledged through bounded stdio."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import json,time,secrets,threading,queue
from durable import strict_json,encode,digest,save,utc
from task_queries import SCOPE,rpc_job
from capture_client import Session,WorkerTransport,Stop,LimitReached
from current import descriptors,common_pin,current_round,ask,recorded,close_pin
ROOT=Path(__file__).resolve().parent

def source_binding():
    return {p.name:digest(p.read_bytes()) for p in sorted(ROOT.iterdir()) if p.suffix in ('.py','.json')}

def run_cycles(s,maximum,exchange,previous):
    from audit_market import audit
    schemas={ep:strict_json((ROOT/f'SCHEMA_{ep}.json').read_bytes()) for ep in (0,1)}
    for ep,sc in schemas.items():recorded(s,f'SCHEMA_{ep}.json',sc)
    accepted=[];last_start=None;prior_round=None
    for ordinal in range(1,maximum+1):
        if last_start is not None:s.sleep(max(0,60-(s.clock()-last_start)))
        if s.clock()-s.started>=1500:raise LimitReached('New cycle admission cutoff')
        s.cycle_started=s.clock();s.cycle_ordinal=ordinal;s.controls=descriptors();last_start=s.cycle_started
        s.phase_check(rpc_job(0,'eth_blockNumber',[]),s.liabilities(rpc_job(0,'eth_blockNumber',[]),0))
        exchange({'type':'begin','cycle':ordinal},min(s.cycle_started+1200,s.deadline))
        if ordinal==1:
            for ep in (0,1):ask(s,rpc_job(ep,'eth_chainId',[]))
        pin=common_pin(s,schemas,ordinal,previous)
        if pin is None:
            s.sleep(15);pin=common_pin(s,schemas,ordinal,previous)
        if pin is None:
            recorded(s,f'ROUND_{ordinal}_NO_ADVANCE.json',{'status':'NO_ADVANCE','headChecks':2})
            exchange({'type':'no-advance','cycle':ordinal},min(s.cycle_started+1200,s.deadline))
            return {'status':'NO_ADVANCE','rounds':len(accepted),'integrityClosed':True}
        sealed=current_round(s,schemas,pin,ordinal,prior_round)
        c=sealed['current']
        if c['hexPriceUsd'] is None or c['trackedLiquidityUsd'] is None:raise Stop('Economic qualification refused; trial terminal')
        s.persist()
        checkpoint={'accounting':dict(s.state),'networkSessionCount':1,'rounds':ordinal,'integrityClosed':True}
        s.storage.json(s.root/'CHECKPOINT.json',checkpoint,replace=(s.root/'CHECKPOINT.json').exists())
        proof,updates=audit(s.root,synthetic=s.state['mode']=='SYNTHETIC_OFFLINE_TEST',active=True)
        recorded(s,f'ROUND_{ordinal}_AUDIT.json',proof)
        update=updates[-1];recorded(s,f'ROUND_{ordinal}_UPDATE.json',update)
        result=exchange({'type':'qualified','cycle':ordinal,'update':f'ROUND_{ordinal}_UPDATE.json','updateSha256':digest(encode(update)),'pin':pin,'sealedAt':sealed['sealedAt']},min(s.cycle_started+1200,s.deadline))
        if s.clock()>min(s.cycle_started+1200,s.deadline):raise Stop('Publication cycle deadline')
        recorded(s,f'ROUND_{ordinal}_PUBLICATION_ACK.json',result)
        accepted.append(result);previous=pin;prior_round=sealed
    return {'status':'COMPLETE_FINITE_TRIAL','rounds':len(accepted),'integrityClosed':True}

def execute(mode,output,binding_path,test_transport=None,test_clock=None,test_sleep=None):
    root=Path(output).resolve();synthetic=test_transport is not None
    binding=strict_json(Path(binding_path).read_bytes())
    if binding['verdict']!='PASS' or binding['sourceFiles']!=source_binding():raise ValueError('Missing/changed preflight')
    if bool(binding.get('synthetic'))!=synthetic:raise ValueError('Synthetic binding cannot launch public transport')
    base_bytes=(Path(binding_path).parent/'BASE_PIN.json').read_bytes()
    if digest(base_bytes)!=binding['basePinSha256']:raise ValueError('Base pin binding')
    previous=strict_json(base_bytes)
    if str(root)!=binding['trialRoot']:raise ValueError('Trial root binding')
    if root.exists():raise ValueError('Existing/uncertain trial; no restart')
    root.mkdir();(root/'temp').mkdir();nonce=secrets.token_hex(32)
    save(root/'ADMISSION.json',{'task':SCOPE['taskId'],'nonce':nonce,'recordedAt':utc(),'sourceFiles':source_binding(),'preflightSha256':digest(Path(binding_path).read_bytes()),'mode':mode})
    s=Session(root,test_transport,test_clock,test_sleep,True) if synthetic else Session(root,WorkerTransport(nonce))
    # One finite output has a conservative 1 GiB reservation in the local serving
    # store before this worker starts. Unknown charges are never refunded.
    s.storage.limit=min(s.storage.limit,1024**3)
    incoming=queue.Queue()
    def reader():
        try:
            for line in sys.stdin:incoming.put(strict_json(line))
        finally:incoming.put(None)
    threading.Thread(target=reader,daemon=True).start()
    def exchange(message,deadline):
        allowance=max(.001,min(30,deadline-s.clock()))
        message['expiresAtUnixSeconds']=time.time()+allowance
        print(json.dumps(message),flush=True)
        try:answer=incoming.get(timeout=allowance)
        except queue.Empty:raise Stop('Publication/controller acknowledgement deadline')
        if not isinstance(answer,dict) or answer.get('cycle')!=message['cycle'] or answer.get('ok') is not True:raise Stop('Controller failed/unknown: '+str(answer))
        return answer
    try:
        result=run_cycles(s,1 if mode=='once' else 3,exchange,previous)
    except BaseException as exc:
        # Safe limit refusals may still settle the opened pin; no new cycle retry.
        if isinstance(exc,LimitReached) and not s.failed and s.state['pending'] is None and not s.closing and getattr(s,'opened_round',None):
            try:
                o=s.opened_round;s.controls=[c for c in descriptors() if c['kind']!='pools' or c['endpoint'] in o['opening']]
                controls=close_pin(s,o['schemas'],o['pin'],o['opening']);recorded(s,f"ROUND_{o['ordinal']}_CLOSED_INCOMPLETE.json",{'pin':o['pin'],'controls':controls,'promotable':False})
            except BaseException as closing:exc=Stop(str(exc)+'; closure '+str(closing))
        result={'status':'PARTIAL','failure':type(exc).__name__+': '+str(exc),'integrityClosed':False,'rounds':len(list(root.glob('ROUND_*_PUBLICATION_ACK.json')))}
    finally:
        s.close(result.get('failure','Finite current trial settled'))
        result.update(accounting=s.state,networkSessionCount=1,noAutomaticRestart=True,indexer='PARKED')
        recorded(s,'RESULT.json',result);print(json.dumps({'type':'closed','result':result}),flush=True)
    return 0 if result['status']=='COMPLETE_FINITE_TRIAL' else 2
def main():
    if len(sys.argv)!=4 or sys.argv[1] not in ('once','trial'):
        print('Explicit once|trial OUTPUT BINDING required; no requests made.');return 2
    return execute(*sys.argv[1:])
if __name__=='__main__':sys.exit(main())
