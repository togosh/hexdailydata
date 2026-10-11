"""Fresh actual job.main import sequence, stopped before Session construction."""
import sys,json,hashlib,socket,builtins,importlib
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2];family=sys.argv[1]
folder={'market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[family]
T=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\unified-refresh-public-qualification-r2')
root=T/'fixtures/operating-qualification-lFioNQ/session'/(family+'-1')
a=json.loads((root/'ADMISSION.json').read_bytes());a['runtimeFiles']={};raw=json.dumps(a).encode()
p=json.loads((root.parent/'PARENT_ACCOUNTING.json').read_bytes())
p.update(status='ADMITTED',job=a['job'],pending=None,jobAdmissionSha256=hashlib.sha256(raw).hexdigest())
def denied(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=denied
original_read=Path.read_bytes;original_exists=Path.exists;original_import=builtins.__import__
def read(path):
 if path==root/'ADMISSION.json':return raw
 if path==root.parent/'PARENT_ACCOUNTING.json':return json.dumps(p).encode()
 return original_read(path)
class Passed(Exception):pass
def imported(name,*args,**kwargs):
 module=original_import(name,*args,**kwargs)
 if name=='collector':
  assert Path(module.__file__).resolve()==W/'scripts'/folder/'collector.py',module.__file__
  if family!='market':
   session=importlib.import_module('session')
   assert Path(session.__file__).resolve()==W/'scripts'/folder/'session.py',session.__file__
  raise Passed()
 return module
sys.path.insert(0,str(W/'scripts/unified-refresh'))
import job
sys.argv=['job.py',str(root)]
with patch.object(Path,'read_bytes',read),patch.object(Path,'exists',lambda path:False if path==root/'ACCOUNTING.json' else original_exists(path)),patch.object(builtins,'__import__',imported):
 try:job.main(offline_fixture=True)
 except Passed:pass
 else:raise AssertionError('Actual job entry did not reach selected collector')
print(json.dumps(dict(status='PASS',family=family,actualJobMain=True,freshInterpreter=True,collector=folder,stoppedBeforeSession=True,externalRequests=0,baseAdmissions=0)))
