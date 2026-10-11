"""A parent pending reservation precedes each unchanged feed-specific HTTP gate."""
import sys,json,time,importlib.util
from pathlib import Path
HERE=Path(__file__).resolve().parent

def main():
    request=Path(sys.argv[1]).resolve();root=request.parents[2]
    a=json.loads((root/'ADMISSION.json').read_bytes())
    parent=json.loads((root.parent/'PARENT_ACCOUNTING.json').read_bytes())
    if (a['task']!='HDD-UNIFIED-REFRESH-OPERATION-R1' or parent['status']!='ADMITTED'
        or parent['job']!=a['job'] or parent['pending']['requestPath']!=str(request)
        or time.time()>=min(parent['networkClosesAtUnixSeconds'],a['networkClosesAtUnixSeconds'])):
        raise ValueError('Unbound/expired parent request')
    folder={'market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[a['family']]
    sys.path[:0]=[str(HERE),str(HERE.parent/folder),str(HERE.parent/'market-refresh')]
    from durable import digest
    if a.get('unifiedProfileId') is not None:
        from public_profile import is_public,validate_authority
        if not is_public(a):raise ValueError('Offline profile cannot perform network requests')
        validate_authority(a,root,request)
    if digest((root/'ADMISSION.json').read_bytes())!=parent['jobAdmissionSha256']:
        raise ValueError('Exclusive child admission changed')
    repo=HERE.parents[1]
    for path,h in a['runtimeFiles'].items():
        if digest((repo/path).read_bytes())!=h:raise ValueError('Frozen combined runtime changed')
    file=HERE.parent/folder/('http_worker.py' if a['family']=='market' else 'worker.py')
    spec=importlib.util.spec_from_file_location('bound_feed_worker',file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    module.main()

if __name__=='__main__':main()
