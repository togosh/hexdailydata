"""Only the reviewed HEX calls, exact ABI words and paired pinned meanings."""
import re, hashlib
from datetime import datetime, timezone
from durable import encode
ENDPOINTS = ('https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/')
CONTRACT = '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39'
SELECTORS = {'global': '0xf04b5fa0', 'supply': '0x18160ddd', 'range': '0x6a210a0e', 'daily': '0x90de6871'}
CAPS = {'eth_chainId': 4096, 'eth_getBlockByNumber': 1048576, 'eth_getCode': 262144, 'global': 16384, 'supply': 16384, 'range': 65536, 'daily': 16384}
CODE_SHA = '331e6384b4acbab47e393ee5f85290cbdd8783be817b52643441c02bc0164511'
BASE_TAIL = ['39843667585415780402054842749992773873163573541193571208195', '39843667585415780402007518833040386995262157612152416642428']

def initial_ledger(value=None):
    if value is None:
        return {'number': 27720851, 'end': 2498, 'tail': BASE_TAIL[:]}
    if (not isinstance(value, dict) or set(value) != {'number', 'end', 'tail'}
        or type(value['number']) is not int or value['number'] < 27720851
        or type(value['end']) is not int or not 2498 <= value['end'] <= 65535
        or not isinstance(value['tail'], list) or len(value['tail']) != 2
        or any(not isinstance(w, str) or not re.fullmatch('0|[1-9][0-9]{0,77}', w)
               or int(w) >= 2**256 for w in value['tail'])):
        raise ValueError('Admitted protocol ledger seed')
    return value

def quantity(v):
    if not isinstance(v, str) or not re.fullmatch('0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})', v):
        raise ValueError('Canonical quantity')
    return int(v, 16)

def hash32(v):
    if not isinstance(v, str) or not re.fullmatch('0x[0-9a-fA-F]{64}', v):
        raise ValueError('Hash32')
    return v.lower()

def instant(v):
    return datetime.fromisoformat(v.replace('Z', '+00:00'))

def word(n):
    return hex(n)[2:].zfill(64)

def call(kind, pin, *args):
    return [{'to': CONTRACT, 'data': SELECTORS[kind] + ''.join((word(n) for n in args))}, {'blockHash': hash32(pin), 'requireCanonical': True}]

def kind(q):
    if q['method'] != 'eth_call':
        return q['method']
    return next((k for k, v in SELECTORS.items() if q['params'][0]['data'].startswith(v)), None)

def capacity(q):
    return CAPS[kind(q)]

def objects(v):
    if isinstance(v, dict):
        return 1 + sum((objects(x) for x in v.values()))
    if isinstance(v, list):
        return 1 + sum((objects(x) for x in v))
    return 0

def job(ep, method, params, cycle=0, phase='entry'):
    q = dict(kind='rpc', endpoint=ep, method=method, params=params, cycle=cycle, phase=phase, maxRows=128 if method == 'eth_getBlockByNumber' else 40)
    validate_job(q)
    return q

def validate_job(q):
    if set(q) != {'kind', 'endpoint', 'method', 'params', 'cycle', 'phase', 'maxRows'} or q['kind'] != 'rpc' or type(q['endpoint']) != int or (q['endpoint'] not in (0, 1)):
        raise ValueError('Exact job')
    m, p, c, phase = (q['method'], q['params'], q['cycle'], q['phase'])
    if type(c) != int or not 0 <= c <= 3 or q['maxRows'] != (128 if m == 'eth_getBlockByNumber' else 40):
        raise ValueError('Cycle/object cap')
    ok = False
    if m == 'eth_chainId':
        ok = c == 0 and phase == 'entry' and (p == [])
    elif m == 'eth_getBlockByNumber':
        ok = c > 0 and isinstance(p, list) and (len(p) == 2) and (p[1] is False) and (phase == 'head' and p[0] == 'latest' or (phase in ('open', 'close') and quantity(p[0]) > 27720851))
    elif m == 'eth_getCode':
        ok = c == 1 and phase == 'code' and (len(p) == 2) and (p[0] == CONTRACT) and (quantity(p[1]) > 27720851)
    elif m == 'eth_call':
        if not isinstance(p, list) or len(p) != 2 or set(p[0]) != {'to', 'data'} or (p[0]['to'] != CONTRACT) or (set(p[1]) != {'blockHash', 'requireCanonical'}) or (p[1]['requireCanonical'] is not True):
            raise ValueError('Canonical call object')
        hash32(p[1]['blockHash'])
        k = kind(q)
        data = p[0]['data']
        args = data[10:]
        if not re.fullmatch('[0-9a-f]*', args):
            raise ValueError('Call encoding')
        if k in ('global', 'supply'):
            ok = len(args) == 0 and (phase in ('global', 'close-global') if k == 'global' else phase == 'supply')
        elif k == 'range':
            if len(args) != 128:
                raise ValueError('Range encoding')
            a, b = (int(args[:64], 16), int(args[64:], 16))
            ok = phase == 'range' and 2496 <= a < b <= 65536 and (b - a <= 34)
        elif k == 'daily':
            ok = len(args) == 64 and phase in ('first', 'last') and (2498 <= int(args, 16) < 65536)
        ok = ok and c > 0
    if not ok:
        raise ValueError('Unapproved exact request')
    return ('POST', ENDPOINTS[q['endpoint']], encode({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}))

def words(v, n):
    if not isinstance(v, str) or not re.fullmatch('0x[0-9a-fA-F]{' + str(64 * n) + '}', v):
        raise ValueError('Exact ABI length')
    return [int(v[i:i + 64], 16) for i in range(2, len(v), 64)]

def unpack(v):
    if v >> 200:
        raise ValueError('Packed padding')
    return [str(v & (1 << 72) - 1), str(v >> 72 & (1 << 72) - 1), str(v >> 144)]

def header(v):
    if not isinstance(v, dict):
        raise ValueError('Missing header')
    out = {k: quantity(v[k]) for k in ('number', 'timestamp')}
    if max(out.values()) > 2 ** 53 - 1:
        raise ValueError('Header bound')
    out.update({k: hash32(v[k]) for k in ('hash', 'parentHash')})
    tx = v.get('transactions')
    if not isinstance(tx, list) or len(tx) > 16384:
        raise ValueError('Header hashes')
    out['transactions'] = [hash32(t) for t in tx]
    if len(set(out['transactions'])) != len(tx):
        raise ValueError('Duplicate tx hash')
    return out

def compare_headers(a, b):
    if a != b:
        raise ValueError('Paired/closing header mismatch')
compare_closing_header = compare_headers

def validate_rpc(q, p):
    if not isinstance(p, dict) or set(p) != {'jsonrpc', 'id', 'result'} or p['jsonrpc'] != '2.0' or (type(p['id']) != int) or (p['id'] != 1):
        raise ValueError('Mandatory RPC error/invalid envelope')
    v = p['result']
    k = kind(q)
    if k == 'eth_chainId':
        n = quantity(v)
        if n != 369:
            raise ValueError('Wrong chain')
        return n
    if k == 'eth_getBlockByNumber':
        h = header(v)
        if q['params'][0] != 'latest' and h['number'] != quantity(q['params'][0]):
            raise ValueError('Wrong numbered header')
        return h
    if k == 'eth_getCode':
        if not isinstance(v, str) or not re.fullmatch('0x[0-9a-fA-F]{41978}', v):
            raise ValueError('Code length')
        if hashlib.sha256(bytes.fromhex(v[2:])).hexdigest() != CODE_SHA:
            raise ValueError('Runtime code identity')
        return {'bytes': 20989, 'sha256': CODE_SHA}
    if k in ('global', 'supply', 'daily'):
        w = words(v, 13 if k == 'global' else 3 if k == 'daily' else 1)
        if k == 'global' and (w[4] > 65535 or not w[2]):
            raise ValueError('Global count/rate')
        if k == 'daily' and any((x >> bits for x, bits in zip(w, (72, 72, 56)))):
            raise ValueError('Getter padding')
        return [str(x) for x in w]
    args = q['params'][0]['data'][10:]
    a, b = (int(args[:64], 16), int(args[64:], 16))
    w = words(v, 2 + b - a)
    if w[:2] != [32, b - a]:
        raise ValueError('Dynamic ABI offset/count')
    for x in w[2:]:
        unpack(x)
    return [str(x) for x in w[2:]]

def qualify_values(pin, globals_, supply, ranges, end, tail, getters):
    if globals_[0] != globals_[1] or any((s != [globals_[0][11]] for s in supply)):
        raise ValueError('Paired globals/supply mismatch')
    w = list(map(int, globals_[0]))
    d = w[4]
    if w[10] != pin['timestamp'] or not 0 <= d <= (w[10] - 1575331200) // 86400 <= 65535:
        raise ValueError('Global timestamp/day')
    if d < end or d - end > 32:
        raise ValueError('Bounded catch-up: dailyCount outside accepted end plus 32')
    if ranges[0] != ranges[1] or len(ranges[0]) != d - end + 2 or ranges[0][:2] != tail:
        raise ValueError('Paired range/immutable overlap')
    suffix = ranges[0][2:]
    for day, values in getters.items():
        expected = unpack(int(suffix[day - end]))
        if values != [expected, expected]:
            raise ValueError('Range/getter mismatch')
    required = set([end, d - 1]) if suffix else set()
    if set(getters) != required:
        raise ValueError('New boundary getter coverage')
    r = {'kind': 'protocol', 'chainId': 369, 'blockNumber': pin['number'], 'blockHash': pin['hash'], 'observedAtUtc': datetime.fromtimestamp(pin['timestamp'], timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'globalWords': globals_[0]}
    return (r, {'from': end, 'overlap': tail, 'words': suffix})
