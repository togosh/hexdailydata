"""Real isolated request process, native permit/query gate, denied socket boundary."""
import sys,os,json,time,importlib.util
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2];request=Path(sys.argv[1]).resolve()
root=request.parent.parent if request.parent.name.isdigit() and len(request.parent.name)==2 else request.parents[2]
a=json.loads((root/'ADMISSION.json').read_bytes());f=json.loads((root/'FIXTURE.json').read_bytes());family=a['family']
assert a['operatingFormat']=='unified-operating-denied-boundary-1' and a['synthetic'] is True
def deny(event,args):
    if event.startswith('socket.'):raise PermissionError('DENIED_NETWORK_BOUNDARY')
sys.addaudithook(deny)
folder={'trade':'trade-feed','market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh'}[family]
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts'/folder),str(W/'scripts/market-refresh')]
os.environ['HDD_TASK_ROOT']=str(root)
from durable import save,encode,digest,strict_json
from worker import operating_physical_enter
if family=='gas' and f.get('startupTimeout'):
    # Stall before physical entry/envelope: real enclosing process must kill/wait.
    save(root/'STARTUP_TIMEOUT_TRIGGER.json',dict(workerPid=os.getpid(),networkingDenied=True,request=str(request)))
    time.sleep(90)
    raise AssertionError('Enclosing startup cutoff not enforced')
operating_physical_enter(request,root,a,time.time)
q=strict_json(request.read_bytes())
if (family=='gas' and f.get('timeoutTip') and q.get('job',{}).get('method')=='eth_maxPriorityFeePerGas'
    and q['job']['endpoint']==1 and not (root/'TIMEOUT_TRIGGER.json').exists()):
    # The real enclosing WorkerTransport must time out, kill and wait this child.
    # No response or closure receipt is injected by this I/O seam.
    save(root/'TIMEOUT_TRIGGER.json',dict(workerPid=os.getpid(),request=str(request),at=time.time(),networkingDenied=True))
    import http_worker
    class BlockedConnection:
        def __init__(self,*args,**kwargs):pass
        def request(self,*args,**kwargs):time.sleep(90)
        def close(self):pass
    http_worker.http.client.HTTPSConnection=BlockedConnection
    # The maintained HTTP function writes its own initial transport envelope.
    # Only I/O is denied/stalled; the Popen owner generates actual kill/wait proof.
    http_worker.perform(q['method'],q['url'],(request.parent/'request.body').read_bytes(),
        request.parent/'response.body',request.parent/'transport.json',16384)
    raise AssertionError('Actual enclosing request cutoff did not terminate timeout fixture')
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def frame(value):
    raw=encode(value);(request.parent/'response.body').write_bytes(raw)
    return dict(status=200,complete=True,connectionClosed=True,framingValidated=True,headers=[['Content-Length',str(len(raw))]],
      expectedBodyBytes=len(raw),framingKind='content-length',expectedBodyBytesBasis='content-length',wireBodyBytes=len(raw),wireBodySha256=digest(raw))
if family=='trade':
    label=q['label']
    if label=='markets':v=[dict(market_symbol=x.lower()+'usd',base_currency=x,counter_currency='USD',market_type='SPOT',trading='Enabled') for x in ('BTC','ETH')]
    elif f['tradeMode']=='empty':v=[]
    else:v=[dict(date=str(int(time.time())-1),tid=str(100000+int(a['job'].split('-')[-1])),price='81000' if label.startswith('BTC') else '2600')]
    m=frame(v);headers=('Content-Length: '+str(m['expectedBodyBytes'])+'\r\n').encode();(request.parent/'response.headers').write_bytes(headers);m['headerBytes']=len(headers)
    save(request.parent/'response.json',m)
else:
    job=q['job'];ep=job['endpoint'];method=job.get('method');params=job.get('params')
    if family=='market':
        pin={'number':a['initial']['market']['number'] or 27760000,'timestamp':int(a['startedAtUnixSeconds'])-200,'hash':'0x'+format(27760000,'064x'),'parentHash':'0x'+format(27759999,'064x')}
        (root/'reference').mkdir(exist_ok=True)
        if not (root/'reference/ROUND_2_SEALED.json').exists():save(root/'reference/ROUND_2_SEALED.json',{'pin':pin})
        fixture=load('response_fixture',W/'tests/market-refresh/client_test.py');response=fixture.Composed()
        heads=root/'SYNTHETIC_HEADS.json';response.heads=strict_json(heads.read_bytes()) if heads.exists() else [0,0]
        m=response(request,0,None);save(heads,response.heads)
    elif family=='participants':
        (root/'SCOPE.json').write_bytes((root/'PLAN.json').read_bytes())
        fixture=load('response_fixture',W/'tests/participant-refresh/client_test.py')
        fixture.PLAN['finalTarget'].update(hash='0x'+format(fixture.PLAN['finalTarget']['number'],'064x'),timestamp=fixture.PLAN['base']['timestamp']+10)
        class Empty(fixture.Fixture):
            def data_rows(self,*args,**kw):return []
        response=Empty(fixture.Clock(),holders=0);m=response(request,0,None)
    else:
        pin=(a['initial'][family].get('number') or 27760000)+10;stamp=int(a['startedAtUnixSeconds'])-20
        if method=='eth_chainId':v='0x171'
        elif method=='eth_getBlockByNumber':
            n=pin+2 if params[0]=='latest' else int(params[0],16)
            v=dict(number=hex(n),hash='0x'+format(n,'064x'),parentHash='0x'+format(n-1,'064x'),timestamp=hex(stamp),transactions=[])
            if family=='gas':v.update(baseFeePerGas='0x3e8',gasUsed='0x5208',gasLimit='0x1c9c380')
        elif family=='gas':
            if method=='eth_gasPrice':v=hex(1100+ep*200)
            elif method=='eth_maxPriorityFeePerGas':v='0x0'
            elif method=='eth_feeHistory':v=dict(oldestBlock=hex(int(params[1],16)-1),baseFeePerGas=['0x3e8','0x3e8','0x3e9'],gasUsedRatio=[.4,.5],reward=[['0x0','0x1','0x2']]*2)
            else:raise ValueError('Unexpected synthetic gas method')
        else:
            from protocol import kind,word,unpack
            initial=a['initial']['protocol'];d=min(initial['end']+1,(stamp-1575331200)//86400)
            def packed(day):return initial['tail'][day-initial['end']+2] if day<initial['end'] else str((1234567890123<<72)+987654321+day)
            k=kind(job)
            if method=='eth_getCode':v=strict_json(Path(f['codeBody']).read_bytes())['result']
            elif k=='global':v='0x'+''.join(word(x) for x in [10000000000,12000000000000,123456,0,d,99000000000000,0,0,0,0,stamp,90000000000,0])
            elif k=='supply':v='0x'+word(90000000000)
            elif k=='range':
                data=params[0]['data'][10:];start,end=int(data[:64],16),int(data[64:],16);v='0x'+''.join(word(x) for x in [32,end-start,*[int(packed(i)) for i in range(start,end)]])
            elif k=='daily':v='0x'+''.join(word(int(x)) for x in unpack(int(packed(int(params[0]['data'][10:],16)))))
            else:raise ValueError('Unexpected synthetic protocol method')
        m=frame({'jsonrpc':'2.0','id':1,'result':v})
    # Child never claims to reap itself. The maintained Popen owner supplies it.
    m.pop('childReaped',None);save(request.parent/'transport.json',m)
