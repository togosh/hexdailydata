"""Offline native child harness: actual job and worker gates, injected HTTP boundary."""
import sys,os,json,importlib.util,socket
from pathlib import Path
W=Path(__file__).resolve().parents[2];root=Path(sys.argv[1]).resolve();a=json.loads((root/'ADMISSION.json').read_bytes());family=a['family']
assert a['synthetic'] and 'native-composed-' in str(root)
folder='gas-feed' if family=='gas' else 'participant-refresh'
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts'/folder),str(W/'scripts/market-refresh')]
os.environ['HDD_TASK_ROOT']=str(root)
if family=='participants':(root/'SCOPE.json').write_bytes((root/'PLAN.json').read_bytes())
spec=importlib.util.spec_from_file_location('fixture',W/'tests'/folder/'client_test.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
if family=='participants':
    fixture.PLAN=json.loads((root/'PLAN.json').read_bytes())
    fixture.PLAN['finalTarget']={'number':27754425,'hash':'0x'+format(27754425,'064x'),'timestamp':fixture.PLAN['base']['timestamp']+40960}
    class Empty(fixture.Fixture):
        def data_rows(self,*args,**kwargs):return []
    transport=Empty(fixture.Clock(),holders=0)
else:transport=fixture.Transport()
import capture_client
from durable import save,strict_json
import worker as feed_worker
spec=importlib.util.spec_from_file_location('unified_gate',W/'scripts/unified-refresh/worker.py');gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
original_spec=importlib.util.spec_from_file_location
current=None
def injected_perform(method,url,body,body_path,meta_path,*args,**kwargs):
    global current
    assert current is not None
    request,deadline,storage=current
    assert method=='POST' and body==(request.parent/'request.body').read_bytes()
    result=transport(request,deadline,storage);save(meta_path,result)
def wrapped_spec(name,*args,**kwargs):
    spec=original_spec(name,*args,**kwargs)
    if name=='bound_feed_worker':
        execute=spec.loader.exec_module
        def load(module):execute(module);module.perform=injected_perform
        spec.loader.exec_module=load
    return spec
importlib.util.spec_from_file_location=wrapped_spec
class Injected:
    def __init__(self,nonce,**kwargs):self.nonce=nonce
    def __call__(self,request,deadline,storage):
        global current
        current=(Path(request),deadline,storage)
        argv=sys.argv;sys.argv=['worker',str(request),str(request.parent/'response.body'),str(request.parent/'transport.json'),self.nonce]
        try:gate.main()
        finally:sys.argv=argv;current=None
        return strict_json((request.parent/'transport.json').read_bytes())
capture_client.WorkerTransport=Injected
import job
raise SystemExit(job.main(offline_fixture=True))
