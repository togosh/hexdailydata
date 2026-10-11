"""Exact live document refusal tests; no filesystem admission, bases, or networking."""
import sys,socket,json,copy,unittest,subprocess
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts/trade-feed'),str(W/'scripts/market-refresh')]
def deny(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=deny
from public_profile import *
config=authority(R3_PROFILE)
ROOT=config['root'];PROFILE=config['profile'];TASK=config['task'];PROFILE_HASH=config['profileHash'];PACKET=config['packet']

class Policy(unittest.TestCase):
    def test_standalone_bootstrap_has_no_unified_dependency(self):
        code="""import sys,socket
from pathlib import Path
def deny(*a,**k):raise AssertionError('NETWORK_DENIED')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=deny
w=Path.cwd()
sys.path[:0]=[str(w/'scripts/participant-refresh'),str(w/'scripts/market-refresh')]
import audit
assert 'public_profile' not in sys.modules
for plan in ({},{'unifiedProfileId':'unified-five-feed-offline-1'},{'unifiedProfileId':'unknown'}):
 assert audit.public_combined_schedule(Path('UNREAD_SYNTHETIC'),plan) is False
assert 'public_profile' not in sys.modules
print('STANDALONE_BOOTSTRAP_PASS')
"""
        p=subprocess.run([sys.executable,'-I','-S','-c',code],cwd=W,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=15)
        self.assertEqual(p.returncode,0,p.stdout.decode())
        self.assertIn(b'STANDALONE_BOOTSTRAP_PASS',p.stdout)
    def fixture(self):
        p=json.loads((ROOT/'packet/PUBLIC_PROFILE.json').read_bytes());j=p['jobs'][0];h='a'*64
        a=dict(unifiedProfileId=PROFILE,authorityTaskId=TASK,synthetic=False,parentMode='OWNER_AUTHORIZED_PUBLIC',parentProfileSha256=PROFILE_HASH,
               parentNonce=h,preflightSha256=h,job=j['id'],family=j['family'],jobRoot=str(ROOT/'session'/j['id']),parentLimits=p['parent'],allowance=j['bounds'].copy(),tradeSlot=1,
               nonce=h,scopeSha256=PACKET['packet/SCOPE.json'],runtimeFiles={},deadlineUnixSeconds=600,networkClosesAtUnixSeconds=560)
        marker=dict(taskId=TASK,output=str(ROOT/'session'),synthetic=False,nonce=h,preflightSha256=h,scopeSha256=PACKET['packet/SCOPE.json'],profileSha256=PROFILE_HASH)
        pre=dict(taskId=TASK,taskRoot=str(ROOT),synthetic=False,verdict='PASS',profileSha256=PROFILE_HASH,scopeSha256=PACKET['packet/SCOPE.json'],runtimeFiles={})
        ready=dict(status='PASS',actualPairedRegistry=True,freshProcess=True,runtimeHash=canonical_hash({}))
        review=dict(verdict='PASS',candidateCommit='c');plan=dict(commit='c',runtimeFiles={})
        parent=dict(taskId=TASK,status='ADMITTED',job=j['id'],nonce=h,profileSha256=PROFILE_HASH,preflightSha256=h,limits=p['parent'],startedAt='1970-01-01T00:00:00Z',networkClosesAtUnixSeconds=3420,rpcEndpointAttempts=[0,0],extraAttempts=0)
        for k in ('graphAttempts','rpcAttempts','httpAttempts','graphExtras','rpcExtras','httpExtras','attempts','chargedEntities','graphChargedBytes','rpcChargedBytes','httpChargedBytes'):parent[k]=0
        return [a,ROOT/'session'/j['id'],p,marker,pre,ready,review,plan,parent]
    def test_exact_documents_and_negative_bindings(self):
        validate_documents(*self.fixture())
        changes=[(0,'synthetic',True),(0,'jobRoot','wrong'),(0,'scopeSha256','wrong'),(0,'nonce','wrong'),(0,'parentNonce','b'*64),(0,'preflightSha256','b'*64),(0,'tradeSlot',16),
                 (0,'runtimeFiles',{'changed':'a'}),(0,'deadlineUnixSeconds',601),(2,'mode','OFFLINE_ONLY'),(3,'scopeSha256','x'),(4,'verdict','FAIL'),
                 (5,'freshProcess',False),(6,'candidateCommit','x'),(8,'status','CLOSED'),(8,'httpAttempts',1),(8,'chargedEntities',2120001),
                 (8,'httpChargedBytes',-1),(8,'rpcEndpointAttempts',[1,0]),(8,'networkClosesAtUnixSeconds',4000)]
        for index,key,value in changes:
            f=self.fixture();f[index][key]=value
            with self.subTest(key=key),self.assertRaises((ValueError,KeyError)):validate_documents(*f)
        f=self.fixture();f[0]['allowance']['publication']=0
        with self.assertRaises(ValueError):validate_documents(*f)
        f=self.fixture();f[2]['jobs'][-1]['target']+=1
        with self.assertRaises(ValueError):validate_documents(*f)

if __name__=='__main__':unittest.main()
