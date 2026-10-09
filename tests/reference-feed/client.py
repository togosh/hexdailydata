"""Synthetic actual collector/session/capture/auditor composition, with network denied."""
import sys, os, time, json, unittest, socket, subprocess, tempfile, copy
sys.dont_write_bytecode = True
from pathlib import Path
W = Path(__file__).resolve().parents[2]
R = Path(os.environ['HDD_TASK_ROOT'])
def forbidden(*a, **k): raise AssertionError('Offline network/child forbidden')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = subprocess.Popen = forbidden
sys.path[:0] = [str(W / 'scripts/reference-feed'), str(W / 'scripts/market-refresh')]
from durable import strict_json, encode, digest
from protocol import *
from session import ReferenceSession
from collector import run_cycles
from audit import audit_round, audit_captures, qualify
from capture_client import Stop, LimitReached
def word(n): return format(n % 2**256, '064x')
def abi(*ns): return '0x' + ''.join(map(word, ns))
def envelope(v): return {'jsonrpc':'2.0','id':1,'result':v}
class Clock:
    def __init__(self): self.n=0; self.waits=[]
    def __call__(self): return self.n
    def sleep(self,n): self.n+=n; self.waits.append(n)
class Transport:
    def __init__(self, replies=None, drift=None, new=False):
        self.replies=iter(replies) if replies is not None else None
        self.drift=drift; self.new=new; self.queries=[]; self.timestamp=int(time.time())-30
    def __call__(self,path,deadline,storage):
        q=strict_json(path.read_bytes())['job']; self.queries.append(q); status=200
        if self.replies is not None:
            v=next(self.replies)
            if isinstance(v,tuple): status,v=v
            if isinstance(v,str) and v in ('timeout','network','unknown'):
                return {'childReaped':v!='unknown','connectionClosed':v!='unknown','complete':False,'failureKind':'transport_timeout' if v=='timeout' else v}
            raw=v if isinstance(v,bytes) else encode(v)
        else:
            m,p,c,ep=q['method'],q['params'],q['cycle'],q['endpoint']; k=kind(q); n=23700100+c*10
            asset=next((a for a,proxy in FEEDS.items() if (p[0]['to'] if m=='eth_call' else p[0] if m=='eth_getCode' else None)==proxy),None)
            if m=='eth_chainId': v='0x1'
            elif m=='eth_getBlockByNumber':
                n=n+2 if p[0]=='latest' else int(p[0],16)
                v={'number':hex(n),'timestamp':hex(self.timestamp),'hash':'0x'+word(n),'parentHash':'0x'+word(n-1),'transactions':[]}
                if self.drift=='header' and q['phase']=='close': v['hash']='0x'+'a'*64
            elif m=='eth_getCode': v='0x6001600055'
            elif k=='decimals': v=abi(8)
            elif k=='description':
                desc=(asset+' / USD').encode(); v=abi(32,len(desc))+desc.ljust(32,b'\0').hex()
            elif k=='aggregator': v=abi(123 if asset=='BTC' else 456)
            elif k=='round':
                t=self.timestamp-(400 if asset=='BTC' else 10)
                v=abi(100+(c-1 if self.new else 0), 6000012345678 if asset=='BTC' else 300012345678,t-1,t,1)
                if self.drift=='provider' and ep==1: v=abi(100,123,t-1,t,1)
                if self.drift=='round-close' and q['phase']=='close-round': v=abi(101,123,t-1,t,1)
                if self.drift=='old': v=abi(100,123,t-90001,t-90000,1)
            if self.drift=='identity' and c==2 and k=='aggregator': v=abi(999)
            raw=encode(envelope(v))
        (path.parent/'response.body').write_bytes(raw)
        return {'status':status,'complete':True,'framingValidated':True,'connectionClosed':True,'childReaped':True,'headers':[['Content-Length',str(len(raw))]],'expectedBodyBytes':len(raw),'framingKind':'content-length','wireBodyBytes':len(raw),'wireBodySha256':digest(raw)}
class Tests(unittest.TestCase):
    def session(self,tr):
        d=R/'evidence/fixtures'; d.mkdir(exist_ok=True)
        p=Path(tempfile.mkdtemp(prefix='reference-',dir=d)); c=Clock()
        return ReferenceSession(p,tr,c,c.sleep,True),c
    def test_composed_two_cycles_noop_and_new_round(self):
        for new in (False,True):
            s,c=self.session(Transport(new=new)); result=run_cycles(s,lambda m,d:{'ok':True,'cycle':m['cycle']})
            s.close('synthetic complete'); self.assertEqual(s.state['attempts'],62)
            samples=[]
            for i in (1,2):
                sample=strict_json((s.root/f'ROUND_{i}_SAMPLE.json').read_bytes()); proof,u=audit_round(s.root,sample,s.state)
                self.assertEqual(len(u['readings']),2); self.assertNotEqual(u['readings'][0]['observedAtUtc'],u['readings'][1]['observedAtUtc'])
                samples.append({'proof':proof,'update':u})
            self.assertEqual(samples[1]['proof']['details']['sameRound'],{'BTC':not new,'ETH':not new})
            (R/f'evidence/SYNTHETIC_REFERENCE_{"NEW" if new else "NOOP"}.json').write_bytes(encode({'status':'PASS','synthetic':True,'root':str(s.root),'samples':samples,'accounting':s.state,'externalRequests':0}))
    def test_actual_client_rejects_before_publication(self):
        for drift in ('provider','header','round-close','old','identity'):
            s,c=self.session(Transport(drift=drift)); acks=[]
            with self.assertRaises((Stop,ValueError)):
                run_cycles(s,lambda m,d:acks.append(m) or {'ok':True,'cycle':m['cycle']})
            self.assertEqual(len([x for x in acks if x['type']=='qualified']),1 if drift=='identity' else 0)
            s.close('synthetic rejected '+drift)
    def test_exact_abi_and_rpc_rejections(self):
        q=job(0,'eth_call',call('BTC','round',23700100),1,'round')
        good=[1,123,99,100,0]
        for index,value in [(0,0),(0,2**80),(1,-1),(1,0),(3,0),(2,101),(4,2**80)]:
            w=good[:];w[index]=value
            with self.assertRaises(ValueError):validate_rpc(q,envelope(abi(*w)))
        for data in (abi(*good)+'00',abi(*good)[:-2],'0x','xyz'):
            with self.assertRaises(ValueError):validate_rpc(q,envelope(data))
        for method,value in [('decimals',abi(18)),('aggregator',abi(0)),('aggregator',abi(2**160)),('description',abi(64,9,0)),('description',abi(32,9)+b'ETH / USD'.ljust(32,b'\0').hex())]:
            with self.assertRaises(ValueError):validate_rpc(job(0,'eth_call',call('BTC',method,23700100),1,method),envelope(value))
        for q,value in [(job(0,'eth_chainId',[]),'0x171'),(job(0,'eth_getCode',[FEEDS['BTC'],'0x169a2e4'],1,'code'),'0x')]:
            with self.assertRaises(ValueError):validate_rpc(q,envelope(value))
        for bad in ([{'to':FEEDS['BTC'],'data':SELECTORS['round']},'latest'],[{'to':FEEDS['BTC'],'data':SELECTORS['round']},{'blockHash':'0x'+'a'*64}],[{'to':'0x'+'1'*40,'data':SELECTORS['round']},'0x169a2e4']):
            with self.assertRaises((ValueError,TypeError)):job(0,'eth_call',bad,1,'round')
    def test_times_rounds_utc_and_precision(self):
        t=1791503999; r={'roundId':'1','answer':'12345678901234567890','startedAt':str(t-1),'updatedAt':str(t),'answeredInRound':'0'}
        x=reading('BTC',r,{'timestamp':t+1},t+2);self.assertEqual(x['value'],'123456789012.3456789')
        for now,pin in [(t-1,t),(t+86401,t),(t,t-1)]:
            with self.assertRaises(ValueError):reading('BTC',r,{'timestamp':pin},now)
        self.assertTrue(compare_round(r,r)); self.assertFalse(compare_round(r,{**r,'roundId':'2'}))
        for bad in ({**r,'roundId':'0'},{**r,'answer':'2'},{**r,'roundId':'2','updatedAt':str(t-1)},{**r,'roundId':'2','answer':'2'}):
            with self.assertRaises(ValueError):compare_round(r,bad)
        before=1791504000-1; after=before+1
        self.assertNotEqual(reading('BTC',{**r,'updatedAt':str(before)},{'timestamp':after},after)['observedAtUtc'][:10],reading('ETH',{**r,'updatedAt':str(after)},{'timestamp':after},after)['observedAtUtc'][:10])
    def test_retries_and_conservative_unknowns(self):
        q=job(0,'eth_chainId',[]);ok=envelope('0x1')
        s,c=self.session(Transport(['timeout','network',ok]));s.request(q)
        self.assertEqual(s.state['extraAttempts'],2);self.assertIn(5,c.waits);self.assertIn(15,c.waits)
        self.assertEqual(s.state['chargedBytes'],16384+len(encode(ok)));self.assertEqual(s.state['unknownEntityReservations'],80)
        audit_captures(s.root,s.state);s.close('synthetic retries')
        for value in ['unknown',b'{"id":1,"id":1}',(503,{'jsonrpc':'2.0','id':1,'error':{'code':-1,'message':'x'}}),(429,{'message':'rate limit'})]:
            s,c=self.session(Transport([value]))
            with self.assertRaises(Stop):s.request(q)
            self.assertEqual(s.state['attempts'],1);self.assertEqual(s.state['extraAttempts'],0);s.close('synthetic terminal')
        s,c=self.session(Transport([(503,{'message':'temporary gateway'}),ok]));s.request(q);audit_captures(s.root,s.state);s.close('synthetic gateway')
    def test_reservations_and_saved_audit_tamper(self):
        for field,value in [('attempts',79),('chargedBytes',12582911),('chargedEntities',19999),('extraAttempts',8)]:
            s,c=self.session(Transport());s.state[field]=value
            with self.assertRaises((LimitReached,Stop)):s.request(job(0,'eth_chainId',[]))
            self.assertEqual(s.state['attempts'],79 if field=='attempts' else 0);s.close('synthetic cap')
        s,c=self.session(Transport());c.n=1070
        with self.assertRaises(LimitReached):s.request(job(0,'eth_chainId',[]))
        self.assertEqual(s.state['attempts'],0);s.close('synthetic deadline')
        s,c=self.session(Transport());run_cycles(s,lambda m,d:{'ok':True,'cycle':m['cycle']})
        sample=strict_json((s.root/'ROUND_1_SAMPLE.json').read_bytes());captures,_=audit_captures(s.root,s.state)
        bad=copy.deepcopy(sample);bad['selectedBlock']+=1
        with self.assertRaises(ValueError):qualify(bad,captures)
        bad=copy.deepcopy(sample);bad['calls']['BTC-round0']=bad['calls']['ETH-round0']
        with self.assertRaises(ValueError):qualify(bad,captures)
        s.close('synthetic audit tamper rejected')
if __name__=='__main__':unittest.main()
