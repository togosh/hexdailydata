"""Finite trade GET accounting, importing the maintained framing/native primitives."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import importlib.util, json, time, shutil, os, subprocess
W = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(W/'scripts/market-refresh'))
from durable import save, strict_json, digest, utc
from http_framing import verify_framing
sys.path.insert(0, str(W/'scripts/trade-feed'))
from authority import ISOLATION_AUTHORITY, COOKIE_AUTHORITY, OPERATING_AUTHORITY, cookie_policy, validate_authority, trade_profile
spec=importlib.util.spec_from_file_location('historical_native',W/'scripts/benchmark-reference/collector.py')
native_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(native_module)
native=native_module.native
def worker_native(args, env, wait=27, reap=2):
    # This child reads files only. The collector must retain its own command pipe.
    return native(args, env, wait, reap, stdin=subprocess.DEVNULL)
TASK='HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2'
URLS=('https://www.bitstamp.net/api/v2/markets/','https://www.bitstamp.net/api/v2/transactions/btcusd/?time=minute','https://www.bitstamp.net/api/v2/transactions/ethusd/?time=minute')
CAP=2097152; HEADER=65536; RESERVATION=2162688
class ObjectBoundError(ValueError):pass
class SlotMissed(ValueError):pass

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

def retryable(row, require_network_begin=False):
    timeout = row['failureKind']=='timeout' and (not require_network_begin or row.get('networkConnectionBegan') is True)
    return row['closed'] and not row.get('integrityFailure') and (timeout or (row['complete'] and row['status'] in (502,503,504)))

class Session:
    def __init__(self,root,admission,runner=worker_native,mono=time.monotonic,wall=time.time,sleep=time.sleep):
        self.root=Path(root);self.a=admission;self.runner=runner;self.mono=mono;self.wall=wall;self.sleep=sleep
        self.cookie_policy = cookie_policy(admission)
        self.profile = trade_profile(admission)
        if self.cookie_policy and runner is worker_native:
            validate_authority(admission, self.root)
        if (self.root/'ACCOUNTING.json').exists():raise ValueError('Consumed session')
        self.start=mono();self.remaining=self.profile['seconds']-(wall()-admission['startedAtUnixSeconds']);self.last=None
        if not 0<self.remaining<=self.profile['seconds']:raise ValueError('Admission time')
        self.state={'status':'ADMITTED','startedAtUtc':utc(),'attempts':0,'logicalRequests':0,'extras':0,'chargedBytes':0,'observedWireBytes':0,'observedBodyBytes':0,'observedHeaderBytes':0,'diagnosticBytes':0,'chargedObjects':0,'pending':None,'closureKnown':True,'requests':[]}
        self.persist()
    def persist(self):save(self.root/'ACCOUNTING.json',self.state)
    def check(self,seconds=0):
        if self.mono()-self.start+seconds>=self.remaining:raise ValueError('Session deadline')
        if shutil.disk_usage(self.root).free<5*1024**3:raise ValueError('Free space floor')
    def get(self,url,label,slot_deadline=None):
        exact_request('GET',url)
        if slot_deadline is not None and (self.a.get('authorityTaskId')!=OPERATING_AUTHORITY or not label.startswith('BTC_')):raise ValueError('Slot gate authority')
        if self.state['status']!='ADMITTED' or self.state['pending'] is not None or not self.state['closureKnown']:raise ValueError('Consumed or uncertain session')
        s=self.state;s['logicalRequests']+=1
        if s['logicalRequests']>self.profile['logical']:raise ValueError('Logical bound')
        for ordinal in (0,1):
            if self.last is not None:self.sleep(max(0,self.last+(2 if ordinal else 1)-self.mono()))
            if ordinal==0 and slot_deadline is not None and self.mono()>slot_deadline:raise SlotMissed('Slot start expired before reservation')
            self.check(65)
            if s['attempts']>=self.profile['attempts'] or s['chargedBytes']+RESERVATION>self.profile['charged_bytes'] or s['chargedObjects']+20000>self.profile['objects'] or (ordinal and s['extras']>=self.profile['extras']):raise ValueError('Attempt/reservation bound')
            folder=self.root/f"{s['attempts']+1:02d}";folder.mkdir()
            request=folder/'request.json'
            q={'method':'GET','url':url,'label':label,'attempt':s['attempts']+1,'retryOrdinal':ordinal,'nonce':self.a['nonce'],'dispatchByUnixSeconds':self.a['startedAtUnixSeconds']+self.profile['dispatch']}
            if self.a.get('tradeProfileId'):
                q['tradeProfileId']=self.a['tradeProfileId']
            if ordinal==0 and slot_deadline is not None:
                q['slotDispatchByUnixSeconds']=self.wall()+max(0,slot_deadline-self.mono())
            save(request,q)
            s['attempts']+=1;s['extras']+=ordinal;s['chargedBytes']+=RESERVATION
            s['pending']={'request':str(request),'reservedBytes':RESERVATION,'reservedObjects':20000,'startedAtUtc':utc()};self.persist()
            env={k:v for k,v in os.environ.items() if k.upper() in ('SYSTEMROOT','WINDIR','COMSPEC')}
            env.update(TEMP=str(self.root/'temp'),TMP=str(self.root/'temp'),PYTHONIOENCODING='utf-8')
            # Durable writes and environment preparation may stall. A reservation
            # remains charged if this final pre-spawn gate refuses dispatch.
            self.check(65)
            if ordinal==0 and slot_deadline is not None and self.mono()>slot_deadline:
                # No worker exists. Retain the entire reservation and record known local closure.
                s['chargedObjects']+=20000;s['pending']=None;self.persist()
                save(folder/'LOCAL_SKIP.json',{'status':'SKIPPED','reason':'Durable preparation exceeded slot','networkRequests':0,'reservedBytes':RESERVATION,'reservedObjects':20000})
                raise SlotMissed('Slot start expired after reservation')
            spawn_at=self.wall()
            life=self.runner([sys.executable,'-I','-S',str(W/'scripts/trade-feed/worker.py'),str(request)],env,27,2)
            for key,limit in [('stdout',2048),('stderr',2048),('interrupted',1024)]:
                if life.get(key):life[key]=str(life[key]).encode()[:limit].decode(errors='ignore')
            closed=life['reaped'] is True
            meta=strict_json((folder/'response.json').read_bytes()) if (folder/'response.json').exists() else {}
            raw=(folder/'response.body').read_bytes() if (folder/'response.body').exists() else b''
            framing=(folder/'response.framing').read_bytes() if (folder/'response.framing').exists() else None
            headers=(folder/'response.headers').read_bytes() if (folder/'response.headers').exists() else b''
            phase_path=folder/'PHASES.ndjson'
            phase_raw=phase_path.read_bytes() if phase_path.exists() else b''
            diagnostics=len(phase_raw)+sum(len(str(life.get(k) or '').encode()) for k in ('stdout','stderr','interrupted'))+len(str(meta.get('error') or '').encode())
            phases=[]
            integrity=None;complete=False;count=20000
            transport_complete=False;ignored_cookies=0;auth_challenges=0
            try:
                if len(phase_raw)>8192 or diagnostics>16384:raise ValueError('Diagnostic bound')
                phases=[strict_json(line) for line in phase_raw.splitlines()]
                if meta.get('synthetic') is True:raise ValueError('Synthetic capture refused')
                if len(headers)>HEADER or len(raw)+(len(framing) if framing else 0)>CAP:raise ValueError('Capture size')
                if meta.get('complete'):
                    verify_framing(meta,raw,CAP,framing)
                    if meta.get('headerBytes')!=len(headers):raise ValueError('Header receipt')
                    transport_complete=True
                    cookie_count=sum(k.lower()=='set-cookie' for k,v in meta.get('headers',[]))
                    auth_challenges=sum(k.lower() in ('www-authenticate','proxy-authenticate') for k,v in meta.get('headers',[]))
                    if self.cookie_policy:
                        # Count received fields only. No value is parsed, retained for reuse,
                        # or forwarded to the maintained fixed outbound header list.
                        ignored_cookies=cookie_count
                        if auth_challenges:raise ValueError('Authentication challenge response')
                    elif cookie_count or auth_challenges:
                        raise ValueError('Cookie/authentication response')
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
            row.update(diagnosticBytes=diagnostics,phaseBytes=len(phase_raw),phaseSha256=digest(phase_raw),lastEstablishedPhase=phases[-1]['event'] if phases else 'worker_entry_not_established',spawnToEntrySeconds=phases[0]['unixSeconds']-spawn_at if phases else None)
            isolated_grant = self.a.get('authorityTaskId') in (ISOLATION_AUTHORITY, COOKIE_AUTHORITY, OPERATING_AUTHORITY)
            if isolated_grant:
                row['networkConnectionBegan'] = any(p.get('event')=='dns_tcp_tls_connection_begin' for p in phases)
            if self.cookie_policy:
                row.update(responseCookiePolicyId=self.cookie_policy,ignoredResponseCookieCount=ignored_cookies,
                           authenticationChallengeCount=auth_challenges,transportComplete=transport_complete)
            save(folder/'AUDIT.json',row)
            s['diagnosticBytes']+=diagnostics
            s['requests'].append(row);s['chargedObjects']+=count;s['observedBodyBytes']+=len(raw);s['observedWireBytes']+=row['wireBytes'];s['observedHeaderBytes']+=len(headers)
            if closed:s['pending']=None;self.last=self.mono()
            else:s['closureKnown']=False
            self.persist()
            if not closed:raise ValueError('Native closure unknown')
            if life['seconds']>30:raise ValueError('Request lifecycle deadline')
            if integrity:raise ValueError('Integrity: '+integrity)
            if complete and meta.get('status')==200 and life['exit']==0 and not life['timeout']:
                return {'attempt':s['attempts'],'bodySha256':row['bodySha256'],'bodyBytes':len(raw),'objects':count}
            if ordinal==0 and retryable(row, require_network_begin=isolated_grant):continue
            raise ValueError('Terminal or exhausted request: '+str(meta.get('status')))
    def close(self,reason):
        self.state.update(status='CLOSED' if self.state['closureKnown'] and self.state['pending'] is None else 'UNKNOWN',closureReason=reason,closedAtUtc=utc(),elapsedSeconds=self.mono()-self.start)
        self.persist()

