"""Hard-offline reconstruction through the real GET/framing/client path; no bases."""
import sys
sys.dont_write_bytecode=True
def deny(event,args):
    if event.startswith('socket.'): raise PermissionError('OFFLINE_NETWORK_DENIED')
sys.addaudithook(deny)
import os, json, io, tempfile, importlib.util, copy, subprocess
from pathlib import Path
W=Path(__file__).resolve().parents[2]
T=Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\response-cookie-handling-r1')
sys.path.insert(0,str(W/'scripts/trade-feed'))
from client import Session, URLS, CAP, RESERVATION, save, strict_json, digest, worker_native, native_module
from worker import perform_request
from authority import COOKIE_AUTHORITY, COOKIE_ROOT, COOKIE_POLICY, cookie_policy, validate_authority, validate_recovery_documents, ISOLATION_AUTHORITY
spec=importlib.util.spec_from_file_location('maintained_get',W/'scripts/benchmark-reference/get_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker);worker.CAP=CAP
BODY=(T/'reference/markets.body').read_bytes()
assert len(BODY)==99217 and digest(BODY)=='9b2db367c10c0784a6fbc3e4a3deb90a4c73bda4e162d3cf1841007655cc445d'
cases=[];results=[]
class Clock:
    def __init__(self):self.t=0
    def mono(self):return self.t
    def wall(self):return 100000+self.t
    def sleep(self,s):self.t+=s
class Socket:
    def __init__(self,raw):self.raw=raw
    def makefile(self,*a,**kw):return io.BytesIO(self.raw)
def cookies(n):
    return b''.join((b'Set-Cookie' if i%2 else b'sEt-CoOkIe')+b': SYNTHETIC_ONLY=fixture; Expires=Wed, 21 Oct 2030 07:28:00 GMT\r\n' for i in range(n))
def response(status=200,body=BODY,extra=b''):
    return b'HTTP/1.1 '+str(status).encode()+b' Fixture\r\nContent-Length: '+str(len(body)).encode()+b'\r\n'+extra+b'\r\n'+body
def setup(replies,new=True):
    root=Path(tempfile.mkdtemp(prefix='cookies-',dir=T/'fixtures'));(root/'temp').mkdir()
    save(root/'FIXTURE.json',{'synthetic':True,'reconstructedHeaders':True,'originalBodySha256':digest(BODY),'publicRequests':0})
    clock=Clock();calls=[]
    a={'nonce':'synthetic-only','startedAtUnixSeconds':clock.wall()}
    if new:a.update(authorityTaskId=COOKIE_AUTHORITY,responseCookiePolicyId=COOKIE_POLICY)
    else:a.update(authorityTaskId=ISOLATION_AUTHORITY)
    def runner(args,env,*unused):
        q=strict_json(Path(args[-1]).read_bytes());item=replies.pop(0)
        if isinstance(item,str):
            if item=='begun-timeout':
                (Path(args[-1]).parent/'PHASES.ndjson').write_text(json.dumps({'event':'dns_tcp_tls_connection_begin','unixSeconds':clock.wall()})+'\n')
            calls.append({'kind':item,'url':q['url'],'at':clock.t})
            return {'reaped':item!='unknown','timeout':True,'interrupted':None,'exit':-1,'seconds':.1,'stdout':'','stderr':''}
        class Connection:
            def __init__(self,host,port,timeout):assert (host,port,timeout)==('www.bitstamp.net',443,24)
            def request(self,method,path,headers):
                assert method=='GET' and path==q['url'][len('https://www.bitstamp.net'):]
                assert headers=={'Accept':'application/json','Accept-Encoding':'identity','User-Agent':'HDD-Bounded-Historical-Reference/1','Connection':'close'}
                assert not {'cookie','cookie2','authorization','proxy-authorization'} & {k.lower() for k in headers}
                calls.append({'kind':'request','url':q['url'],'method':method,'path':path,'headers':dict(headers),'at':clock.t})
            def getresponse(self):
                r=self.response_class(Socket(item));r.begin();return r
            def close(self):pass
        perform_request(q,a,Path(args[-1]).parent,worker.perform,clock.wall,Connection)
        clock.t+=.1
        return {'reaped':True,'timeout':False,'interrupted':None,'exit':0,'seconds':.1,'stdout':'','stderr':''}
    s=Session(root,a,runner,clock.mono,clock.wall,clock.sleep)
    return s,calls
def run(name,fn):
    fn();cases.append(name)
def refused(fn):
    try:fn()
    except (ValueError,KeyError,PermissionError):return
    raise AssertionError('Expected refusal')
def finish(s,calls):
    s.close('Synthetic offline case complete')
    save(s.root/'OUTGOING.json',{'synthetic':True,'calls':calls,'noCookieOrAuthenticationSent':True})
    results.append({'fixture':str(s.root.relative_to(T)),'attempts':s.state['attempts'],'closed':s.state['status'],'chargedBytes':s.state['chargedBytes']})
def legacy():
    s,c=setup([response(extra=cookies(5)),response()],False)
    refused(lambda:s.get(URLS[0],'saved_markets_old_policy'))
    assert len(c)==1 and s.state['requests'][0]['integrityFailure']=='Cookie/authentication response'
    finish(s,c)
run('old refusal reproduced with saved exact body and five invented cookies; old receipts unchanged',legacy)
def counts():
    for n in [0,1,5,9]:
        s,c=setup([response(extra=cookies(n)+b'X-Fixture: safe\r\n')]);r=s.get(URLS[0],'saved_markets_new_policy')
        row=s.state['requests'][0]
        assert r['objects']==272 and row['ignoredResponseCookieCount']==n and row['transportComplete'] and row['complete']
        assert row['responseCookiePolicyId']==COOKIE_POLICY and row['authenticationChallengeCount']==0
        assert (s.root/'01/response.body').read_bytes()==BODY
        finish(s,c)
        if n==5: save(T/'evidence/ACCEPTED_MARKET_REPLAY.json',{'synthetic':True,'fixture':str(s.root.relative_to(T)),'bodySha256':r['bodySha256'],'bodyBytes':r['bodyBytes'],'objects':r['objects'],'ignoredResponseCookieCount':n,'oldOriginalRemainsRejected':True,'publicRequests':0})
run('zero/one/five/nine mixed-case cookies including Expires commas and duplicate names ignored without body change',counts)
def no_replay():
    trade=b'[{"date":"1791590400","tid":"1","price":"1.00"}]'
    s,c=setup([response(extra=cookies(9)),response(body=trade,extra=cookies(1)),response(503,b'[]',cookies(5)),response(body=trade,extra=cookies(9))])
    for url,label in zip(URLS,['markets','BTC','ETH']):s.get(url,label)
    assert len(c)==4 and c[2]['url']==c[3]['url'] and c[3]['at']-c[2]['at']>=2.1
    assert s.state['extras']==1 and s.state['chargedBytes']==4*RESERVATION
    assert all(x['headers']==c[0]['headers'] for x in c)
    finish(s,c)
    save(T/'evidence/NO_COOKIE_REPLAY.json',{'status':'PASS','synthetic':True,'fixture':str(s.root.relative_to(T)),'physicalInjectedRequests':4,'flow':['markets','BTC','ETH503','identicalETHretry200'],'fixedHeaders':c[0]['headers'],'outgoingCookieFields':0,'outgoingCredentialFields':0,'responseCarryover':False,'publicRequests':0})
run('actual maintained request arguments remain fixed across markets/BTC/ETH503/retry; no response-header carryover',no_replay)
def terminal():
    examples=[('status'+str(k),response(k,b'[]',cookies(1))) for k in [301,302,307,308,401,403,407,429]]
    examples += [(h.decode(),response(extra=cookies(1)+h+b': SYNTHETIC_CHALLENGE\r\n')) for h in [b'WWW-Authenticate',b'pRoXy-AuThEnTiCaTe']]
    examples += [('CLTE',response(extra=cookies(1)+b'Transfer-Encoding: chunked\r\n')),('conflictingCL',response(extra=b'Content-Length: 1\r\n')),
      ('truncated',response(body=b'[]')[:-1]),('encoding',response(extra=b'Content-Encoding: gzip\r\n')),('chunk',b'HTTP/1.1 200 OK\r\nTransfer-Encoding: weird\r\n\r\n[]'),
      ('headerline',response(extra=b'X: '+b'x'*4096+b'\r\n')),('headers',response(extra=cookies(900))),('body',response(body=b'x'*(CAP+1))),
      ('objects',response(body=('['+','.join(['{}']*20000)+']').encode())),('duplicate',response(body=b'[{"a":1,"a":2}]')),('malformed',response(body=b'{bad'))]
    for name,raw in examples:
        s,c=setup([raw,response()]);refused(lambda:s.get(URLS[0],name));assert len(c)==1
        if 'Authenticate' in name or 'ThEnTiCaTe' in name:
            assert s.state['requests'][0]['authenticationChallengeCount']==1
        finish(s,c)
run('cookie-bearing access/rate/redirect/challenge refusals and framing/encoding/header/body/object/JSON guards remain terminal',terminal)
def life():
    for item,expected in [('timeout',1),('begun-timeout',2),('unknown',1)]:
        s,c=setup([item,response(extra=cookies(1))])
        if expected==2:s.get(URLS[0],item)
        else:refused(lambda:s.get(URLS[0],item))
        assert len(c)==expected and s.state['chargedBytes']==expected*RESERVATION
        finish(s,c)
        if item=='unknown':assert s.state['pending'] and s.state['status']=='UNKNOWN'
        refused(lambda:Session(s.root,s.a,lambda *a:None))
run('new authority keeps pre-network timeout terminal, begun timeout single retry, unknown reservation and consumed refusal',life)
def special():
    for kind in ['synthetic','diagnostic','TLS']:
        s,c=setup([response()]);runner=s.runner
        def wrapped(args,env,*rest):
            r=runner(args,env,*rest);p=Path(args[-1]).parent
            if kind=='diagnostic':(p/'PHASES.ndjson').write_bytes(b'x'*8193)
            else:
                m=strict_json((p/'response.json').read_bytes())
                if kind=='synthetic':m['synthetic']=True
                else:m.update(complete=False,failureKind='terminal',error='SSLCertVerificationError: SYNTHETIC_TLS_REFUSAL')
                save(p/'response.json',m)
            return r
        s.runner=wrapped;refused(lambda:s.get(URLS[0],kind));assert len(c)==1;finish(s,c)
    seen=[];old=native_module.subprocess.Popen
    class P:
        returncode=0
        def __init__(self,*args,**kw):seen.append(kw['stdin'])
        def communicate(self,timeout):return b'',b''
    try:
        native_module.subprocess.Popen=P;worker_native([],{},1,1)
    finally:native_module.subprocess.Popen=old
    assert seen==[subprocess.DEVNULL]
run('synthetic captures/TLS-terminal/bounded diagnostics still refused; worker DEVNULL retained without repeating stalls',special)
def authority():
    scope=(T/'packet/SCOPE.json').read_bytes()
    p={'authorityTaskId':COOKIE_AUTHORITY,'taskRoot':str(T),'synthetic':False,'verdict':'PASS','runtimeFiles':{'fixture':'synthetic'},'responseCookiePolicyId':COOKIE_POLICY}
    pre=json.dumps(p).encode()
    a={'authorityTaskId':COOKIE_AUTHORITY,'synthetic':False,'scopeSha256':digest(scope),'preflightSha256':digest(pre),'nonce':'0'*64,'runtimeFiles':p['runtimeFiles'],'responseCookiePolicyId':COOKIE_POLICY}
    m={'authorityTaskId':COOKIE_AUTHORITY,'output':str(T/'session'),'scopeSha256':digest(scope),'preflightSha256':digest(pre),'nonce':a['nonce'],'responseCookiePolicyId':COOKIE_POLICY}
    check=lambda a,b,c:validate_recovery_documents(a,T/'session',scope,b,c,root=COOKIE_ROOT,authority=COOKIE_AUTHORITY)
    check(a,pre,m)
    for key,value in [('authorityTaskId',ISOLATION_AUTHORITY),('synthetic',True),('scopeSha256','wrong'),('nonce','changed'),('runtimeFiles',{}),('responseCookiePolicyId','other')]:
        bad={**a,key:value};refused(lambda:check(bad,pre,m))
    for where in ['pre','marker','scope']:
        if where=='pre':
            b=json.dumps({**p,'responseCookiePolicyId':'wrong'}).encode();refused(lambda:check({**a,'preflightSha256':digest(b)},b,{**m,'preflightSha256':digest(b)}))
        elif where=='marker':refused(lambda:check(a,pre,{**m,'responseCookiePolicyId':'wrong'}))
        else:
            sc=json.loads(scope);sc['network']['responseCookiePolicy']['id']='wrong';b=json.dumps(sc).encode()
            refused(lambda:validate_recovery_documents({**a,'scopeSha256':digest(b)},T/'session',b,pre,{**m,'scopeSha256':digest(b)},root=COOKIE_ROOT,authority=COOKIE_AUTHORITY))
    refused(lambda:validate_recovery_documents(a,T/'fixtures',scope,pre,m,root=COOKIE_ROOT,authority=COOKIE_AUTHORITY))
    refused(lambda:validate_authority(a,T/'fixtures'))
    refused(lambda:cookie_policy({'responseCookiePolicyId':COOKIE_POLICY}))
    refused(lambda:cookie_policy({'authorityTaskId':COOKIE_AUTHORITY}))
run('exact root/nonce/scope/preflight/marker/policy authority bindings; arbitrary flag or fixture directory cannot admit',authority)
save(T/'evidence/RESPONSE_COOKIE_TESTS.json',{'status':'PASS','synthetic':True,'publicRequests':0,'baseAdmissions':0,'apiListeners':0,'hardNetworkDenied':True,'cases':cases,'fixtures':results})
print(json.dumps({'status':'PASS','groups':len(cases),'fixtureCount':len(results),'externalRequests':0}))
