"""Actual isolated native worker prefix: synthetic, socket/DNS denied, no bases."""
import sys
sys.dont_write_bytecode = True
import json,os,time,hashlib
from pathlib import Path
W=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(W/'scripts/trade-feed'))
from client import native,save,TASK
T=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\transport-recovery-r1')
old=json.loads((T.parent/'continuation-r1/evidence/LOADED_RUNTIME.json').read_bytes())
bindings={p:hashlib.sha256((W/p).read_bytes()).hexdigest() for p in old['runtimeFiles']}
for p in (W/'scripts/trade-feed').glob('*.py'):
 bindings[p.relative_to(W).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
root=T/'fixtures'/('prefix-'+str(time.time_ns()));root.mkdir()
env={k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC')}
env.update(TEMP=str(root),TMP=str(root),PYTHONIOENCODING='utf-8')
results=[]
for name,mode,wait in [('prefix','--offline-prefix',27),('stall','--offline-stall',2)]:
 folder=root/name;attempt=folder/'01';attempt.mkdir(parents=True)
 start=time.time();request=attempt/'request.json'
 a={'task':TASK,'family':'trade','synthetic':True,'fixtureIdentity':'SYNTHETIC_OFFLINE_WORKER_PREFIX','jobRoot':str(folder),'nonce':'synthetic-only','startedAtUnixSeconds':start,'runtimeFiles':bindings}
 q={'method':'GET','url':'https://www.bitstamp.net/api/v2/markets/','attempt':1,'nonce':a['nonce'],'dispatchByUnixSeconds':start+535}
 save(folder/'ADMISSION.json',a);save(request,q);save(folder/'ACCOUNTING.json',{'status':'ADMITTED','pending':{'request':str(request)},'attempts':1})
 native_start=time.time();life=native([sys.executable,'-I','-S',str(W/'scripts/trade-feed/worker.py'),mode,str(request)],env,wait,2)
 events=[json.loads(l) for l in (attempt/'PHASES.ndjson').read_text().splitlines()] if (attempt/'PHASES.ndjson').exists() else []
 item={'test':name,'native':life,'events':events,'spawnToEntrySeconds':events[0]['unixSeconds']-native_start if events else None,'fixture':str(folder),'synthetic':True,'publicRequests':0,'baseAdmissions':0,'interpreter':sys.executable,'flags':['-I','-S'],'environmentNames':sorted(env)}
 results.append(item);save(folder/'NATIVE.json',item)
save(T/'evidence'/('PREFIX_DIAGNOSIS-'+str(time.time_ns())+'.json'),{'results':results,'bindings':bindings,'runtimeFiles':len(bindings),'publicRequests':0,'baseAdmissions':0})
print(json.dumps([{'test':x['test'],'seconds':x['native']['seconds'],'exit':x['native']['exit'],'timeout':x['native']['timeout'],'phases':[e['event'] for e in x['events']],'spawnToEntrySeconds':x['spawnToEntrySeconds']} for x in results]))
assert results[0]['native']['reaped'] and results[1]['native']['reaped']
assert results[0]['native']['exit']==0 and not results[0]['native']['timeout']
assert results[0]['events'][-1]['event']=='offline_prefix_complete'
assert results[1]['native']['timeout'] and results[1]['events'][-1]['event']=='synthetic_stall'
save(T/'evidence/WORKER_PREFIX_PASS.json',{'status':'PASS','results':results,'runtimeBindings':bindings,'synthetic':True,'publicRequests':0,'baseAdmissions':0})
