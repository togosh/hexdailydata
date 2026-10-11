"""Offline authority refusals, no runtime/base or network admission."""
import sys, socket, unittest
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(W/'scripts/trade-feed'),str(W/'scripts/unified-refresh'),str(W/'scripts/market-refresh')]
def denied(*args,**kwargs):raise AssertionError('Network forbidden')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=denied
from authority import trade_profile,validate_authority
from offline_profile import admitted,TASK,PROFILE

class Policy(unittest.TestCase):
    def test_exact_offline_profile_never_authorizes_public(self):
        a=dict(unifiedProfileId=PROFILE,authorityTaskId=TASK,synthetic=True,parentMode='OFFLINE_ONLY',parentProfileSha256='a'*64,
               family='trade',tradeSlot=16,tradeProfileId='unified-single-pair-1',responseCookiePolicyId='ignore-response-cookies-no-replay-v1',
               allowance=dict(seconds=400,httpAttempts=4,httpExtras=1,httpChargedBytes=4*2162688,chargedEntities=60000))
        self.assertTrue(admitted(a));p=trade_profile(a)
        self.assertEqual((p['cycles'],p['first_cycle'],p['attempts'],p['extras']),(1,16,4,1))
        with self.assertRaisesRegex(ValueError,'Exact recovery'):validate_authority(a,W/'synthetic/session')
        for key,value in [('synthetic',False),('parentMode','OWNER_AUTHORIZED_PUBLIC'),('authorityTaskId','HDD-BTC-ETH-OPERATING-REFRESH-R2')]:
            with self.assertRaises(ValueError):admitted({**a,key:value})
    def test_legacy_profile_unchanged(self):
        self.assertEqual(trade_profile({})['logical'],7)
        self.assertEqual(trade_profile(dict(authorityTaskId='HDD-BTC-ETH-OPERATING-REFRESH-R2',tradeProfileId='operating-16-slots-v1',job='trade-operating-16-slots',responseCookiePolicyId='ignore-response-cookies-no-replay-v1'))['logical'],33)

if __name__=='__main__':unittest.main()
