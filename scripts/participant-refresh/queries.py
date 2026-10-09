"""Saved deployed HEX fields; exact bounded hash-pinned incremental queries."""
import json, re
from pathlib import Path
SCHEMAS = json.loads(Path(__file__).with_name('schema.json').read_bytes())
FAMILIES = ('tokenHolders', 'stakeStarts', 'stakeEnds', 'stakeGoodAccountings')
CHILDREN = {'stakeEnd': 'stakeEnds', 'stakeGoodAccounting': 'stakeGoodAccountings'}
GRAPH = 'https://graph.pulsechain.com/subgraphs/name/pulsechain/hex'
RPC = ['https://rpc.pulsechain.com/', 'https://rpc-pulsechain.g4mm4.io/']
DEPLOYMENT = 'QmSsv8uvNLbfJCQARk7xd9iNouNmaoqZCrqEwRaFCHJMCw'
ID = re.compile('[A-Za-z0-9_.:-]{1,256}')
INTEGER = re.compile('-?(?:0|[1-9][0-9]*)')
DECIMAL = re.compile('-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?')

def plan_valid(p):
    if p['graphqlEndpoint'] != GRAPH or p['rpcEndpoints'] != RPC or p['deployment'] != DEPLOYMENT:
        raise ValueError('Source allowlist')
    end = p['base']['number']
    if not 1 <= len(p['windows']) <= 7:
        raise ValueError('Window count')
    for w in p['windows']:
        if w['fromInclusive'] != end or not 1 <= w['targetNumber'] - end <= 4096 or w['newBlockSpan'] != w['targetNumber'] - end:
            raise ValueError('Consecutive window plan')
        end = w['targetNumber']
    if end != p['finalTarget']['number']:
        raise ValueError('Final target plan')

def selection(family):
    return ' '.join((f['name'] + ' { ' + selection(CHILDREN[f['name']]) + ' }' if f['name'] in CHILDREN else f['name'] for f in SCHEMAS[family]['fields']))

def pin_valid(pin):
    if not isinstance(pin, dict) or set(pin) != {'number', 'hash', 'timestamp'} or type(pin['number']) is not int or (type(pin['timestamp']) is not int):
        raise ValueError('Pin shape')
    if pin['number'] < 27724947 or pin['timestamp'] < 1791257475 or (not re.fullmatch('0x[0-9a-f]{64}', pin['hash'])) or (pin['hash'] == '0x' + '0' * 64):
        raise ValueError('Pin identity')

def make_job(plan, window, kind, phase='data', pin=None, family=None, first=100, cursor=None, ids=None, endpoint=0, method=None, number=None):
    q = dict(window=window, kind=kind, phase=phase, pin=pin, family=family, first=first, cursor=cursor, ids=ids, endpoint=endpoint, method=method, number=number)
    if kind == 'rpc':
        q['maxRows'] = 4 if method == 'eth_chainId' else 4096
    elif kind == 'meta':
        q['maxRows'] = 4
    else:
        q['maxRows'] = (3 if family == 'stakeStarts' else 1) * first + 4
    q['query'] = compile_query(q, plan) if kind != 'rpc' else None
    validate_job(q, plan)
    return q

def compile_query(q, p):
    pin = q['pin']
    pin_valid(pin)
    w = p['windows'][q['window'] - 1]
    if pin['number'] not in (w['fromInclusive'], w['targetNumber']):
        raise ValueError('Unapproved window pin')
    if pin['number'] == p['base']['number'] and pin != p['base'] or (pin['number'] == p['finalTarget']['number'] and pin != p['finalTarget']):
        raise ValueError('Saved pin drift')
    b = '{hash: ' + json.dumps(pin['hash']) + '}'
    meta = '_meta(block: ' + b + ') { deployment hasIndexingErrors block { number hash timestamp } }'
    k = q['kind']
    f = q['family']
    ids = q['ids']
    cursor = q['cursor']
    n = q['first']
    if k == 'meta':
        if f is not None or ids is not None or cursor is not None:
            raise ValueError('Metadata extras')
        return 'query { ' + meta + ' }'
    if f not in FAMILIES:
        raise ValueError('Family')
    if k == 'changes':
        if pin['number'] != w['targetNumber'] or n not in (100, 500) or ids is not None or (cursor is not None and (not ID.fullmatch(cursor))):
            raise ValueError('Changed query')
        where = '_change_block: {number_gte: ' + str(w['fromInclusive']) + '}'
        if cursor is not None:
            where += ', id_gt: ' + json.dumps(cursor)
    elif k in ('parents', 'witness'):
        if cursor is not None or not isinstance(ids, list) or ids != sorted(set(ids)) or (not 1 <= len(ids) <= (50 if k == 'parents' else 32)) or (n != len(ids)):
            raise ValueError('Exact ID batch size')
        if k == 'parents':
            if f != 'stakeStarts' or pin['number'] != w['targetNumber'] or any((not isinstance(i, str) or not re.fullmatch('[0-9]{1,180}', i) for i in ids)):
                raise ValueError('Parent query')
            field = 'stakeId_in'
        else:
            if f not in ('tokenHolders', 'stakeStarts') or any((not isinstance(i, str) or not ID.fullmatch(i) for i in ids)):
                raise ValueError('Witness query')
            field = 'id_in'
        where = field + ': ' + json.dumps(ids)
    else:
        raise ValueError('Query kind')
    return 'query { ' + meta + ' ' + f + '(first: ' + str(n) + ', orderBy: id, orderDirection: asc, block: ' + b + ', where: {' + where + '}) { ' + selection(f) + ' } }'

def validate_job(q, p):
    expected = {'window', 'kind', 'phase', 'pin', 'family', 'first', 'cursor', 'ids', 'endpoint', 'method', 'number', 'maxRows', 'query'}
    if not isinstance(q, dict) or set(q) != expected or type(q['window']) is not int or (not 1 <= q['window'] <= len(p['windows'])) or (q['phase'] not in ('opening', 'data', 'control')):
        raise ValueError('Job shape/phase')
    if q['kind'] == 'rpc':
        if q['endpoint'] not in (0, 1) or q['method'] not in ('eth_chainId', 'eth_getBlockByNumber') or q['pin'] is not None or (q['family'] is not None) or (q['cursor'] is not None) or (q['ids'] is not None) or (q['query'] is not None) or (q['maxRows'] != (4 if q['method'] == 'eth_chainId' else 4096)):
            raise ValueError('RPC scope')
        w = p['windows'][q['window'] - 1]
        if q['method'] == 'eth_chainId':
            if q['window'] != 1 or q['phase'] != 'opening' or q['number'] is not None:
                raise ValueError('Chain schedule')
            params = []
        else:
            if type(q['number']) is not int or q['number'] not in (w['targetNumber'], p['base']['number'] if q['window'] == 1 else w['targetNumber']):
                raise ValueError('Header schedule')
            params = [hex(q['number']), False]
        return ('POST', RPC[q['endpoint']], json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': q['method'], 'params': params}, separators=(',', ':')).encode())
    if q['endpoint'] != 0 or q['method'] is not None or q['number'] is not None:
        raise ValueError('Graph endpoint/extras')
    expected_rows = 4 if q['kind'] == 'meta' else (3 if q['family'] == 'stakeStarts' else 1) * q['first'] + 4
    if type(q['maxRows']) is not int or q['maxRows'] != expected_rows or q['query'] != compile_query(q, p):
        raise ValueError('Query/capacity binding')
    return ('POST', GRAPH, json.dumps({'query': q['query']}, separators=(',', ':')).encode())

def capacity(q):
    if q['kind'] == 'rpc':
        return 16384 if q['method'] == 'eth_chainId' else 262144
    if q['kind'] == 'meta':
        return 32768
    if q['kind'] == 'parents':
        return 524288
    if q['kind'] == 'witness':
        return 1048576
    return 524288 if q['family'] == 'tokenHolders' else 2097152

def objects(value):

    def walk(v, all_objects=False):
        if isinstance(v, dict):
            return int(all_objects or 'id' in v) + sum((walk(x, all_objects) for x in v.values()))
        if isinstance(v, list):
            return sum((walk(x, all_objects) for x in v))
        return 0
    if isinstance(value, dict) and 'jsonrpc' in value:
        return walk(value, True)
    return walk(value.get('data') if isinstance(value, dict) else value)

def validate_object(family, row):
    fields = SCHEMAS[family]['fields']
    if not isinstance(row, dict) or set(row) != {f['name'] for f in fields}:
        raise ValueError('Missing/extra source fields')
    for f in fields:
        k = f['name']
        v = row[k]
        if k in CHILDREN:
            if v is not None:
                validate_object(CHILDREN[k], v)
            continue
        t = f['type']['ofType']['name']
        if t == 'Boolean':
            if type(v) is not bool:
                raise ValueError('Source boolean')
        elif not isinstance(v, str):
            raise ValueError('Original token must be string')
        elif t in ('BigInt', 'BigDecimal'):
            if len(v) > 180 or not (INTEGER if t == 'BigInt' else DECIMAL).fullmatch(v):
                raise ValueError('Source decimal')
        elif t == 'ID':
            if not ID.fullmatch(v):
                raise ValueError('Source ID')
        elif t == 'Bytes':
            if not re.fullmatch('0x[0-9a-fA-F]{' + ('64' if k == 'transactionHash' else '40') + '}', v):
                raise ValueError('Source bytes')
        else:
            raise ValueError('Unreviewed field type')

def validate_data(q, data):
    if not isinstance(data, dict) or set(data) != ({'_meta'} if q['kind'] == 'meta' else {'_meta', q['family']}):
        raise ValueError('Graph roots')
    m = data['_meta']
    pin = q['pin']
    if not isinstance(m, dict) or set(m) != {'deployment', 'hasIndexingErrors', 'block'} or m['deployment'] != DEPLOYMENT or (m['hasIndexingErrors'] is not False):
        raise ValueError('Graph deployment/indexing')
    b = m['block']
    if not isinstance(b, dict) or set(b) != {'number', 'hash', 'timestamp'} or type(b['number']) is not int or (b['number'] != pin['number']) or (b['hash'] != pin['hash']) or (b['timestamp'] is not None and (type(b['timestamp']) is not int or b['timestamp'] != pin['timestamp'])):
        raise ValueError('Graph hash pin')
    if q['kind'] == 'meta':
        return []
    rows = data[q['family']]
    if not isinstance(rows, list) or len(rows) > q['first']:
        raise ValueError('Page bound')
    previous = q['cursor']
    for row in rows:
        validate_object(q['family'], row)
        if previous is not None and row['id'] <= previous:
            raise ValueError('Lexical pagination')
        previous = row['id']
        if q['kind'] == 'parents' and row['stakeId'] not in q['ids'] or (q['kind'] == 'witness' and row['id'] not in q['ids']):
            raise ValueError('Unrequested entity')
    return rows

def quantity(v):
    if not isinstance(v, str) or not re.fullmatch('0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})', v):
        raise ValueError('RPC quantity')
    return int(v, 16)

def validate_rpc(q, parsed):
    if not isinstance(parsed, dict) or set(parsed) != {'jsonrpc', 'id', 'result'} or parsed['jsonrpc'] != '2.0' or (type(parsed['id']) is not int) or (parsed['id'] != 1):
        raise ValueError('RPC envelope/error')
    if q['method'] == 'eth_chainId':
        if quantity(parsed['result']) != 369:
            raise ValueError('Chain identity')
        return 369
    v = parsed['result']
    if not isinstance(v, dict):
        raise ValueError('Null header')
    result = {k: quantity(v[k]) if k in ('number', 'timestamp') else v[k] for k in ('number', 'hash', 'timestamp', 'parentHash')}
    pin_valid({k: result[k] for k in ('number', 'hash', 'timestamp')})
    if result['number'] != q['number'] or not re.fullmatch('0x[0-9a-f]{64}', result['parentHash']):
        raise ValueError('Header identity')
    return result
