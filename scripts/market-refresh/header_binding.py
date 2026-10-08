"""Header and ABI validation; identities acquired only from the bounded inventory."""
import re
from task_queries import pin_valid,SELECTORS

def quantity(v):
    if not isinstance(v,str) or not re.fullmatch('0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})',v):raise ValueError('RPC quantity')
    return int(v,16)

def validate_rpc(q,parsed):
    if not isinstance(parsed,dict) or set(parsed)!={'jsonrpc','id','result'} or parsed['jsonrpc']!='2.0' or type(parsed['id']) is not int or parsed['id']!=1:raise ValueError('RPC envelope/error/ID')
    v=parsed['result'];m=q['method']
    if m=='eth_chainId':
        if quantity(v)!=369:raise ValueError('Chain identity')
        return 369
    if m=='eth_blockNumber':return quantity(v)
    if m=='eth_getBlockByNumber':
        if not isinstance(v,dict):raise ValueError('Null header')
        p={k:quantity(v[k]) if k in ('number','timestamp') else v[k].lower() for k in ['number','hash','timestamp','parentHash']}
        pin_valid(p)
        if p['number']!=int(q['params'][0],16):raise ValueError('Header number')
        return p
    if not isinstance(v,str) or not re.fullmatch('0x[0-9a-fA-F]+',v):raise ValueError('ABI hex result')
    selector=q['params'][0]['data'];words=3 if selector==SELECTORS['getReserves()'] else 1
    if len(v)!=2+64*words:raise ValueError('ABI exact word count')
    values=[int(v[2+i*64:2+(i+1)*64],16) for i in range(words)]
    if selector in [SELECTORS[n] for n in ['token0()','token1()','factory()']]:
        if not 0<values[0]<2**160:raise ValueError('ABI address padding/zero')
        return '0x'+format(values[0],'040x')
    if selector==SELECTORS['decimals()']:
        if not 0<=values[0]<=36:raise ValueError('Unsupported token decimals')
        return values[0]
    if values[0]>=2**112 or values[1]>=2**112 or values[2]>=2**32:raise ValueError('ABI reserve width')
    return [str(x) for x in values]
