"""Actual serial collectors, denied physical networking, real native command pipe.

Only immutable base/response data are synthetic. Parent acknowledgements come
from the real Node coordinator after its actual storage and registry publication.
"""
import sys,os,json,socket,subprocess,time,queue,importlib.util
from pathlib import Path
sys.dont_write_bytecode=True
W=Path(__file__).resolve().parents[2];root=Path(sys.argv[1]).resolve()
a=json.loads((root/'ADMISSION.json').read_bytes());f=json.loads((root/'FIXTURE.json').read_bytes())
assert a['synthetic'] is True and a['authorityTaskId']=='HDD-UNIFIED-REFRESH-INTEGRATION-R2'
assert 'unified-refresh-integration-r2' in root.parts
def deny(*args,**kwargs):raise AssertionError('DENIED_EXTERNAL_DNS_SOCKET_OR_CHILD')
socket.getaddrinfo=socket.create_connection=socket.socket.connect=socket.socket.connect_ex=deny
subprocess.Popen=os.system=deny
if f.get('pauseBeforeCollect'):time.sleep(10)
class Clock:
    def __init__(self):self.n=a['startedAtUnixSeconds'];self.waits=[]
    def __call__(self):return self.n
    def sleep(self,n):assert n>=0;self.waits.append(n);self.n+=n
c=Clock();time.time=time.monotonic=c;time.sleep=c.sleep
os.environ['HDD_TASK_ROOT']=str(root)
family=a['family'];folder={'market':'market-refresh','gas':'gas-feed','protocol':'protocol-feed','participants':'participant-refresh','trade':'trade-feed'}[family]
if f.get('delay'):c.sleep(f['delay'])
sys.path[:0]=[str(W/'scripts/unified-refresh'),str(W/'scripts'/folder),str(W/'scripts/market-refresh')]
from durable import save,strict_json,encode,digest
import durable,datetime
durable.utc=lambda:datetime.datetime.fromtimestamp(c(),datetime.timezone.utc).isoformat()
from offline_profile import admitted,closed_frame,TradeParent
assert admitted(a)
save(root/'NETWORK_DENIAL.json',{'synthetic':True,'dns':True,'connect':True,'childEscape':True,'externalRequests':0})

def frame(path,value,status=200):
    raw=encode(value);(path.parent/'response.body').write_bytes(raw)
    return dict(status=status,complete=True,framingValidated=True,connectionClosed=True,childReaped=True,
      headers=[['Content-Length',str(len(raw))]],expectedBodyBytes=len(raw),framingKind='content-length',
      expectedBodyBytesBasis='content-length',wireBodyBytes=len(raw),wireBodySha256=digest(raw))

if family=='trade':
    from client import Session,URLS,RESERVATION
    sys.path.insert(0,str(W/'scripts/trade-feed'))
    from collector import collect,start_reader
    count=0
    def transport(args,env,wait,reap):
        global count
        p=Path(args[-1]);q=strict_json(p.read_bytes());count+=1
        assert q['method']=='GET' and q['url'] in URLS and 'headers' not in q
        label=q['label'];status=200
        if label=='markets':
            value=[dict(market_symbol=x.lower()+'usd',base_currency=x,counter_currency='USD',market_type='SPOT',trading='Enabled') for x in ('BTC','ETH')]
        elif f.get('retry') and count==2:status=503;value={'error':'synthetic unavailable'}
        elif f.get('tradeMode')=='empty':value=[]
        elif f.get('tradeMode')=='repeat':
            old=f['previousTrades'][label[:3]];value=[dict(date=str(int(__import__('datetime').datetime.fromisoformat(old['observedAtUtc'].replace('Z','+00:00')).timestamp())),tid=old['tradeId'],price=old['value'])]
        else:
            value=[dict(date=str(int(c())-1),tid=str(100000+a['tradeSlot']),price=str((80000 if label.startswith('BTC') else 2500)+a['tradeSlot']))]
        meta=frame(p,value,status);headers=('Content-Length: '+str(meta['expectedBodyBytes'])+'\r\n').encode()
        (p.parent/'response.headers').write_bytes(headers);meta['headerBytes']=len(headers)
        save(p.parent/'response.json',meta)
        return dict(reaped=True,timeout=False,exit=0,seconds=.01,stdout='',stderr='')
    parent=TradeParent(root,a,c,c.sleep)
    s=Session(root,a,runner=transport,mono=c,wall=c,sleep=c.sleep,parent_accounting=parent)
    incoming=queue.Queue();start_reader(incoming)
    def exchange(kind,cycle,**extra):
        s.check(31);msg=dict(type=kind,cycle=cycle,expiresAtUnixSeconds=c()+30,syntheticClockUnixSeconds=c(),**extra)
        print(json.dumps(msg),flush=True);reply=incoming.get(timeout=30)
        if not reply.get('ok') or reply.get('cycle')!=cycle:raise ValueError('Owner refused: '+str(reply))
        return reply
    outcomes=[]
    try:
        collect(s,exchange,clock=c,sleep=c.sleep,outcomes=outcomes)
        result=dict(status='COMPLETE_SAMPLED_JOB',cycles=outcomes)
    except BaseException as e:result=dict(status='PARTIAL',failure=type(e).__name__+': '+str(e),cycles=outcomes)
    finally:s.close(result.get('failure','Offline job closed'))
    result.update(accounting=s.state,networkSessionCount=0,synthetic=True,noAutomaticRestart=True)
    if f.get('largeResult'):result['boundedSyntheticDiagnostic']='x'*40000
    save(root/'RESULT.json',result);message=closed_frame(root,result)
    if f.get('closure')=='hash':message['resultSha256']='0'*64
    if f.get('closure')!='missing':print(json.dumps(message),flush=True)
    if f.get('closure')=='duplicate':print(json.dumps(message),flush=True)
    raise SystemExit(3 if f.get('closure')=='exit' else 0 if result['status'].startswith('COMPLETE_') else 2)

# Reuse maintained typed response generators; only their physical result is injected.
if family in ('market','participants'):
    if family=='market':
        pin={'number':a['initial']['market']['number'] or 27760000,'timestamp':int(c())-f.get('marketLag',199),
             'hash':'0x'+format(27760000,'064x'),'parentHash':'0x'+format(27759999,'064x')}
        (root/'reference').mkdir();save(root/'reference/ROUND_2_SEALED.json',{'pin':pin})
    else:(root/'SCOPE.json').write_bytes((root/'PLAN.json').read_bytes())
    spec=importlib.util.spec_from_file_location('saved_fixture',W/'tests'/folder/'client_test.py')
    fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
    if family=='market':response=fixture.Composed(exhaust=f.get('exhaust',False))
    else:
        fixture.PLAN['finalTarget'].update(hash='0x'+format(fixture.PLAN['finalTarget']['number'],'064x'),timestamp=fixture.PLAN['base']['timestamp']+10)
        class Empty(fixture.Fixture):
            def data_rows(self,*args,**kwargs):return []
        response=Empty(c,holders=0)
else:
    pin_number=(a['initial'][family].get('number') or 27760000)+10
    timestamp=int(c())-20
    def response(path,deadline,storage):
        q=strict_json(path.read_bytes())['job'];m,p,ep=q['method'],q['params'],q['endpoint']
        if m=='eth_chainId':v='0x171'
        elif m=='eth_getBlockByNumber':
            n=pin_number+2 if p[0]=='latest' else int(p[0],16)
            v=dict(number=hex(n),hash='0x'+format(n,'064x'),parentHash='0x'+format(n-1,'064x'),timestamp=hex(timestamp),transactions=[])
            if family=='gas':v.update(baseFeePerGas='0x3e8',gasUsed='0x5208',gasLimit='0x1c9c380')
        elif family=='gas':
            if m=='eth_gasPrice':v=hex(1100+ep*200)
            elif m=='eth_maxPriorityFeePerGas':v='0x0'
            elif m=='eth_feeHistory':v=dict(oldestBlock=hex(int(p[1],16)-1),baseFeePerGas=['0x3e8','0x3e8','0x3e9'],gasUsedRatio=[.4,.5],reward=[['0x0','0x1','0x2']]*2)
            else:raise AssertionError('Empty synthetic block cannot have transaction calls')
        else:
            from protocol import kind,word,unpack
            initial=a['initial']['protocol'];d=initial['end']+f.get('appendDays',1)
            def packed(day):return initial['tail'][day-initial['end']+2] if day<initial['end'] else str((1234567890123<<72)+987654321+day)
            k=kind(q)
            if m=='eth_getCode':v=strict_json(Path(f['codeBody']).read_bytes())['result']
            elif k=='global':v='0x'+''.join(word(x) for x in [10000000000,12000000000000,123456,0,d,99000000000000,0,0,0,0,timestamp,90000000000,0])
            elif k=='supply':v='0x'+word(90000000000)
            elif k=='range':
                data=p[0]['data'][10:];start,end=int(data[:64],16),int(data[64:],16)
                v='0x'+''.join(word(x) for x in [32,end-start,*[int(packed(i)) for i in range(start,end)]])
            elif k=='daily':v='0x'+''.join(word(int(x)) for x in unpack(int(packed(int(p[0]['data'][10:],16)))))
            else:raise AssertionError('Unexpected synthetic protocol query')
        return frame(path,{'jsonrpc':'2.0','id':1,'result':v})

import capture_client
class Injected:
    def __init__(self,nonce,**kwargs):self.nonce=nonce
    def __call__(self,request,deadline,storage):
        # Physical boundary only: actual Session validates the exact query and
        # framing, writes capture/ledger, and actual auditors independently replay.
        assert strict_json(Path(request).read_bytes())['method']=='POST'
        result=response(Path(request),deadline,storage)
        save(request.parent/'transport.json',result)
        return result
capture_client.WorkerTransport=Injected
import job
raise SystemExit(job.main(offline_fixture=True))
