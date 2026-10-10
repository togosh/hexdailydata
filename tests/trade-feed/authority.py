"""Pure document gates for the exact recovery authority; no admission or network."""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import json,copy
W=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(W/'scripts/trade-feed'))
from client import digest,save
from authority import AUTHORITY,ROOT,validate_authority,validate_recovery_documents
scope=(ROOT/'packet/SCOPE.json').read_bytes()
pre=json.dumps({'authorityTaskId':AUTHORITY,'taskRoot':str(ROOT),'synthetic':False,'verdict':'PASS','runtimeFiles':{'public-fixture':'synthetic'}}).encode()
a={'authorityTaskId':AUTHORITY,'synthetic':False,'scopeSha256':digest(scope),'preflightSha256':digest(pre),'nonce':'0'*64,'runtimeFiles':{'public-fixture':'synthetic'}}
m={'authorityTaskId':AUTHORITY,'output':str(ROOT/'session'),'scopeSha256':digest(scope),'preflightSha256':digest(pre),'nonce':a['nonce']}
validate_recovery_documents(a,ROOT/'session',scope,pre,m)
cases=['matching document structure (in-memory only)']
def refused(call):
 try:call()
 except (ValueError,KeyError):return
 raise AssertionError('Expected refusal')
for key,value in [('authorityTaskId','old-task'),('synthetic',True),('scopeSha256','wrong'),('preflightSha256','wrong'),('nonce','changed'),('runtimeFiles',{})]:
 bad=copy.deepcopy(a);bad[key]=value
 refused(lambda:validate_recovery_documents(bad,ROOT/'session',scope,pre,m));cases.append('admission '+key+' substitution refused')
refused(lambda:validate_recovery_documents(a,ROOT.parent/'session',scope,pre,m));cases.append('new authority cannot use old session')
refused(lambda:validate_authority({'synthetic':False},ROOT/'session'));cases.append('old authority cannot use new session')
save(ROOT/'evidence/AUTHORITY_TESTS.json',{'status':'PASS','synthetic':True,'cases':cases,'publicAdmissions':0,'publicRequests':0,'baseAdmissions':0})
print('EXACT_AUTHORITY_GATES_PASS')
