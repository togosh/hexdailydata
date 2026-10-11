"""Real shared formatter boundaries. No network, base, or public admission."""
import sys,json,socket,tempfile,os
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2];T=Path(os.environ['HDD_TASK_ROOT']).resolve()
assert T.name=='unified-refresh-public-qualification-r4'
def deny(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=deny
sys.path[:0]=[str(W/'scripts/trade-feed'),str(W/'scripts/unified-refresh'),str(W/'scripts/market-refresh')]
from collector import closure_frame
from offline_profile import closed_frame,admitted
from public_profile import authority,R4_PROFILE,R3_PROFILE,PROFILE
from durable import digest,save
root=Path(tempfile.mkdtemp(prefix='completion-',dir=T/'fixtures'))
cases=[]
for size in [32769,524288]:
 value={'status':'SYNTHETIC_BOUNDARY','padding':''}
 raw=json.dumps(value,separators=(',',':')).encode();value['padding']='x'*(size-len(raw))
 raw=json.dumps(value,separators=(',',':')).encode();assert len(raw)==size
 (root/'RESULT.json').write_bytes(raw)
 expected={'type':'closed','resultBytes':size,'resultSha256':digest(raw)}
 assert closed_frame(root,value)==expected
 for profile in [PROFILE,R3_PROFILE,R4_PROFILE]:
  a=authority(profile)
  assert closure_frame(root,value,a['task'],unified=True)==expected
 assert closure_frame(root,value,'HDD-BTC-ETH-OPERATING-REFRESH-R2')==expected
 assert closure_frame(root,value,'HDD-BTC-ETH-OPERATING-REFRESH-R1')=={'type':'closed','result':value}
 assert len(json.dumps(expected).encode())<32768
 cases.append({'bytes':size,'frame':expected})
 for wrong in [{'different':True}, {**value,'padding':'wrong'}]:
  try:closed_frame(root,wrong)
  except ValueError:pass
  else:raise AssertionError('Content mismatch accepted')
(root/'RESULT.json').write_bytes(b' '*524289)
try:closed_frame(root,value)
except ValueError:pass
else:raise AssertionError('Over-limit accepted')
for a in [dict(unifiedProfileId='unknown'),dict(unifiedProfileId=R4_PROFILE),dict(unifiedProfileId='unified-five-feed-offline-1',authorityTaskId='wrong')]:
 try:admitted(a)
 except ValueError:pass
 else:raise AssertionError('Unadmitted mode accepted')
save(root/'CHECK.json',dict(status='PASS',cases=cases,refusals=['content mismatch','over-limit','unadmitted mode'],standaloneLegacyCompatible=True,externalRequests=0,baseAdmissions=0))
print(json.dumps(dict(status='PASS',root=str(root))))
