"""Actual saved participant window and synthetic refusal mutations; no writes/network/bases."""
import sys,json,copy,socket,hashlib
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts/participant-refresh'),str(W/'scripts/market-refresh')]
import audit
def denied(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=denied
root=Path(sys.argv[1]).resolve();read=lambda p:json.loads(p.read_bytes())
plan=read(root/'RESOLVED_PLAN.json');state=read(root/'ACCOUNTING.json')
before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
proof=audit.audit_window(root,1,plan,state);assert proof['complete']
rows=[json.loads(x) for x in (root/'LEDGER.jsonl').read_bytes().splitlines()]
previous=rows[10];query=rows[11]['job'];assert previous['retryIndex']==2 and rows[11]['retryIndex']==3
assert audit.retry_maximum(query,previous,False,True)==5
assert audit.retry_maximum(query,previous,False,False)==2
cases=[]
for name,q,p in [('control',{**query,'phase':'control'},previous),('rpc',{**query,'kind':'rpc'},previous),('unknown-error',query,{**previous,'classification':'unknown'}),('error-with-data',query,{**previous,'usable':True}),('unclosed',query,{**previous,'closureKnown':False})]:
 assert audit.retry_maximum(q,p,False,True)==2;cases.append(name)
assert 6>audit.retry_maximum(query,previous,False,True);cases.append('sixth-extra-refused')
original=Path.read_bytes
for name,target,mutation in [
 ('wrong-authority','ADMISSION.json',lambda x:x.__setitem__('authorityTaskId','wrong')),
 ('wrong-plan-binding','ADMISSION.json',lambda x:x.__setitem__('planSha256','0'*64)),
 ('altered-query','LEDGER.jsonl',lambda x:x[11]['job'].__setitem__('query',x[11]['job']['query']+' ')),
 ('shortened-wait','LEDGER.jsonl',lambda x:x[11].__setitem__('startOffsetSeconds',x[10]['startOffsetSeconds']+x[10]['durationSeconds']+119)),
 ('excessive-ordinal','LEDGER.jsonl',lambda x:x[11].__setitem__('retryIndex',6)),
]:
 def changed(p):
  b=original(p)
  if p==root/target:
   x=[json.loads(l) for l in b.splitlines()] if target.endswith('jsonl') else json.loads(b)
   mutation(x);return (b'\n'.join(json.dumps(r).encode() for r in x)+b'\n') if target.endswith('jsonl') else json.dumps(x).encode()
  return b
 with patch.object(Path,'read_bytes',changed):
  try:audit.audit_window(root,1,plan,state)
  except ValueError:pass
  else:raise AssertionError('Mutation accepted: '+name)
 cases.append(name)
legacy=copy.deepcopy(plan);legacy['unifiedProfileId']='unified-five-feed-offline-1'
try:audit.audit_window(root,1,legacy,state)
except ValueError as e:assert str(e)=='One exact retry ordinal'
else:raise AssertionError('Historical profile broadened')
cases.append('historical-policy-unchanged')
assert before=={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
print(json.dumps(dict(status='PASS',savedActualWindow=True,sourceCounts=read(root/'WINDOW_1_SEAL.json')['sourceCounts'],syntheticRefusals=cases,originalFilesUnchanged=True,externalRequests=0,baseAdmissions=0,publication=False)))
