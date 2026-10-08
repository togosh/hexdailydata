"""Exact task endpoints and finite schema-derived query families."""
import json,re
from pathlib import Path
from durable import encode
from schema import compile_data,meta,HEX
ROOT=Path(__file__).resolve().parent
SCOPE=json.loads((ROOT/'SCOPE.json').read_text())
GRAPH=SCOPE['graphEndpoints'];RPC=SCOPE['rpcEndpoints'];DOCS=[]
FOCUS=json.loads((ROOT/'FOCUS_POOLS.json').read_text())
POOLS={p['address']:p for p in FOCUS['pools']}
TOKENS=set(FOCUS['tokenAddresses'])
LIMITS={'meta':32,'pools':32}
SCHEMA_NAMES={'TokenDayData','TokenDayData_filter','TokenDayData_orderBy','Pair','PairDayData','PairDayData_filter','PairDayData_orderBy'}
SELECTORS={'token0()':'0x0dfe1681','token1()':'0xd21220a7','factory()':'0xc45a0155','getReserves()':'0x0902f1ac','decimals()':'0x313ce567'}

def address(v):
    if not isinstance(v,str) or not re.fullmatch('0x[0-9a-f]{40}',v):raise ValueError('Address syntax')
    return v

def pin_valid(p):
    if not isinstance(p,dict) or set(p)!={'number','hash','timestamp','parentHash'}:raise ValueError('Pin fields')
    if type(p['number']) is not int or p['number']<=0 or type(p['timestamp']) is not int or p['timestamp']<=0:raise ValueError('Pin quantities')
    for f in ['hash','parentHash']:
        if not re.fullmatch('0x[0-9a-f]{64}',p[f]) or int(p[f][2:],16)==0:raise ValueError('Pin hash')

def graph_job(kind,endpoint,**kwargs):
    q={'kind':kind,'endpoint':endpoint,**kwargs}
    q['maxRows']=LIMITS[kind]
    return q

def rpc_job(endpoint,method,params):return {'kind':'rpc','endpoint':endpoint,'method':method,'params':params,'id':1,'maxRows':64 if method=='eth_getBlockByNumber' else 2}

def validate_job(q):
    kind=q['kind'];ep=q['endpoint']
    if type(ep) is not int or ep not in (0,1):raise ValueError('Endpoint index')
    if kind=='rpc':
        if set(q)!={'kind','endpoint','method','params','id','maxRows'} or q['id']!=1 or q['maxRows']!=(64 if q['method']=='eth_getBlockByNumber' else 2):raise ValueError('RPC job fields')
        m=q['method'];p=q['params']
        if m not in SCOPE['rpcMethods']:raise ValueError('RPC method')
        if m in ('eth_chainId','eth_blockNumber') and p!=[]:raise ValueError('Head parameters')
        if m=='eth_getBlockByNumber' and (len(p)!=2 or not re.fullmatch('0x[0-9a-f]+',p[0]) or p[1] is not False):raise ValueError('Header parameters')
        if m=='eth_call':
            if len(p)!=2 or set(p[0])!={'to','data'} or p[0]['data'] not in SELECTORS.values() or set(p[1])!={'blockHash','requireCanonical'} or p[1]['requireCanonical'] is not True:raise ValueError('Call parameters')
            address(p[0]['to'])
            allowed=TOKENS if p[0]['data']==SELECTORS['decimals()'] else POOLS
            if p[0]['to'] not in allowed:raise ValueError('Foreign contract target')
            if not re.fullmatch('0x[0-9a-f]{64}',p[1]['blockHash']):raise ValueError('State hash')
        return 'POST',RPC[ep],encode({'jsonrpc':'2.0','id':1,'method':m,'params':p})
    if kind not in LIMITS:raise ValueError('Query kind')
    if q['maxRows']!=LIMITS[kind]:raise ValueError('Object reservation changed')
    common={'kind','endpoint','maxRows'}
    if kind=='meta':
        if set(q)!=common|{'pin','deployment'}:raise ValueError('Metadata job fields')
        if q['pin'] is not None:pin_valid(q['pin'])
        query='{ '+meta(q['pin'])+' }'
    else:
        extras={'addresses'} if kind=='pools' else {'address','from','to','cursor'}
        if set(q)!=common|{'pin','deployment','recipe'}|extras:raise ValueError('Data job fields')
        pin_valid(q['pin'])
        if kind=='pools':
            if sorted(q['addresses'])!=sorted(a for a,p in POOLS.items() if p['graphEndpointIndex']==ep):raise ValueError('Exact venue focus set required')
        query=compile_data(q)
    if kind!='schema' and q['deployment']!=SCOPE['expectedDeployments'][ep]:raise ValueError('Expected deployment required')
    if len(query)>32000:raise ValueError('Query bound')
    return 'POST',GRAPH[ep],encode({'query':query})

def entity_rows(value):
    if isinstance(value,dict):return 1+sum(entity_rows(v) for v in value.values())
    if isinstance(value,list):return sum(entity_rows(v) for v in value)
    return 0

def check_meta(m,pin,deployment):
    if not isinstance(m,dict) or set(m)!={'deployment','hasIndexingErrors','block'}:raise ValueError('Graph metadata shape')
    if m['hasIndexingErrors'] is not False:raise ValueError('Indexing errors/unknown')
    if not isinstance(m['deployment'],str) or not 1<=len(m['deployment'])<=128 or deployment and m['deployment']!=deployment:raise ValueError('Deployment identity')
    b=m['block']
    if not isinstance(b,dict) or set(b)!={'number','hash','timestamp'} or type(b['number']) is not int:raise ValueError('Block metadata shape')
    if pin and (b['number']!=pin['number'] or b['hash']!=pin['hash'] or b['timestamp'] is not None and b['timestamp']!=pin['timestamp']):raise ValueError('Graph pin mismatch')
    return m

def validate_data(q,data):
    if not isinstance(data,dict):raise ValueError('Missing data object')
    check_meta(data.get('_meta'),q['pin'],q['deployment'])
    if q['kind']=='meta':
        if set(data)!={'_meta'}:raise ValueError('Unexpected metadata data')
        return data
    expected={'items','_meta'}|({'bundles'} if q['kind']=='pools' and q['recipe']['bundleField'] else set())
    if set(data)!=expected or not isinstance(data['items'],list):raise ValueError('Data families')
    limit=2 if q['kind']=='pools' else 100
    if len(data['items'])>limit:raise ValueError('Root row ceiling')
    ids=[]
    for row in data['items']:
        if not isinstance(row,dict) or not isinstance(row.get('id'),str):raise ValueError('Row identity')
        ids.append(row['id'])
        address(row['id']);tokens=[address(row[k]['id']) for k in ('token0','token1')]
        if tokens.count(HEX)!=1 or tokens[0]==tokens[1]:raise ValueError('Not directly related HEX pool')
        f=POOLS.get(row['id'])
        if f is None or f['graphEndpointIndex']!=q['endpoint'] or tokens!=[f['originalPool'][k]['id'] for k in ('token0','token1')]:raise ValueError('Focus token identity drift')
        if q['kind']=='pools' and row['id'] not in q['addresses']:raise ValueError('Unexpected pool')
    if len(ids)!=len(set(ids)) or ids!=sorted(ids):raise ValueError('Duplicate/unordered IDs')
    if 'bundles' in data and (not isinstance(data['bundles'],list) or len(data['bundles'])>2):raise ValueError('Bundle cap')
    return data
