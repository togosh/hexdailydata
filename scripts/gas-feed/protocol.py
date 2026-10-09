"""Fixed gas-only RPC shapes and lossless, independently timed sample semantics."""
import re
from datetime import datetime, timezone
from durable import encode
ENDPOINTS = ('https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/')
CAPS = {'eth_chainId': 16384, 'eth_getBlockByNumber': 1048576, 'eth_gasPrice': 16384, 'eth_maxPriorityFeePerGas': 16384, 'eth_feeHistory': 262144, 'eth_getTransactionByHash': 262144, 'eth_getTransactionReceipt': 262144}
OBJECTS = {m: 1024 if m == 'eth_getTransactionReceipt' else 128 if m in ('eth_getBlockByNumber', 'eth_feeHistory') else 16 for m in CAPS}
OPTIONAL = {'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'}

def quantity(value):
    if not isinstance(value, str) or not re.fullmatch('0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})', value):
        raise ValueError('Invalid uint256 RPC quantity')
    return int(value, 16)

def hash32(value):
    if not isinstance(value, str) or not re.fullmatch('0x[0-9a-fA-F]{64}', value):
        raise ValueError('Invalid hash')
    return value.lower()

def instant(value):
    d = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('UTC time required')
    return d.astimezone(timezone.utc)

def job(ep, method, params, cycle=0, phase='entry'):
    q = {'kind': 'rpc', 'endpoint': ep, 'method': method, 'params': params, 'cycle': cycle, 'phase': phase, 'maxRows': OBJECTS[method]}
    validate_job(q)
    return q

def validate_job(q):
    if set(q) != {'kind', 'endpoint', 'method', 'params', 'cycle', 'phase', 'maxRows'} or q['kind'] != 'rpc' or type(q['endpoint']) is not int or (q['endpoint'] not in (0, 1)):
        raise ValueError('Gas job/endpoint')
    m, p = (q['method'], q['params'])
    c = q['cycle']
    phase = q['phase']
    if m not in CAPS or q['maxRows'] != OBJECTS[m] or type(c) is not int or (not 0 <= c <= 3):
        raise ValueError('Gas method/cycle')
    if m == 'eth_chainId':
        ok = c == 0 and phase == 'entry' and (p == [])
    elif m == 'eth_getBlockByNumber':
        ok = c > 0 and isinstance(p, list) and (len(p) == 2) and (p[1] is False) and (phase == 'head' and p[0] == 'latest' or (phase in ('open', 'close') and quantity(p[0]) > 27720851))
    elif m in ('eth_gasPrice', 'eth_maxPriorityFeePerGas'):
        ok = c > 0 and phase == 'sample' and (p == [])
    elif m == 'eth_feeHistory':
        ok = c == 1 and phase == 'history' and (len(p) == 3) and (p[0] == '0x10') and (quantity(p[1]) > 27720851) and (p[2] == [10, 50, 90])
    else:
        ok = c > 0 and phase == 'witness' and isinstance(p, list) and (len(p) == 1) and bool(hash32(p[0]))
    if not ok:
        raise ValueError('Gas exact request shape')
    return ('POST', ENDPOINTS[q['endpoint']], encode({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}))

def capacity(q):
    return CAPS[q['method']]

def objects(v):
    if isinstance(v, dict):
        return 1 + sum((objects(x) for x in v.values()))
    if isinstance(v, list):
        return 1 + sum((objects(x) for x in v))
    return 0

def header(v):
    if not isinstance(v, dict):
        raise ValueError('Missing header')
    out = {k: quantity(v[k]) for k in ('number', 'timestamp')}
    if out['number'] > 2 ** 53 - 1 or out['timestamp'] > 2 ** 53 - 1:
        raise ValueError('Header range')
    out.update({k: hash32(v[k]) for k in ('hash', 'parentHash')})
    for k in ('baseFeePerGas', 'gasUsed', 'gasLimit'):
        out[k] = None if v.get(k) is None else str(quantity(v[k]))
    tx = v.get('transactions')
    if not isinstance(tx, list) or len(tx) > 16384:
        raise ValueError('Header transaction hashes')
    out['transactions'] = [hash32(t) for t in tx]
    if len(set(out['transactions'])) != len(tx):
        raise ValueError('Duplicate transaction')
    return out

def compare_headers(a, b):
    for k in ('number', 'hash', 'parentHash', 'timestamp'):
        if a[k] != b[k]:
            raise ValueError('Header identity drift: ' + k)
    for k in ('baseFeePerGas', 'gasUsed', 'gasLimit'):
        if a[k] is not None and b[k] is not None and (a[k] != b[k]):
            raise ValueError('Header component drift: ' + k)

def compare_closing_header(opening, closing):
    compare_headers(opening, closing)
    if opening['transactions'] != closing['transactions']:
        raise ValueError('Closing transaction-list drift')

def history(v, end):
    if not isinstance(v, dict):
        raise ValueError('Missing fee history')
    oldest = quantity(v['oldestBlock'])
    ratios = v['gasUsedRatio']
    base = v['baseFeePerGas']
    reward = v.get('reward')
    if not isinstance(ratios, list) or not 1 <= len(ratios) <= 16:
        raise ValueError('Fee history range')
    n = len(ratios)
    if oldest + n - 1 != end:
        raise ValueError('Fee history ending block')
    if not isinstance(base, list) or len(base) != n + 1:
        raise ValueError('Fee history n+1 base fee')
    if any((type(r) not in (float, int) or not 0 <= r <= 1 for r in ratios)):
        raise ValueError('Gas use ratios')
    bases = [str(quantity(x)) for x in base]
    if not isinstance(reward, list) or len(reward) != n:
        raise ValueError('Reward range')
    rewards = []
    for row in reward:
        if not isinstance(row, list) or len(row) != 3:
            raise ValueError('Reward percentiles')
        values = [quantity(x) for x in row]
        if values != sorted(values):
            raise ValueError('Reward order')
        rewards.append([str(x) for x in values])
    return {'oldestBlock': oldest, 'minedBlocks': n, 'minedBaseFees': bases[:-1], 'predictedNextBaseFee': bases[-1], 'gasUsedRatio': ratios, 'reward': rewards}

def transaction(v, receipt=False):
    if v is None:
        return {'available': False, 'reason': 'null mined witness'}
    if not isinstance(v, dict):
        raise ValueError('Transaction object')
    out = {'available': True, 'transactionHash': hash32(v['transactionHash'] if receipt else v['hash']), 'blockHash': hash32(v['blockHash']), 'blockNumber': quantity(v['blockNumber']), 'transactionIndex': quantity(v['transactionIndex'])}
    if receipt:
        for k in ('effectiveGasPrice', 'gasUsed'):
            out[k] = None if v.get(k) is None else str(quantity(v[k]))
    return out

def validate_rpc(q, p):
    if not isinstance(p, dict) or p.get('jsonrpc') != '2.0' or type(p.get('id')) is not int or (p['id'] != 1):
        raise ValueError('RPC envelope/ID')
    m = q['method']
    if set(p) == {'jsonrpc', 'id', 'error'}:
        e = p['error']
        if not isinstance(e, dict) or set(e) - {'code', 'message', 'data'} or type(e.get('code')) is not int or (not isinstance(e.get('message'), str)):
            raise ValueError('RPC error envelope')
        if e['code'] in (401, 402, 403, 429, -32005) or re.search(r'permission denied|access denied|forbidden|unauthori[sz]ed|authenticat|payment|api.?key|rate.?limit|too many requests|quota', e['message'], re.I):
            raise ValueError('RPC access/quota/payment restriction')
        if m not in OPTIONAL:
            raise ValueError('Mandatory RPC error: ' + str(e))
        return {'capability': 'unsupported' if e['code'] in (-32601, -32004) else 'rejected', 'error': e}
    if set(p) != {'jsonrpc', 'id', 'result'}:
        raise ValueError('Mixed/invalid RPC envelope')
    v = p['result']
    try:
        if m == 'eth_chainId':
            if quantity(v) != 369:
                raise ValueError('Chain identity drift')
            return 369
        if m == 'eth_getBlockByNumber':
            h = header(v)
            if q['params'][0] != 'latest' and h['number'] != quantity(q['params'][0]):
                raise ValueError('Exact header number drift')
            return h
        if m in ('eth_gasPrice', 'eth_maxPriorityFeePerGas'):
            return str(quantity(v))
        if m == 'eth_feeHistory':
            return history(v, quantity(q['params'][1]))
        return transaction(v, m == 'eth_getTransactionReceipt')
    except (ValueError, KeyError, TypeError, OverflowError) as e:
        if m not in OPTIONAL:
            raise
        return {'capability': 'rejected', 'reason': str(e)}

def included(v):
    return isinstance(v, str)

def gas_reading(primary, tip, context, quote_start, tip_start):
    primary_time = instant(quote_start)
    times = [primary_time]
    base = None
    priority = None
    block_time = datetime.fromtimestamp(context['timestamp'], timezone.utc)
    if context['baseFeePerGas'] is not None and block_time.date() == primary_time.date():
        base = context['baseFeePerGas']
        times.append(block_time)
    if included(tip) and instant(tip_start).date() == primary_time.date():
        priority = tip
        times.append(instant(tip_start))
    return {'kind': 'gas', 'chainId': 369, 'unit': 'wei/gas', 'gasPriceWei': primary, 'baseFeeWei': base, 'priorityFeeWei': priority, 'observedAtUtc': min(times).isoformat().replace('+00:00', 'Z')}

def denomination_witness():
    base = 1218766717339364
    used = 443488
    cost = 540508413939399861632
    if base * used != cost:
        raise ValueError('Saved denomination witness arithmetic')
    return {'status': 'ARITHMETIC_VERIFIED_SAVED_DISPLAY', 'impulsesPerBeat': '1000000000', 'impulsesPerPLS': '1000000000000000000', 'baseFeeRaw': str(base), 'gasUsed': str(used), 'executionCostRaw': str(cost), 'independentOnChainProof': False}
