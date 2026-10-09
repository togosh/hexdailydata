"""The two standard Ethereum USD proxies; exact numeric pins and bounded ABI."""
import re, hashlib
from datetime import datetime, timezone
from durable import encode

ENDPOINTS = ('https://ethereum-rpc.publicnode.com/', 'https://ethereum.public.blockpi.network/v1/rpc/public')
FEEDS = {'BTC': '0xf4030086522a5beea4988f8ca5b36dbc97bee88c', 'ETH': '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419'}
SELECTORS = {'decimals': '0x313ce567', 'description': '0x7284e416', 'aggregator': '0x245a7bfc', 'round': '0xfeaf968c'}

def quantity(v):
    if not isinstance(v, str) or not re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})', v):
        raise ValueError('Canonical quantity')
    return int(v, 16)

def hash32(v):
    if not isinstance(v, str) or not re.fullmatch('0x[0-9a-fA-F]{64}', v):
        raise ValueError('Hash32')
    return v.lower()

def instant(v):
    return datetime.fromisoformat(v.replace('Z', '+00:00'))

def objects(v):
    return 1 + sum(map(objects, v.values())) if isinstance(v, dict) else 1 + sum(map(objects, v)) if isinstance(v, list) else 0

def kind(q):
    return q['method'] if q['method'] != 'eth_call' else next((k for k, v in SELECTORS.items() if v == q['params'][0]['data']), None)

def capacity(q):
    return 1048576 if q['method'] == 'eth_getBlockByNumber' else 131072 if q['method'] == 'eth_getCode' else 8192

def call(asset, method, number):
    return [{'to': FEEDS[asset], 'data': SELECTORS[method]}, hex(number)]

def job(ep, method, params, cycle=0, phase='entry'):
    q = dict(kind='rpc', endpoint=ep, method=method, params=params, cycle=cycle, phase=phase, maxRows=128 if method == 'eth_getBlockByNumber' else 40)
    validate_job(q)
    return q

def validate_job(q):
    if not isinstance(q, dict) or set(q) != {'kind', 'endpoint', 'method', 'params', 'cycle', 'phase', 'maxRows'} or q['kind'] != 'rpc' or type(q['endpoint']) is not int or q['endpoint'] not in (0, 1):
        raise ValueError('Exact job')
    m, p, c, phase = q['method'], q['params'], q['cycle'], q['phase']
    if type(c) is not int or not 0 <= c <= 2 or not isinstance(p, list) or q['maxRows'] != (128 if m == 'eth_getBlockByNumber' else 40):
        raise ValueError('Cycle/object cap')
    ok = False
    if m == 'eth_chainId':
        ok = c == 0 and phase == 'entry' and p == []
    elif c in (1, 2):
        if m == 'eth_getBlockByNumber':
            ok = len(p) == 2 and p[1] is False and (phase == 'head' and p[0] == 'latest' or phase in ('open', 'close') and quantity(p[0]) > 2)
        elif m == 'eth_getCode':
            ok = phase == 'code' and len(p) == 2 and p[0] in FEEDS.values() and quantity(p[1]) > 2
        elif m == 'eth_call':
            ok = len(p) == 2 and isinstance(p[0], dict) and set(p[0]) == {'to', 'data'} and p[0]['to'] in FEEDS.values() and kind(q) is not None and quantity(p[1]) > 2 and (phase == kind(q) or phase == 'close-round' and kind(q) == 'round')
    if not ok:
        raise ValueError('Unapproved exact request')
    return 'POST', ENDPOINTS[q['endpoint']], encode({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p})

def words(v, n):
    if not isinstance(v, str) or not re.fullmatch('0x[0-9a-fA-F]{' + str(n * 64) + '}', v):
        raise ValueError('Exact ABI length')
    return [int(v[i:i + 64], 16) for i in range(2, len(v), 64)]

def header(v):
    if not isinstance(v, dict):
        raise ValueError('Missing header')
    h = {k: quantity(v[k]) for k in ('number', 'timestamp')}
    if not 0 < h['timestamp'] <= 2**53 - 1 or not 2 < h['number'] <= 2**53 - 1:
        raise ValueError('Header bounds')
    h.update({k: hash32(v[k]) for k in ('hash', 'parentHash')})
    tx = v.get('transactions')
    if not isinstance(tx, list) or len(tx) > 16384 or any(not isinstance(t, str) for t in tx):
        raise ValueError('Header transaction hashes')
    for t in tx:
        hash32(t)
    return h

def compare_headers(a, b):
    if a != b:
        raise ValueError('Paired/closing header mismatch')

def validate_rpc(q, p):
    if not isinstance(p, dict) or set(p) != {'jsonrpc', 'id', 'result'} or p['jsonrpc'] != '2.0' or type(p['id']) is not int or p['id'] != 1:
        raise ValueError('Mandatory RPC error/invalid envelope')
    v, k = p['result'], kind(q)
    if k == 'eth_chainId':
        if quantity(v) != 1:
            raise ValueError('Wrong chain')
        return 1
    if k == 'eth_getBlockByNumber':
        h = header(v)
        if q['params'][0] != 'latest' and h['number'] != quantity(q['params'][0]):
            raise ValueError('Wrong numbered header')
        return h
    if k == 'eth_getCode':
        if not isinstance(v, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2}){1,65500}', v):
            raise ValueError('Nonempty bounded runtime code')
        return {'bytes': (len(v) - 2) // 2, 'sha256': hashlib.sha256(bytes.fromhex(v[2:])).hexdigest()}
    asset = next(a for a, proxy in FEEDS.items() if proxy == q['params'][0]['to'])
    if k == 'decimals':
        if words(v, 1) != [8]:
            raise ValueError('Expected eight decimals')
        return 8
    if k == 'aggregator':
        n = words(v, 1)[0]
        if not 0 < n < 2**160:
            raise ValueError('Padded nonzero aggregator address')
        return '0x' + format(n, '040x')
    if k == 'description':
        if not isinstance(v, str) or not re.fullmatch(r'0x[0-9a-fA-F]{192}', v):
            raise ValueError('Bounded dynamic description')
        w = words(v, 3)
        expected = (asset + ' / USD').encode('ascii')
        if w[:2] != [32, len(expected)] or bytes.fromhex(v[130:]) != expected.ljust(32, b'\0'):
            raise ValueError('Exact description offset/length/padding/value')
        return expected.decode('ascii')
    w = words(v, 5)
    if not 0 < w[0] < 2**80 or w[4] >= 2**80:
        raise ValueError('uint80 round fields')
    answer = w[1] - 2**256 if w[1] >= 2**255 else w[1]
    if answer <= 0 or w[3] <= 0 or w[2] > w[3]:
        raise ValueError('Positive answer/time or startedAt ordering')
    return dict(zip(('roundId', 'answer', 'startedAt', 'updatedAt', 'answeredInRound'), map(str, [w[0], answer, *w[2:]])))

def reading(asset, state, pin, now):
    t = int(state['updatedAt'])
    if t > pin['timestamp'] or not 0 <= now - t <= 86400:
        raise ValueError('Oracle timestamp future/older than promotion cap')
    n = int(state['answer'])
    value = str(n // 100000000) + ('.' + format(n % 100000000, '08d').rstrip('0') if n % 100000000 else '')
    return {'kind': 'reference', 'asset': asset, 'quote': 'USD', 'observation': 'oracle-reference', 'chainId': 1, 'method': 'chainlink-standard-usd-1', 'roundId': state['roundId'], 'value': value, 'observedAtUtc': datetime.fromtimestamp(t, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}

def compare_round(old, new):
    a, b = int(old['roundId']), int(new['roundId'])
    if b < a or b == a and old != new or int(new['updatedAt']) < int(old['updatedAt']) or new['updatedAt'] == old['updatedAt'] and new['answer'] != old['answer']:
        raise ValueError('Round regression/same-round mutation/same-time conflict')
    return old == new
