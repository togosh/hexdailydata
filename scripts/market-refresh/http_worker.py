"""Adapted accepted streaming child: exactly one POST, no redirect/retry/credentials."""
import errno
import http.client
import json
import os
import re
import socket
import sys
from pathlib import Path
# -I excludes the script directory; add only this reviewed task directory.
sys.path.insert(0,str(Path(__file__).resolve().parent))
from durable import save,strict_json,encode
from task_queries import SCOPE,validate_job,SELECTORS
from durable import digest

from http_framing import stream_body
from response_caps import response_capacity


def main():
    request_path,body_path,meta_path,nonce=sys.argv[1:]
    request=Path(request_path).resolve();session=request.parents[2]
    admission=strict_json((session/'ADMISSION.json').read_bytes())
    accounting=strict_json((session/'ACCOUNTING.json').read_bytes())
    if admission['nonce']!=nonce or accounting['pending']['requestPath']!=str(request):raise ValueError('No bound active admission')
    req=strict_json(request.read_bytes());method,url,body=validate_job(req['job'])
    q=req['job']
    for name,sha in admission['sourceFiles'].items():
        if digest((Path(__file__).resolve().parent/name).read_bytes())!=sha:raise ValueError('Reviewed source binding changed')
    if accounting['status']!='ADMITTED':raise ValueError('Inactive admission')
    if q.get('pin') is not None:
        pins=strict_json((session/'PINS.json').read_bytes())
        if q['pin'] not in pins:raise ValueError('Foreign graph pin')
    if q['kind'] in ('pools',):
        recipe=strict_json((session/('SCHEMA_'+str(q['endpoint'])+'.json')).read_bytes())
        if q['recipe']!=recipe['recipe'] or q['deployment']!=recipe['deployment']:raise ValueError('Unobserved schema/deployment')
    if q['kind']=='rpc':
        if q['method']=='eth_getBlockByNumber':
            if int(q['params'][0],16) not in strict_json((session/'TARGET_NUMBERS.json').read_bytes()):raise ValueError('Unselected header')
        if q['method']=='eth_call':
            allow=strict_json((session/'CONTRACT_ALLOWLIST.json').read_bytes())
            target=q['params'][0];slot='tokens' if target['data']==SELECTORS['decimals()'] else 'pools'
            if target['to'] not in allow[slot] or q['params'][1]['blockHash']!=allow['pin']['hash']:raise ValueError('Unreviewed contract address/pin')
    if body!=(request.parent/'request.body').read_bytes():raise ValueError('Original request bytes differ')
    capacity=response_capacity(q)
    host=url.split('/')[2]
    if url not in SCOPE['graphEndpoints']+SCOPE['rpcEndpoints']+[]:raise ValueError('Unapproved endpoint')
    record={'status':None,'complete':False,'transportError':None,'failureKind':None,'connectionClosed':False}
    save(meta_path,record)
    conn=http.client.HTTPSConnection(host,port=443,timeout=18)
    try:
        conn.request(method,url[len('https://'+host):],body=body if method=='POST' else None,headers={
            'Accept':'application/json','Accept-Encoding':'identity','Content-Type':'application/json',
            'User-Agent':'HDD-Market-Refresh/1.0'})
        response=conn.getresponse()
        headers=response.getheaders()
        if sum(len(k)+len(v) for k,v in headers)>32768:raise ValueError('Header byte bound')
        if len(encode({**record,'status':response.status,'headers':headers}))>60000:raise ValueError('Encoded header receipt bound')
        record.update(status=response.status,headers=headers)
        save(meta_path,record)
        stream_body(response,body_path,record,capacity)
    except (TimeoutError,socket.timeout) as exc:
        record.update(transportError=f'{type(exc).__name__}: {exc}',failureKind='transport_timeout',complete=False)
    except OSError as exc:
        transient=exc.errno in {errno.ECONNRESET,errno.ECONNABORTED,errno.EPIPE,errno.ETIMEDOUT,errno.ECONNREFUSED,errno.EHOSTUNREACH,errno.ENETUNREACH} or isinstance(exc,socket.gaierror) and exc.errno==socket.EAI_AGAIN
        record.update(transportError=f'{type(exc).__name__}: {exc}',failureKind='network' if transient else 'transport_terminal',complete=False)
    except Exception as exc:
        record.update(transportError=f'{type(exc).__name__}: {exc}',failureKind='local_or_protocol',complete=False)
    finally:
        conn.close();record['connectionClosed']=True
        save(meta_path,record)

if __name__=='__main__':main()
