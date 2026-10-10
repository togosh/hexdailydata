"""Injected in-memory HTTP bytes through the real bounded GET and census accounting."""
import sys
sys.dont_write_bytecode=True
from pathlib import Path
import os,tempfile,json,io,importlib.util
W=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(W/'scripts/trade-feed'))
from client import Session,URLS,CAP,RESERVATION,exact_request,save,strict_json,parsed_objects,native
sys.path.insert(0,str(W/'scripts/trade-feed'))
from collector import collect
R=Path(os.environ['HDD_TASK_ROOT']);assert R.name=='btc-eth-current-reference-freshness-r2'
(R/'fixtures').mkdir(exist_ok=True)
spec=importlib.util.spec_from_file_location('get_worker',W/'scripts/benchmark-reference/get_worker.py');worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker);worker.CAP=CAP
cases=[]
class Clock:
 def __init__(self):self.t=0
 def mono(self):return self.t
 def wall(self):return 100000+self.t
 def sleep(self,s):self.t+=s
class Socket:
 def __init__(self,raw):self.raw=raw
 def makefile(self,*a,**k):return io.BytesIO(self.raw)
def response(status=200,body=b'[]',extra=b'',chunk=False):
 framing=(b'Transfer-Encoding: chunked\r\n' if chunk else b'Content-Length: '+str(len(body)).encode()+b'\r\n')
 return b'HTTP/1.1 '+str(status).encode()+b' Status\r\n'+framing+extra+b'\r\n'+(hex(len(body))[2:].encode()+b'\r\n'+body+b'\r\n0\r\n\r\n' if chunk else body)
def setup(replies):
 root=Path(tempfile.mkdtemp(prefix='client-',dir=R/'fixtures'));(root/'temp').mkdir();clock=Clock();calls=[]
 def runner(args,env,*unused):
  q=strict_json(Path(args[-1]).read_bytes());item=replies.pop(0);calls.append((q,clock.t))
  assert env.get('TEMP')==str(root/'temp')
  if item in ('timeout','unknown'):
   return {'reaped':item=='timeout','timeout':True,'interrupted':None,'exit':-1,'seconds':0.1,'stdout':'','stderr':''}
  class Connection:
   def __init__(self,host,port,timeout):assert (host,port,timeout)==('www.bitstamp.net',443,24)
   def request(self,method,path,headers):
    assert method=='GET' and path in [u[len('https://www.bitstamp.net'):] for u in URLS]
    assert headers['Accept-Encoding']=='identity' and not any(k.lower() in ('authorization','cookie') for k in headers)
   def getresponse(self):
    r=self.response_class(Socket(item));r.begin();return r
   def close(self):pass
  worker.perform(q['url'],Path(args[-1]).parent,Connection);clock.t+=0.1
  return {'reaped':True,'timeout':False,'interrupted':None,'exit':0,'seconds':0.1,'stdout':'','stderr':''}
 s=Session(root,{'nonce':'synthetic','startedAtUnixSeconds':clock.wall()},runner,clock.mono,clock.wall,clock.sleep)
 return s,clock,calls
def test(name,fn):fn();cases.append(name)
def refused(fn):
 try:fn()
 except BaseException:return
 raise AssertionError('Expected refusal')
test('exact three GET URLs and query/method refusal',lambda:[refused(lambda:exact_request(m,u)) for m,u in [('POST',URLS[0]),('GET',URLS[1].replace('minute','hour')),('GET','https://bitstamp.net/api/v2/markets/')]])
def normal():
 s,c,calls=setup([response(chunk=True),response()]);a=s.get(URLS[0],'markets');s.get(URLS[1],'BTC_1');s.close('done')
 assert s.state['chargedBytes']==2*RESERVATION and s.state['attempts']==2 and s.state['chargedObjects']==2 and calls[1][1]-calls[0][1]>=1.1
 assert s.state['status']=='CLOSED' and a['objects']==1
 refused(lambda:Session(s.root,s.a))
test('actual chunk framing, full no-refund reservations, spacing, durable closure and consumed refusal',normal)
def retry():
 for first in ['timeout',response(503,body=b'upstream')]:
  s,c,calls=setup([first,response()]);s.get(URLS[0],'markets');s.close('done');assert s.state['attempts']==2 and s.state['extras']==1 and calls[1][1]-calls[0][1]>=2
  assert s.state['chargedBytes']==2*RESERVATION and calls[0][0]['url']==calls[1][0]['url']
test('only single identical timeout/503 retry with retained charges',retry)
def stops():
 for body in [response(301),response(429),response(401),response(503,extra=b'Content-Length: 0\r\n'),response(body=b'[{"a":1,"a":2}]'),response(body=b'{bad'),response(extra=b'Content-Encoding: gzip\r\n'),response(body=b'x'*(CAP+1)),response(extra=b'X: '+b'a'*65536+b'\r\n'),response(extra=b'Set-Cookie: private=value\r\n')]:
  s,c,calls=setup([body,response()]);refused(lambda:s.get(URLS[0],'markets'));assert len(calls)==1;s.close('expected terminal');assert s.state['status']=='CLOSED'
test('redirect/rate/auth/malformed/duplicate/encoding/framing/body/header/cookie terminal without retry',stops)
def unknown():
 s,c,calls=setup(['unknown',response()]);refused(lambda:s.get(URLS[0],'markets'));s.close('uncertain');assert s.state['status']=='UNKNOWN' and s.state['pending'] and len(calls)==1 and s.state['chargedBytes']==RESERVATION
test('uncertain closure keeps pending reservation and refuses continuation',unknown)
def bounds():
 s,c,calls=setup([response()]);s.state['attempts']=14;refused(lambda:s.get(URLS[0],'markets'));assert not calls
 s,c,calls=setup([response()]);c.t=535;refused(lambda:s.get(URLS[0],'markets'));assert not calls
 s,c,calls=setup([response()]);s.state['chargedObjects']=280000;refused(lambda:s.get(URLS[0],'markets'));assert not calls
 refused(lambda:parsed_objects(('['+','.join(['{}']*20000)+']').encode()))
test('attempt/deadline/control reserve and nested object caps',bounds)
def schedule():
 clock=Clock();messages=[]
 class S:
  def get(self,url,label):clock.t+=1;return {'url':url,'label':label}
  def check(self,*a):pass
 def exchange(kind,cycle,**extra):
  messages.append((kind,cycle,clock.t))
  if kind=='qualified' and cycle==1:clock.t+=70
  return {'outcome':'UNQUALIFIED' if cycle==1 else 'QUALIFIED'}
 result=collect(S(),exchange,clock.mono,clock.sleep)
 assert [r['status'] for r in result]==['UNQUALIFIED','SKIPPED','QUALIFIED']
 assert [m for m in messages if m[:2]==('begin',3)][0][2]==121
test('actual three-slot loop skips occupied slot, never catches up; unqualified may use later original slot',schedule)
def child():
 result=native([sys.executable,'-I','-S','-c','print("injected child, no network")'],{},2,1)
 assert result['reaped'] and result['exit']==0
test('real native child reap using nonnetwork fixture',child)
save(R/'evidence/TRANSPORT_TESTS.json',{'status':'PASS','synthetic':True,'externalRequests':0,'physicalLocalHttpRequests':0,'cases':cases})
print(json.dumps({'status':'PASS','cases':len(cases)}))
