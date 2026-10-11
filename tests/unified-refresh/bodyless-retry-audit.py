"""Saved replay of actual client timeout/retry, including refusal guards."""
import sys,json,socket,copy
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/unified-refresh'))
import audit_parent
def deny(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=deny
root=Path(sys.argv[1]).resolve();result=audit_parent.audit(root)
assert result['totals']['attempts']==4 and result['totals']['httpExtras']==1
assert result['totals']['unknownEntityReservations']==20000 and result['totals']['httpChargedBytes']==8650752
original=audit_parent.read;cases=[]
for field,value in [('failureKind','terminal'),('retryOrdinal',1),('phaseSha256','0'*64)]:
 def altered(p):
  v=original(p)
  if Path(p)==root/'trade-1/ACCOUNTING.json':v=copy.deepcopy(v);v['requests'][0][field]=value
  if Path(p)==root/'trade-1/01/AUDIT.json':v=copy.deepcopy(v);v[field]=value
  return v
 with patch.object(audit_parent,'read',altered):
  try:audit_parent.audit(root)
  except ValueError:pass
  else:raise AssertionError('Retry tamper accepted '+field)
 cases.append(field)
exists=Path.exists
with patch.object(Path,'exists',lambda p:False if p==root/'trade-1/02/response.body' else exists(p)):
 try:audit_parent.audit(root)
 except ValueError:pass
 else:raise AssertionError('Missing successful body accepted')
print(json.dumps(dict(status='PASS',externalRequests=0,baseAdmissions=0,actualPartialThenSuccess=result,refused=cases+['missing successful body'])))
