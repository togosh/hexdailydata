"""Finite trade GET accounting, importing the maintained framing/native primitives."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import importlib.util, json, time, shutil, os
W = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(W/'scripts/market-refresh'))
from durable import save, strict_json, digest, utc
from http_framing import verify_framing
spec=importlib.util.spec_from_file_location('historical_native',W/'scripts/benchmark-reference/collector.py')
native_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(native_module)
native=native_module.native
TASK='HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2'
URLS=('https://www.bitstamp.net/api/v2/markets/','https://www.bitstamp.net/api/v2/transactions/btcusd/?time=minute','https://www.bitstamp.net/api/v2/transactions/ethusd/?time=minute')
CAP=2097152; HEADER=65536; RESERVATION=2162688
class ObjectBoundError(ValueError):pass

def exact_request(method,url):
    if method!='GET' or url not in URLS: raise ValueError('Exact GET URL required')

def parsed_objects(raw):
    def unique(pairs):
        o={}
        for k,v in pairs:
            if k in o:raise ValueError('Duplicate JSON key')
            o[k]=v
        return o
    def invalid(v):raise ValueError('Nonfinite JSON')
    data=json.loads(raw.decode('utf-8'),object_pairs_hook=unique,parse_float=str,parse_constant=invalid)
    queue=[data];count=0
    while queue:
        v=queue.pop()
        if isinstance(v,(dict,list)):
            count+=1
            if count>20000:raise ObjectBoundError('Object bound')
            queue.extend(v.values() if isinstance(v,dict) else v)
    return count

def retryable(row):
    return row['closed'] and not row.get('integrityFailure') and ((row['failureKind']=='timeout') or (row['complete'] and row['status'] in (502,503,504)))

class Session:
    def __init__(self,root,admission,runner=native,mono=time.monotonic,wall=time.time,sleep=time.sleep):
        self.root=Path(root);self.a=admission;self.runner=runner;self.mono=mono;self.wall=wall;self.sleep=sleep
        if (self.root/'ACCOUNTING.json').exists():raise ValueError('Consumed session')
        self.start=mono();self.remaining=600-(wall()-admission['startedAtUnixSeconds']);self.last=None
        if not 0<self.remaining<=600:raise ValueError('Admission time')
        self.state={'status':'ADMITTED','startedAtUtc':utc(),'attempts':0,'logicalRequests':0,'extras':0,'chargedBytes':0,'observedWireBytes':0,'observedBodyBytes':0,'observedHeaderBytes':0,'chargedObjects':0,'pending':None,'closureKnown':True,'requests':[]}
        self.persist()
    def persist(self):save(self.root/'ACCOUNTING.json',self.state)
    def check(self,seconds=0):
        if self.mono()-self.start+seconds>=self.remaining:raise ValueError('Session deadline')
        if shutil.disk_usage(self.root).free<5*1024**3:raise ValueError('Free space floor')
    def get(self,url,label):
        exact_request('GET',url)
        if self.state['status']!='ADMITTED' or self.state['pending'] is not None or not self.state['closureKnown']:raise ValueError('Consumed or uncertain session')
        s=self.state;s['logicalRequests']+=1
        if s['logicalRequests']>7:raise ValueError('Logical bound')
        for ordinal in (0,1):
            if self.last is not None:self.sleep(max(0,self.last+(2 if ordinal else 1)-self.mono()))
            self.check(65)
            if s['attempts']>=14 or s['chargedBytes']+RESERVATION>32*1024**2 or s['chargedObjects']+20000>280000 or (ordinal and s['extras']>=7):raise ValueError('Attempt/reservation bound')
            folder=self.root/f"{s['attempts']+1:02d}";folder.mkdir()
            request=folder/'request.json'
            q={'method':'GET','url':url,'label':label,'attempt':s['attempts']+1,'retryOrdinal':ordinal,'nonce':self.a['nonce'],'dispatchByUnixSeconds':self.a['startedAtUnixSeconds']+535}
            save(request,q)
            s['attempts']+=1;s['extras']+=ordinal;s['chargedBytes']+=RESERVATION
            s['pending']={'request':str(request),'reservedBytes':RESERVATION,'reservedObjects':20000,'startedAtUtc':utc()};self.persist()
            env={k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC')}
            env.update(TEMP=str(self.root/'temp'),TMP=str(self.root/'temp'),PYTHONIOENCODING='utf-8')
            # Durable writes and environment preparation may stall. A reservation
            # remains charged if this final pre-spawn gate refuses dispatch.
            self.check(65)
            life=self.runner([sys.executable,'-I','-S',str(W/'scripts/trade-feed/worker.py'),str(request)],env,27,2)
            closed=life['reaped'] is True
            meta=strict_json((folder/'response.json').read_bytes()) if (folder/'response.json').exists() else {}
            raw=(folder/'response.body').read_bytes() if (folder/'response.body').exists() else b''
            framing=(folder/'response.framing').read_bytes() if (folder/'response.framing').exists() else None
            headers=(folder/'response.headers').read_bytes() if (folder/'response.headers').exists() else b''
            integrity=None;complete=False;count=20000
            try:
                if len(headers)>HEADER or len(raw)+(len(framing) if framing else 0)>CAP:raise ValueError('Capture size')
                if meta.get('complete'):
                    verify_framing(meta,raw,CAP,framing)
                    if meta.get('headerBytes')!=len(headers):raise ValueError('Header receipt')
                    if any(k.lower() in ('set-cookie','www-authenticate','proxy-authenticate') for k,v in meta.get('headers',[])):raise ValueError('Cookie/authentication response')
                    complete=True
                    # Error bodies are not exempt from parsed-object limits.
                    # Non-JSON HTTP errors retain the full conservative reservation.
                    try:count=parsed_objects(raw)
                    except (UnicodeError,json.JSONDecodeError):
                        if meta.get('status')==200:raise
                        count=20000
            except BaseException as e:integrity=str(e)
            if meta.get('failureKind')=='terminal':integrity=meta.get('error','Terminal transport')
            row={**q,'closed':closed,'complete':complete,'status':meta.get('status'),'failureKind':('timeout' if life['timeout'] else meta.get('failureKind')),'integrityFailure':integrity,'native':life,'bodySha256':digest(raw),'headersSha256':digest(headers),'bodyBytes':len(raw),'wireBytes':len(raw)+(len(framing) if framing else 0),'headerBytes':len(headers),'chargedObjects':count,'closedAtUtc':utc() if closed else None}
            save(folder/'AUDIT.json',row)
            s['requests'].append(row);s['chargedObjects']+=count;s['observedBodyBytes']+=len(raw);s['observedWireBytes']+=row['wireBytes'];s['observedHeaderBytes']+=len(headers)
            if closed:s['pending']=None;self.last=self.mono()
            else:s['closureKnown']=False
            self.persist()
            if not closed:raise ValueError('Native closure unknown')
            if life['seconds']>30:raise ValueError('Request lifecycle deadline')
            if integrity:raise ValueError('Integrity: '+integrity)
            if complete and meta.get('status')==200 and life['exit']==0 and not life['timeout']:
                return {'attempt':s['attempts'],'bodySha256':row['bodySha256'],'bodyBytes':len(raw),'objects':count}
            if ordinal==0 and retryable(row):continue
            raise ValueError('Terminal or exhausted request: '+str(meta.get('status')))
    def close(self,reason):
        self.state.update(status='CLOSED' if self.state['closureKnown'] and self.state['pending'] is None else 'UNKNOWN',closureReason=reason,closedAtUtc=utc(),elapsedSeconds=self.mono()-self.start)
        self.persist()

