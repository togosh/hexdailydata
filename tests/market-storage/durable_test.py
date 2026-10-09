"""Changed durable consumer only; network blocked before importing maintained code."""
import socket,sys,tempfile,pathlib,json,hashlib
def blocked(*args,**kwargs):raise RuntimeError('OFFLINE_NO_NETWORK')
socket.socket=blocked;socket.getaddrinfo=blocked;socket.create_connection=blocked
R=pathlib.Path(sys.argv[1]);W=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(W/'scripts/market-refresh'))
sys.dont_write_bytecode=True
from durable import Storage
root=pathlib.Path(tempfile.mkdtemp(prefix='python-storage-',dir=R/'scratch'))
s=Storage(root,limit=1024**3)
s.put(root/'file',b'original');s.json(root/'state',{'test':'synthetic'})
assert s.used>0
try:s.check(1024**3)
except ValueError:pass
else:raise AssertionError('byte bound')
for i in range(8190):s.target(root/f'entry-{i}')
try:s.target(root/'too-many')
except ValueError:pass
else:raise AssertionError('entry bound')
assert (root/'file').read_bytes()==b'original'
result={'status':'PASS','synthetic':True,'externalRequests':0,'entries':len(s.entries),'root':str(root),'checks':['1 GiB finite capture cap','8192 entry cap','exact saved values','network blocked before import']}
(R/'evidence'/f'DURABLE_{root.name}.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
