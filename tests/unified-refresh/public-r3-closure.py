"""Actual trade collector completion emitter; network denied, no bases."""
import sys,socket,json,tempfile,hashlib
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
T=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\unified-refresh-public-qualification-r3')
def deny(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=deny
sys.path[:0]=[str(W/'scripts/trade-feed'),str(W/'scripts/market-refresh')]
from collector import closure_frame
from public_profile import TASK,R3_PROFILE,authority
root=Path(tempfile.mkdtemp(prefix='closure-',dir=T/'fixtures'))
result={'status':'SYNTHETIC','diagnostic':'x'*40000};raw=(json.dumps(result)+'\n').encode();(root/'RESULT.json').write_bytes(raw)
for task in [TASK,authority(R3_PROFILE)['task'],'HDD-BTC-ETH-OPERATING-REFRESH-R2']:
 m=closure_frame(root,result,task,unified=task!='HDD-BTC-ETH-OPERATING-REFRESH-R2')
 assert set(m)=={'type','resultBytes','resultSha256'} and len(json.dumps(m))<32768
 assert m['resultBytes']==len(raw) and m['resultSha256']==hashlib.sha256(raw).hexdigest()
assert closure_frame(root,result,'HDD-BTC-ETH-OPERATING-REFRESH-R1')=={'type':'closed','result':result}
try:closure_frame(root,{'different':True},authority(R3_PROFILE)['task'],unified=True)
except ValueError:pass
else:raise AssertionError('Mismatched durable report accepted')
(root/'RESULT.json').write_bytes(b' '*524289)
try:closure_frame(root,result,authority(R3_PROFILE)['task'],unified=True)
except ValueError:pass
else:raise AssertionError('Oversized durable report accepted')
print(json.dumps({'status':'PASS','root':str(root),'cases':['R3 compact emitter','R2/operating R2 unchanged','older frame unchanged','durable mismatch refusal','size refusal'],'externalRequests':0,'baseAdmissions':0}))
