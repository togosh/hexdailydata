"""Focused saved-only startup/audit checks; no bases or network."""
import sys,json,hashlib,runpy,socket,copy
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
def deny(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=deny
def caches():
    return {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for top in ('scripts','tests') for p in (W/top).glob('*/__pycache__/*') if p.is_file()}
before=caches()
for filename in ('job.py','worker.py'):
    # Load the actual entry module with the interpreter's default bytecode policy.
    sys.dont_write_bytecode=False
    runpy.run_path(str(W/'scripts/unified-refresh'/filename),run_name='startup_check')
    assert sys.dont_write_bytecode is True
assert before==caches()
sys.path.insert(0,str(W/'scripts/unified-refresh'))
assert not any(Path(p)==W/'scripts/market-refresh' for p in sys.path)
import public_profile,audit_parent
assert public_profile.PROFILE=='unified-five-feed-public-qualification-2'
root=Path(sys.argv[1]).resolve();result=audit_parent.audit(root)
assert result['status']=='PASS' and result['totals']['chargedEntities']==20000
original=audit_parent.read;cases=[]
for field,value in [('complete',True),('closed',False),('bodyBytes',1),('wireBytes',1),('bodySha256','0'*64),('chargedObjects',0),('status',200),('transportComplete',True)]:
    def altered(p):
        v=original(p)
        if Path(p)==root/'trade-1/ACCOUNTING.json':
            v=copy.deepcopy(v);v['requests'][0][field]=value
        return v
    with patch.object(audit_parent,'read',altered):
        try:audit_parent.audit(root)
        except ValueError:pass
        else:raise AssertionError('Missing-body tamper accepted '+field)
    cases.append(field)
assert before==caches()
print(json.dumps(dict(status='PASS',externalRequests=0,baseAdmissions=0,cacheUnchanged=True,directImport=True,actualPartialAudit=result,refused=cases)))
