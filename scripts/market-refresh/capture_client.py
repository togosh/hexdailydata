"""PulseX finite session: reviewed physical transport with task-specific budgets."""
import json,os,subprocess,sys,time
from pathlib import Path
from durable import Storage,digest,encode,strict_json,utc
from task_queries import SCOPE,validate_job,validate_data,entity_rows
from retry_policy import CLASSIFICATIONS,classify_error_only
from header_binding import validate_rpc
from http_framing import verify_framing
from response_caps import response_capacity
ROOT=Path(__file__).resolve().parent
class Stop(Exception):pass
class OptionalUnavailable(Stop):pass
class LimitReached(Stop):pass

class WorkerTransport:
    """One child, finite request INCLUDING kill/reap, inherited secrets excluded."""
    def __init__(self,nonce,clock=time.monotonic,popen=subprocess.Popen,worker_path=None):
        self.nonce=nonce;self.clock=clock;self.popen=popen;self.child=None;self.worker_path=worker_path or ROOT/'http_worker.py'
    def __call__(self,request,deadline,storage):
        request=Path(request);body=request.parent/'response.body';meta=request.parent/'transport.json'
        env={k:os.environ[k] for k in ('SystemRoot','WINDIR','COMSPEC') if k in os.environ}
        env.update(TEMP=str(request.parents[2]/'temp'),TMP=str(request.parents[2]/'temp'),PYTHONIOENCODING='utf-8')
        result={'status':None,'complete':False,'connectionClosed':False,'failureKind':None,'transportError':None}
        started=False;closed=False;cancel=None
        try:
            if self.clock()>=deadline-2:raise Stop('No attempt time before dispatch')
            self.child=self.popen([sys.executable,'-I','-S',str(self.worker_path),str(request),str(body),str(meta),self.nonce],
                cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            started=True
            self.child.wait(timeout=max(.001,deadline-2-self.clock()))
            closed=True
        except subprocess.TimeoutExpired:
            result.update(failureKind='transport_timeout',transportError='Parent absolute request cutoff',complete=False)
        except KeyboardInterrupt as exc:
            cancel=exc;result.update(failureKind='owner_cancellation',transportError='Owner cancellation',complete=False)
        except Exception as exc:
            result.update(failureKind='local_or_protocol',transportError=f'{type(exc).__name__}: {exc}',complete=False)
        finally:
            if self.child is not None and not closed:
                try:
                    self.child.kill();self.child.wait(timeout=max(.001,deadline-self.clock()));closed=True
                except Exception:
                    closed=False
            parent_failure=result['failureKind']
            if meta.is_file():
                try:
                    if meta.stat().st_size>65536:raise ValueError('Transport receipt too large')
                    result.update(strict_json(meta.read_bytes()))
                except Exception as exc:result.update(failureKind='local_or_protocol',transportError=str(exc),complete=False)
            if parent_failure:result.update(failureKind=parent_failure,complete=False)
            if started and self.child.returncode not in (0,None) and not parent_failure:
                result.update(failureKind='local_or_protocol',complete=False,transportError='Worker exit '+str(self.child.returncode))
            result['childStarted']=started;result['childReaped']=closed
            result['connectionClosed']=closed and (result.get('connectionClosed') or parent_failure=='transport_timeout' or parent_failure=='owner_cancellation')
            if not closed:result.update(failureKind='unknown_closure',complete=False)
            # Only this enclosing process owns the Popen handle and observes wait.
            self.last_lifecycle=dict(ownerPid=os.getpid(),workerPid=self.child.pid if self.child else None,
                childStarted=started,childReaped=closed,exitCode=self.child.returncode if self.child else None,
                connectionClosed=bool(result['connectionClosed']))
            if closed:self.child=None
        return result

class Session:
    """One admitted session. Controls reserve their own response classes, not data caps."""
    job_validator=staticmethod(validate_job)
    capacity=staticmethod(response_capacity)
    rpc_validator=staticmethod(validate_rpc)
    object_counter=staticmethod(entity_rows)
    graph_validator=staticmethod(validate_data)
    maximum_extras=24
    request_seconds=30
    native_reserve=5
    segment_label='MARKET_REFRESH'
    def reserve_extra(self,q,is_retry):pass
    def dispatch_cutoff(self):return min(self.cycle_started-self.started+(1140 if self.closing else 600),2640)
    def retry_allowed(self,q,cap,special,veto):
        return bool(q['kind'] not in ('rpc','docs') and not cap['usable'] and not veto and cap['closureKnown'] and (special or cap.get('failureKind') in ('network','transport_timeout') or cap.get('complete') and cap.get('status') in (502,503,504)))
    def __init__(self,root,transport,clock=time.monotonic,sleep=time.sleep,synthetic=False):
        self.root=Path(root);self.root.mkdir(exist_ok=True)
        self.transport=transport;self.clock=clock;self.sleep=sleep;self.started=clock();self.deadline=self.started+2700
        self.storage=Storage(self.root);self.closed=False;self.failed=False;self.last_closed=None;self.closing=False
        # One current pin per cycle, at most three in the finite trial.
        self.controls=[]
        self.cycle_started=self.started;self.cycle_ordinal=0
        self.state={'status':'SYNTHETIC_OFFLINE_TEST' if synthetic else 'ADMITTED','mode':'SYNTHETIC_OFFLINE_TEST' if synthetic else 'OWNER_AUTHORIZED_PUBLIC',
                    'startedAt':utc(),'attempts':0,'extraAttempts':0,'chargedBytes':0,'observedBytes':0,'chargedEntities':0,'returnedEntities':0,
                    'unknownEntityReservations':0,'pending':None,'graphAttempts':0,'rpcAttempts':0,'docsAttempts':0,
                    'graphChargedBytes':0,'rpcChargedBytes':0,'docsChargedBytes':0,'rpcEndpointAttempts':[0,0],'graphEndpointAttempts':[0,0],'schemaAttempts':[0,0],
                    'retryPolicyVersion':'HOLDER_R3','retryPolicy':{'maximumAfterInitialPerLogicalPage':2,'maximumExtraAttemptsSession':24,'minimumDelaysSeconds':[15,60]}}
        self.persist()
    def persist(self):
        self.state.update(elapsedSeconds=round(self.clock()-self.started,6),storageChargedBytes=self.storage.used)
        self.storage.json(self.root/'ACCOUNTING.json',self.state,replace=True)
    def liabilities(self,q,remaining):
        # remaining exact-query attempts plus every future mandatory closing control.
        rows=[q]*remaining
        for c in self.controls:rows.extend([c]*(1 if c['kind']=='rpc' else 3))
        return rows
    def phase_check(self,q,tail,delay=0):
        now=self.clock()+delay
        cutoff=min(self.cycle_started+(1140 if self.closing else 600),self.started+2640)
        if now+2>=cutoff:raise LimitReached('Phase dispatch cutoff')
        # Retry waits are included even when no error occurs; no last-minute optional calls.
        controls_graph=sum(c['kind']!='rpc' for c in self.controls)
        waits=controls_graph*75+(75 if q['kind'] not in ('rpc','docs') else 0)
        finish=now+30+(len(tail)*31)+waits+5
        if finish>=self.deadline:raise LimitReached('Mandatory closure time reserve')
        # Conservatively require the entire worst-case reserved trace to finish
        # before the control dispatch cutoff as well as physical session closure.
        if finish>=min(self.cycle_started+1140,self.started+2640):raise LimitReached('Mandatory control dispatch reserve')
    def budget(self,q,tail,cutoff=None,is_retry=False):
        s=self.state
        if self.closed or self.failed or s['pending'] is not None:raise Stop('Closed/uncertain session')
        allq=[q,*tail];protocol=lambda j:'rpc' if j['kind']=='rpc' else 'docs' if j['kind']=='docs' else 'graph'
        if s['attempts']+len(allq)>240:raise LimitReached('Attempt reserve')
        for p,maximum,byte_limit in [('graph',80,16777216),('rpc',160,8388608),('docs',0,0)]:
            jobs=[j for j in allq if protocol(j)==p]
            if s[p+'Attempts']+len(jobs)>maximum or s[p+'ChargedBytes']+sum(map(response_capacity,jobs))>byte_limit:raise LimitReached('Protocol reserve '+p)
            if p!='docs':
                for ep in (0,1):
                    if s[p+'EndpointAttempts'][ep]+sum(j['endpoint']==ep for j in jobs)>(40 if p=='graph' else 80):raise LimitReached('Endpoint cap')
        if s['chargedBytes']+sum(map(response_capacity,allq))>25165824 or s['chargedEntities']+sum(j['maxRows'] for j in allq)>12000:raise LimitReached('Combined body/entity reserve')
        query_extras=sum(j is q for j in tail)+int(is_retry)
        if s['extraAttempts']+query_extras+sum(c['kind']!='rpc' for c in self.controls)*2>24:raise LimitReached('Shared extra/control reserve')
        self.phase_check(q,tail)
        self.storage.check(2*sum(map(response_capacity,allq))+262144,acquisition=True)
    def request(self,q,optional=False):
        try:
            original=self.state['attempts']+1;prior=None;maximum=0 if q['kind'] in ('rpc','docs') else 2
            for ordinal in range(maximum+1):
                tail=self.liabilities(q,maximum-ordinal)
                if ordinal:
                    delay=[15,60][ordinal-1];self.phase_check(q,tail,delay);self.sleep(delay)
                cap,data=self.attempt(q,tail,is_retry=ordinal>0,original=original,prior=prior,retry_index=ordinal)
                if cap['usable']:return cap,data
                if not cap['retryable']:
                    if optional and self.optional_failure(cap):raise OptionalUnavailable(cap['stopReason'])
                    raise Stop(cap['stopReason'])
                prior=cap['attempt']
            if optional and self.optional_failure(cap):raise OptionalUnavailable('Exact optional query exhausted recognized retries')
            raise Stop('UPSTREAM_SOURCE_UNAVAILABLE_UNDER_RETRY_POLICY: exact query exhausted')
        except OptionalUnavailable:
            raise
        except LimitReached:
            # A pre-dispatch refusal leaves no unknown physical request. Reserved
            # closing controls can still run after abandoning optional acquisition.
            if self.state['pending'] is not None:self.failed=True
            raise
        except BaseException:
            self.failed=True
            raise
    def optional_failure(self,cap):return False # No optional work or hidden cycle retry.
    def attempt(self,q,tail=(),cutoff=None,is_retry=False,original=None,prior=None,retry_index=0):
        cutoff=self.dispatch_cutoff()
        method,url,body=self.job_validator(q)
        rpc=q['kind']=='rpc';docs=q['kind']=='docs';protocol='rpc' if rpc else 'docs' if docs else 'graph';capacity=self.capacity(q)
        if self.last_closed is not None:self.sleep(max(0,1-(self.clock()-self.last_closed)))
        if is_retry and self.state['extraAttempts']>=self.maximum_extras:raise Stop('Shared extra retry ceiling')
        self.budget(q,tail,cutoff,is_retry)
        s=self.state;s['attempts']+=1;s['extraAttempts']+=bool(is_retry)
        s[protocol+'Attempts']+=1
        if rpc:s['rpcEndpointAttempts'][q['endpoint']]+=1
        self.reserve_extra(q,is_retry)
        if protocol=='graph':s['graphEndpointAttempts'][q['endpoint']]+=1
        if q['kind']=='schema':s['schemaAttempts'][q['endpoint']]+=1
        number=s['attempts'];directory=self.root/'captures'/f'{number:05d}';directory.mkdir(parents=True)
        request=directory/'request.json'
        s['chargedBytes']+=capacity;s[protocol+'ChargedBytes']+=capacity;s['chargedEntities']+=q['maxRows']
        s['pending']={'attempt':number,'requestPath':str(request.resolve()),'protocol':protocol,'reservedBytes':capacity,'reservedEntities':q['maxRows']}
        # Durable conservative reservation precedes request persistence and any child.
        self.persist()
        self.storage.json(request,{'job':q,'method':method,'url':url,'bodySha256':digest(body),'bodyBytes':len(body),'preparedAt':utc()})
        self.storage.put(directory/'request.body',body)
        disk_reservation=capacity+131072;self.storage.reserve(disk_reservation)
        self.persist()
        start=self.clock();deadline=min(start+self.request_seconds,self.started+cutoff,self.deadline-self.native_reserve)
        reserved_state=json.loads(json.dumps(s))
        cap={'segment':self.segment_label, 'cycle':self.cycle_ordinal,'protocol':protocol,'attempt':number,'capture':f'captures/{number:05d}/capture.json','job':q,'requestSha256':digest(body),
             'mode':s['mode'],'startedAt':utc(),'startOffsetSeconds':start-self.started,'retry':is_retry,'usable':False,'retryable':False,
             'originalAttempt':original or number,'retryOf':prior,'retryIndex':retry_index}
        try:
            # No growing-dataset work occurs between this fresh deadline and child dispatch.
            if self.clock()-self.started>=min(cutoff,cutoff):
                raise Stop('Dispatch cutoff reached during durable preparation; no child started')
            self.phase_check(q,tail)
            transport=self.transport(request,deadline,self.storage)
            cap.update(transport)
            no_dispatch=(cap.get('failureKind')=='local_reserve_refusal' and cap.get('noChildStarted') is True
                and cap.get('childStarted') is False and cap.get('childReaped') is False and cap.get('status') is None
                and cap.get('complete') is False)
            closed=(cap.get('childReaped') is True or no_dispatch) and cap.get('connectionClosed') is True
            cap['closedWithinDeadline']=closed and self.clock()<=deadline
            if not closed:cap.update(complete=False,failureKind='unknown_closure')
            if self.clock()>deadline:cap.update(complete=False,failureKind='attempt_deadline')
            if closed:self.last_closed=self.clock()
            raw_path=directory/'response.body'
            if not raw_path.exists():self.storage.put(raw_path,b'')
            if raw_path.stat().st_size>capacity:raise ValueError('Worker exceeded body bound')
            raw=raw_path.read_bytes()
            # Make retained worker body durable even after a reaped timeout.
            with raw_path.open('ab') as f:f.flush();os.fsync(f.fileno())
            cap['bodyDurable']=True
            disk_actual=sum((directory/n).stat().st_size for n in ['response.body','response.framing','transport.json','transport.json.tmp'] if (directory/n).exists())
            if disk_actual>disk_reservation:self.storage.reserve(disk_actual-disk_reservation)
            if closed:self.storage.used-=max(0,disk_reservation-disk_actual)
            cap.update(responseBytes=len(raw),responseSha256=digest(raw),finishedAt=utc(),durationSeconds=self.clock()-start)
            wire_bytes=None
            framing_path=directory/'response.framing'
            framing=None
            if framing_path.exists():
                if framing_path.stat().st_size>65536:raise ValueError('Framing evidence ceiling')
                with framing_path.open('ab') as f:f.flush();os.fsync(f.fileno())
                framing=framing_path.read_bytes()
                cap.update(framingEvidenceBytes=len(framing),framingEvidenceSha256=digest(framing))
            if cap.get('complete'):
                try:wire_bytes=verify_framing(cap,raw,capacity,framing)
                except ValueError as exc:
                    cap.update(complete=False,failureKind='local_or_protocol',validationError='Invalid complete-response framing qualification: '+str(exc))
            parsed=None;count=None
            if cap.get('complete') and not docs:
                try:
                    parsed=strict_json(raw)
                    if not isinstance(parsed,dict):raise ValueError('Response object required')
                    count=self.object_counter(parsed)
                    if not rpc:cap['graphqlErrors']=parsed.get('errors')
                except (ValueError,UnicodeError,RecursionError) as exc:
                    parsed=None;count=None;cap['parseError']=str(exc)
            if docs and cap.get('complete'):count=0
            status=cap.get('status');failure=cap.get('failureKind')
            if count is not None and (count>q['maxRows']):cap['validationError']='Entity overrun'
            access=status in (401,402,403,429) or any(word in raw.lower() for word in [b'payment required',b'authentication required',b'unauthorized',b'api key required'])
            if not rpc and not docs and parsed and isinstance(parsed.get('data'),dict):
                try:self.graph_validator(q,parsed['data'])
                except ValueError as exc:cap['validationError']=str(exc)
            if status==200 and cap.get('complete') and not cap.get('parseError') and not cap.get('graphqlErrors') and not cap.get('validationError'):
                try:
                    if rpc:cap['selectedHeaderResult']=self.rpc_validator(q,parsed)
                    elif docs:pass
                    else:
                        if set(parsed)-{'data','extensions'}:raise ValueError('Unexpected GraphQL envelope')
                        self.graph_validator(q,parsed.get('data'))
                    if count>q['maxRows']:raise ValueError('Entity overrun')
                    cap['usable']=True
                except (ValueError,TypeError,KeyError) as exc:cap['validationError']=str(exc)
            known=count is not None and cap.get('complete') and closed
            charged=count if known else q['maxRows']
            charged_bytes=wire_bytes if cap.get('complete') and closed else capacity
            s['chargedBytes']+=charged_bytes-capacity;s[protocol+'ChargedBytes']+=charged_bytes-capacity;s['observedBytes']+=len(raw)
            s['chargedEntities']+=charged-q['maxRows'];s['returnedEntities']+=count or 0
            if not known:s['unknownEntityReservations']+=q['maxRows']
            cap.update(entityRows=count,chargedEntities=charged,chargedBytes=charged_bytes,closureKnown=closed)
            cap['accessRestricted']=bool(access)
            cap['classification']=None if rpc or docs else classify_error_only(parsed,cap,policy_version='HOLDER_R3')
            special=cap['classification'] in CLASSIFICATIONS
            veto=access or (cap.get('graphqlErrors') and not special) or cap.get('validationError') or cap.get('parseError') or failure in ('body_cap','owner_cancellation','local_or_protocol','local_reserve_refusal','transport_terminal','unknown_closure','attempt_deadline')
            cap['retryable']=self.retry_allowed(q,cap,special,veto)
            cap['identityValidated']=bool(cap['usable'] and q['kind']!='schema')
            if q['kind']=='schema':cap['schemaValidated']=bool(cap['usable'])
            cap['stopReason']=None if cap['usable'] else 'Unusable response: '+str(failure or cap.get('validationError') or cap.get('parseError') or ('GraphQL errors' if cap.get('graphqlErrors') else status))
            if access:cap['usable']=False;cap['retryable']=False;cap['stopReason']='Access/quota/payment restriction'
            self.storage.json(directory/'capture.json',cap)
            self.storage.append(self.root/'LEDGER.jsonl',cap)
            # Clear pending ONLY after both exact capture and append-only ledger are durable.
            s['pending']=None if closed else s['pending'];self.persist()
            
            return cap,(cap['selectedHeaderResult'] if rpc else raw.decode('utf-8',errors='replace') if docs else parsed.get('data')) if cap['usable'] else None
        except BaseException:
            self.failed=True
            self.state=reserved_state
            # The on-disk pre-dispatch pending reservation remains authoritative if persistence failed.
            raise
    def close(self,reason):
        if self.closed:return
        self.closed=True
        self.state.update(status='CLOSURE_OR_ACCOUNTING_UNKNOWN' if self.state['pending'] else 'CLOSED',closureReason=reason,closedAt=utc())
        self.persist()
