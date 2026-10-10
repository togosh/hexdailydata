"""One exact request. No retries or task admission of its own."""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import importlib.util
sys.path.insert(0,str(Path(__file__).resolve().parent))
from client import W,TASK,exact_request,strict_json,digest,CAP

def main():
    request=Path(sys.argv[1]).resolve();session=request.parent.parent
    q=strict_json(request.read_bytes());a=strict_json((session/'ADMISSION.json').read_bytes());s=strict_json((session/'ACCOUNTING.json').read_bytes())
    exact_request(q['method'],q['url'])
    assert a['task']==TASK and a['family']=='trade' and a['synthetic'] is False and a['jobRoot']==str(session)
    assert q['nonce']==a['nonce'] and s['status']=='ADMITTED' and s['pending']['request']==str(request) and s['attempts']==q['attempt']
    for p,h in a['runtimeFiles'].items():assert digest((W/p).read_bytes())==h,p
    spec=importlib.util.spec_from_file_location('bounded_get',W/'scripts/benchmark-reference/get_worker.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    m.CAP=CAP
    m.perform(q['url'],request.parent)
if __name__=='__main__':main()

