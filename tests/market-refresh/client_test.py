"""Focused actual client/current/auditor tests. All network and children forbidden."""
import sys,os,json,unittest,tempfile,socket,subprocess,hashlib
from pathlib import Path
from copy import deepcopy
from decimal import Decimal,localcontext
W=Path(__file__).resolve().parents[2];R=Path(os.environ['HDD_TASK_ROOT'])
sys.path.insert(0,str(W/'scripts/market-refresh'))
def forbidden(*a,**k):raise AssertionError('Offline network/child forbidden')
socket.getaddrinfo=forbidden;socket.create_connection=forbidden;socket.socket.connect=forbidden;subprocess.Popen=forbidden
from durable import encode,strict_json
from task_queries import graph_job,rpc_job,validate_job,POOLS,FOCUS,SELECTORS,SCOPE
from capture_client import Session,Stop,LimitReached
from collector import run_cycles,source_binding
from current import descriptors
from audit_market import audit
from market import normalize,validate_pool_rpc,qualify,dec,IntegrityError
SC=[strict_json((W/f'scripts/market-refresh/SCHEMA_{ep}.json').read_bytes()) for ep in (0,1)]
SAVED=strict_json((R/'reference/ROUND_2_SEALED.json').read_bytes());PIN=SAVED['pin']
ERR={'errors':[{'message':'Store error: database unavailable'}]}
def pools():return [normalize(deepcopy(f['originalPool']),SC[f['graphEndpointIndex']]['recipe'],f['bundles'],f['graphEndpointIndex'],PIN) for f in FOCUS['pools']]
def checks(p):
    with localcontext() as c:
        c.prec=384;raw=[str(int(dec(v)*(Decimal(10)**d))) for v,d in zip(p['normalizedReserves'],p['decimals'])]
    return {'token0()':p['tokenIds'][0],'token1()':p['tokenIds'][1],'factory()':'0x'+'5'*40,'getReserves()':raw+['1']}
class Clock:
    def __init__(self):self.n=0;self.waits=[]
    def __call__(self):return self.n
    def sleep(self,n):self.waits.append(n);self.n+=n
class Transport:
    def __init__(self,replies):self.replies=iter(replies);self.queries=[]
    def __call__(self,path,deadline,storage):
        q=strict_json(path.read_bytes())['job'];self.queries.append(q);raw=encode(next(self.replies));(path.parent/'response.body').write_bytes(raw)
        return {'status':200,'complete':True,'framingValidated':True,'connectionClosed':True,'childReaped':True,'headers':[['Content-Length',str(len(raw))]],'expectedBodyBytes':len(raw),'framingKind':'content-length','expectedBodyBytesBasis':'content-length','wireBodyBytes':len(raw),'wireBodySha256':hashlib.sha256(raw).hexdigest()}
class Composed(Transport):
    def __init__(self,lag=False,drift=False,null=False,exhaust=False):
        super().__init__([]);self.heads=[0,0];self.lag=lag;self.drift=drift;self.null=null;self.exhaust=exhaust;self.pool_reads={}
    def __call__(self,path,deadline,storage):
        q=strict_json(path.read_bytes())['job'];ep=q['endpoint'];kind=q['kind']
        if kind=='rpc':
            m=q['method'];params=q['params']
            if m=='eth_chainId':value=hex(369)
            elif m=='eth_blockNumber':self.heads[ep]+=1;value=hex(PIN['number']+12+(0 if self.lag else self.heads[ep]*20))
            elif m=='eth_getBlockByNumber':
                n=int(params[0],16);value=None if self.null else {'number':hex(n),'hash':'0x'+format(n,'064x'),'parentHash':'0x'+format(n-1,'064x'),'timestamp':hex(PIN['timestamp']+(n-PIN['number'])*10)}
            else:
                target=params[0]['to'];selector=params[0]['data']
                if selector==SELECTORS['decimals()']:vals=[next(int(f['originalPool'][k]['decimals']) for f in FOCUS['pools'] for k in ('token0','token1') if f['originalPool'][k]['id']==target)]
                else:
                    p=next(p for p in pools() if p['address']==target);v=checks(p)[next(k for k,v in SELECTORS.items() if v==selector)];vals=[int(x) for x in v] if isinstance(v,list) else [int(v,16)]
                value='0x'+''.join(format(n,'064x') for n in vals)
            response={'jsonrpc':'2.0','id':1,'result':value}
        else:
            assert kind in ('pools','meta')
            pin=q['pin'];data={'_meta':{'deployment':SCOPE['expectedDeployments'][ep],'hasIndexingErrors':False,'block':{'number':pin['number'] if pin else PIN['number']+12+(0 if self.lag else self.heads[ep]*20),'hash':pin['hash'] if pin else None,'timestamp':None}}}
            if kind=='pools':
                items=[deepcopy(POOLS[a]['originalPool']) for a in q['addresses']]
                for row in items:row.update(block=str(pin['number']),timestamp=str(pin['timestamp']))
                key=(ep,pin['hash']);self.pool_reads[key]=self.pool_reads.get(key,0)+1
                if self.drift and self.pool_reads[key]>1:items[0]['reserveUSD']='1'
                data.update(items=items,bundles=FOCUS['pools'][0 if ep==0 else 1]['bundles'])
            response=ERR if self.exhaust else {'data':data}
        self.replies=iter([response]);return super().__call__(path,deadline,storage)
class Tests(unittest.TestCase):
    def root(self):
        d=R/'evidence/fixtures';d.mkdir(exist_ok=True);return Path(tempfile.mkdtemp(prefix='client-',dir=d))
    def session(self,tr):
        c=Clock();s=Session(self.root(),tr,c,c.sleep,True);(s.root/'ADMISSION.json').write_bytes(encode({'sourceFiles':source_binding()}));return s,c
    def test_three_actual_cycles_and_automated_audit(self):
        s,c=self.session(Composed());messages=[]
        def exchange(m,d):messages.append(m);c.sleep(2);return {'ok':True,'cycle':m['cycle']}
        r=run_cycles(s,3,exchange,PIN);s.close('fixture');r.update(accounting=s.state,networkSessionCount=1);(s.root/'RESULT.json').write_bytes(encode(r))
        report,updates=audit(s.root,synthetic=True)
        self.assertEqual(report['sealedRounds'],3);self.assertEqual(len(updates),3);self.assertEqual([m['type'] for m in messages],['begin','qualified']*3)
        self.assertEqual((s.state['attempts'],s.state['graphAttempts'],s.state['rpcAttempts']),(148,24,124))
        self.assertTrue(all(not u['liquidityHistory'] and len(u['readings'])==2 for u in updates))
        self.assertLessEqual(s.state['chargedEntities'],12000)
        for n in range(1,4):
            u=strict_json((s.root/f'ROUND_{n}_UPDATE.json').read_bytes());(R/f'evidence/SYNTHETIC_UPDATE_{n}.json').write_bytes(encode(u))
        (R/'evidence/COMPOSED_CLIENT.json').write_bytes(encode({'synthetic':True,'root':str(s.root),'report':report,'accounting':s.state}))
        p=s.root/'ROUND_2_PIN.json';old=p.read_bytes();v=strict_json(old);v['rpcHeads'][0]+=1;p.write_bytes(encode(v))
        with self.assertRaisesRegex(ValueError,'buffered'):audit(s.root,synthetic=True)
        p.write_bytes(old)
    def test_saved_exact_method(self):
        for n in (1,2):
            saved=strict_json((R/f'reference/ROUND_{n}_SEALED.json').read_bytes())
            self.assertEqual(qualify(saved['cohort'],saved['current']['observedAtUtc']),saved['current'])
    def test_noadvance_null_drift_terminal_no_outer_retry(self):
        s,c=self.session(Composed(lag=True));r=run_cycles(s,3,lambda m,d:{'ok':True,'cycle':m['cycle']},PIN);s.close('fixture')
        self.assertEqual(r['status'],'NO_ADVANCE');self.assertEqual(s.state['attempts'],10);self.assertIn(15,c.waits)
        for tr,error in [(Composed(null=True),Stop),(Composed(drift=True),IntegrityError),(Composed(exhaust=True),Stop)]:
            s,c=self.session(tr)
            with self.assertRaises(error):run_cycles(s,3,lambda m,d:{'ok':True,'cycle':m['cycle']},PIN)
            self.assertFalse((s.root/'ROUND_2_PIN.json').exists());s.close('fixture')
            if tr.exhaust:self.assertEqual(s.state['extraAttempts'],2);self.assertIn(15,c.waits);self.assertIn(60,c.waits)
    def test_mixed_retry_single_ordinal(self):
        meta={'deployment':SCOPE['expectedDeployments'][0],'hasIndexingErrors':False,'block':{'number':PIN['number'],'hash':PIN['hash'],'timestamp':None}}
        tr=Transport([{'errors':[{'message':'Store error: store error: prepared statement "__diesel_stmt_1" already exists'}]},{'errors':[{'message':'Store error: store error: unnamed prepared statement does not exist'}]},{'data':{'_meta':meta}}]);s,c=self.session(tr)
        q=graph_job('meta',0,pin=PIN,deployment=meta['deployment']);s.request(q);s.close('fixture');self.assertEqual(tr.queries,[q]*3);self.assertEqual(s.state['extraAttempts'],2)
    def test_unknown_malformed_partial_charge_and_deadline(self):
        q=graph_job('meta',0,pin=PIN,deployment=SCOPE['expectedDeployments'][0])
        for response in [{'data':{},'errors':[{'message':'Store error: database unavailable'}]},{'errors':[{'message':'arbitrary failure'}]},[]]:
            s,c=self.session(Transport([response]))
            with self.assertRaises(Stop):s.request(q)
            self.assertEqual(s.state['attempts'],1);self.assertEqual(s.state['extraAttempts'],0);s.close('fixture')
        def unknown(path,deadline,storage):return {'childReaped':False,'connectionClosed':False,'complete':False}
        s,c=self.session(unknown)
        with self.assertRaises(Stop):s.request(q)
        self.assertEqual(s.state['chargedBytes'],65536);self.assertEqual(s.state['chargedEntities'],32);self.assertIsNotNone(s.state['pending']);s.close('fixture')
        s,c=self.session(Transport([]));s.controls=descriptors();c.n=599
        with self.assertRaises(LimitReached):s.request(q)
        self.assertEqual(s.state['attempts'],0);s.close('fixture')
    def test_scope_fixed_queries(self):
        for kind in ('schema','history','token-history','candidates'):
            with self.assertRaises(KeyError):graph_job(kind,0)
        with self.assertRaises(ValueError):validate_job(rpc_job(0,'eth_call',[{'to':'0x'+'a'*40,'data':SELECTORS['decimals()']},{'blockHash':PIN['hash'],'requireCanonical':True}]))
    def test_saved_partial_audit_conserves_malformed_reservations(self):
        for body in [[],[{}],42,'bad']:
            s,c=self.session(Transport([body]));q=graph_job('meta',0,pin=PIN,deployment=SCOPE['expectedDeployments'][0])
            with self.assertRaises(Stop):s.request(q)
            s.close('Malformed synthetic fixture');result={'accounting':s.state,'networkSessionCount':1,'integrityClosed':False,'rounds':0};(s.root/'RESULT.json').write_bytes(encode(result))
            proof,updates=audit(s.root,synthetic=True);self.assertEqual(proof['accounting']['chargedEntities'],32);self.assertEqual(proof['accounting']['returnedEntities'],0);self.assertEqual(updates,[])
if __name__=='__main__':unittest.main()
