"""Rebuild each gas update from saved framed responses, not a claimed market audit."""
import json
from pathlib import Path
from durable import strict_json, digest, encode
from http_framing import verify_framing
from protocol import validate_job, validate_rpc, capacity, objects, compare_headers, compare_closing_header, qualify_values, instant, call, kind, BASE_TAIL

def audit_captures(root, state):
    root = Path(root)
    ledger = [strict_json(x) for x in (root / 'LEDGER.jsonl').read_bytes().splitlines()]
    if len(ledger) != state['attempts'] or state['pending'] is not None:
        raise ValueError('Unsettled capture ledger')
    captures = {}
    charges = entities = observed = returned = extras = unknown = 0
    eps = [0, 0]
    ep_extras = [0, 0]
    last = None
    logical = set()
    witness_hashes = set()
    for n, cap in enumerate(ledger, 1):
        if cap['attempt'] != n or cap != strict_json((root / f'captures/{n:05d}/capture.json').read_bytes()):
            raise ValueError('Exact capture/ledger mismatch')
        q = cap['job']
        directory = root / f'captures/{n:05d}'
        if cap['retryIndex'] == 0:
            key = (q['cycle'], q['endpoint'], q['method'], q['phase'], encode(q['params']))
            if key in logical:
                raise ValueError('Duplicate logical schedule request')
            logical.add(key)
            if q['phase'] == 'witness':
                witness_hashes.add(q['params'][0])
            if len(witness_hashes) > 1:
                raise ValueError('Multiple transaction sampling')
        method, url, body = validate_job(q)
        req = strict_json((directory / 'request.json').read_bytes())
        if req['job'] != q or req['method'] != method or req['url'] != url or (req['bodySha256'] != digest(body)) or ((directory / 'request.body').read_bytes() != body) or (cap['requestSha256'] != digest(body)):
            raise ValueError('Request binding')
        raw = (directory / 'response.body').read_bytes()
        if len(raw) > capacity(q) or cap['responseBytes'] != len(raw) or cap['responseSha256'] != digest(raw):
            raise ValueError('Body binding')
        if not cap['bodyDurable'] or not cap['closureKnown'] or (not cap['childReaped']) or (not cap['closedWithinDeadline']):
            raise ValueError('Unknown capture closure/durability')
        wire = None
        parsed = None
        value = None
        count = None
        if cap['complete']:
            framing = (directory / 'response.framing').read_bytes() if (directory / 'response.framing').exists() else None
            wire = verify_framing(cap, raw, capacity(q), framing)
            try:
                parsed = strict_json(raw)
                count = objects(parsed)
            except (ValueError, UnicodeError):
                parsed = None
            if cap['usable']:
                if cap['status'] != 200 or parsed is None:
                    raise ValueError('Unqualified usable response')
                value = validate_rpc(q, parsed)
                if value != cap['selectedHeaderResult']:
                    raise ValueError('Parsed value mismatch')
        expected_charge = wire if cap['complete'] else capacity(q)
        expected_entities = count if count is not None and cap['complete'] else q['maxRows']
        if cap['chargedBytes'] != expected_charge or cap['chargedEntities'] != expected_entities or expected_entities > q['maxRows']:
            raise ValueError('Conservative charge mismatch')
        if last and cap['startOffsetSeconds'] + 0.001 < last['startOffsetSeconds'] + last['durationSeconds'] + 1:
            raise ValueError('Serial closure pacing')
        if cap['retryIndex']:
            if not last or cap['retryIndex'] > 2 or cap['retryOf'] != last['attempt'] or (cap['originalAttempt'] != last['originalAttempt']) or (cap['retryIndex'] != last['retryIndex'] + 1) or (cap['job'] != last['job']) or (not last['retryable']):
                raise ValueError('Exact retry lineage')
            if cap['startOffsetSeconds'] + 0.001 < last['startOffsetSeconds'] + last['durationSeconds'] + [5, 15][cap['retryIndex'] - 1]:
                raise ValueError('Retry wait')
        elif cap['retry'] or cap['originalAttempt'] != n:
            raise ValueError('Retry ordinal reset')
        access = cap.get('status') in (401, 402, 403, 429) or any((w in raw.lower() for w in (b'payment required', b'authentication required', b'unauthorized', b'api key required')))
        rpc_envelope = cap['complete'] and isinstance(parsed, dict) and ('jsonrpc' in parsed or 'error' in parsed)
        veto = rpc_envelope or access or cap.get('validationError') or cap.get('parseError') or (cap.get('failureKind') in ('body_cap', 'owner_cancellation', 'local_or_protocol', 'transport_terminal', 'unknown_closure', 'attempt_deadline'))
        retryable = bool(not cap['usable'] and (not veto) and (cap.get('failureKind') in ('transport_timeout', 'network') or (cap['complete'] and cap.get('status') in (502, 503, 504))))
        if bool(cap['retryable']) != retryable:
            raise ValueError('Retry classification drift')
        start = cap['startOffsetSeconds']
        cutoff = 1710 if q['phase'] in ('close', 'close-global') else 1620
        if start >= cutoff or cap['durationSeconds'] > 20.1 or start + cap['durationSeconds'] > 1740.1:
            raise ValueError('Public time envelope')
        charges += cap['chargedBytes']
        entities += cap['chargedEntities']
        observed += len(raw)
        returned += count or 0
        if count is None:
            unknown += q['maxRows']
        extras += bool(cap['retry'])
        eps[q['endpoint']] += 1
        ep_extras[q['endpoint']] += bool(cap['retry'])
        captures[n] = (cap, value)
        last = cap
    if len(ledger) > 72 or max(eps) > 36 or extras > 12 or (max(ep_extras) > 6) or (charges > 16 * 1024 ** 2) or (entities > 20000):
        raise ValueError('Session cap')
    for k, v in {'chargedBytes': charges, 'chargedEntities': entities, 'observedBytes': observed, 'returnedEntities': returned, 'extraAttempts': extras, 'rpcEndpointAttempts': eps, 'rpcEndpointExtraAttempts': ep_extras, 'unknownEntityReservations': unknown}.items():
        if state[k] != v:
            raise ValueError('Accounting mismatch ' + k)
    return (captures, {'attempts': len(ledger), 'chargedBytes': charges, 'chargedObjects': entities, 'extras': extras, 'perEndpoint': eps})

def qualify(sample, captures, end, tail):
    cycle = sample['cycle']
    calls = sample['calls']
    used = set()

    def value(key, m, phase, ep):
        n = calls[key]
        if n in used:
            raise ValueError('Double used capture')
        used.add(n)
        cap, v = captures[n]
        q = cap['job']
        if not cap['usable'] or (q['method'], q['phase'], q['endpoint'], q['cycle']) != (m, phase, ep, cycle):
            raise ValueError('Capture role')
        return (cap, v)
    heads = [value('head' + str(ep), 'eth_getBlockByNumber', 'head', ep)[1] for ep in (0, 1)]
    number = min((h['number'] for h in heads)) - 2
    opens = [value('open' + str(ep), 'eth_getBlockByNumber', 'open', ep)[1] for ep in (0, 1)]
    compare_headers(*opens)
    pin = opens[0]
    if pin['number'] != number or sample['selectedBlock'] != number:
        raise ValueError('Selected pin')
    g = []
    supply = []
    ranges = []
    getters = {}
    if cycle == 1:
        for ep in (0, 1):
            cap, v = value('code' + str(ep), 'eth_getCode', 'code', ep)
            if int(cap['job']['params'][1], 16) != number:
                raise ValueError('Code pin')

    def getcall(key, phase, ep, k, *args):
        cap, v = value(key, 'eth_call', phase, ep)
        if cap['job']['params'] != call(k, pin['hash'], *args):
            raise ValueError('Hash-pinned exact arguments')
        return (cap, v)
    for ep in (0, 1):
        cap, v = getcall('global' + str(ep), 'global', ep, 'global')
        g.append(v)
        if not 0 <= instant(cap['startedAt']).timestamp() - pin['timestamp'] <= 300:
            raise ValueError('Timely header')
    d = int(g[0][4])
    for ep in (0, 1):
        supply.append(getcall('supply' + str(ep), 'supply', ep, 'supply')[1])
        ranges.append(getcall('range' + str(ep), 'range', ep, 'range', end - 2, d)[1])
    if d > end:
        for phase, day in [('first', end)] if d == end + 1 else [('first', end), ('last', d - 1)]:
            getters[day] = [getcall(phase + str(ep), phase, ep, 'daily', day)[1] for ep in (0, 1)]
    for ep in (0, 1):
        if getcall('close-global' + str(ep), 'close-global', ep, 'global')[1] != g[ep]:
            raise ValueError('Closing global drift')
        compare_closing_header(opens[ep], value('close' + str(ep), 'eth_getBlockByNumber', 'close', ep)[1])
    if used != set(calls.values()) or len(used) != len(calls):
        raise ValueError('Unexpected schedule')
    successful = {n for n, (cap, v) in captures.items() if cap['job']['cycle'] == cycle and cap['usable']}
    if used != successful:
        raise ValueError('Unused successful cycle calls')
    expected = [prefix + str(ep) for prefix in ('head', 'open', *(('code',) if cycle == 1 else ()), 'global', 'supply', 'range', *(('first',) if d > end else ()), *(('last',) if d > end + 1 else ()), 'close-global', 'close') for ep in (0, 1)]
    if sorted(calls, key=calls.get) != expected:
        raise ValueError('Exact physical control/data order')
    logical = [cap['originalAttempt'] for cap, v in captures.values() if cap['job']['cycle'] == cycle and (not cap['retryIndex'])]
    if logical != [captures[calls[key]][0]['originalAttempt'] for key in expected]:
        raise ValueError('Unexpected logical cycle call')
    final = captures[calls[expected[-1]]][0]
    seal = instant(sample['sealedAt'])
    if seal.tzinfo is None or seal < instant(final['finishedAt']):
        raise ValueError('Seal before final known closure')
    reading, append = qualify_values(pin, g, supply, ranges, end, tail, getters)
    return ({'readings': [reading], 'ledgerAppend': append, 'liquidityHistory': [], 'receiptSha256': digest(encode(sample))}, {'context': pin, 'ledgerFrom': end, 'ledgerEnd': d, 'appendedDays': d - end, 'globalWords': g[0], 'getterDays': sorted(getters)})

def audit_round(root, sample, state):
    root = Path(root)
    captures, accounting = audit_captures(root, state)
    entries = [(cap, v) for cap, v in captures.values() if cap['job']['phase'] == 'entry' and cap['usable']]
    if len(entries) != 2 or {cap['job']['endpoint'] for cap, v in entries if v == 369} != {0, 1}:
        raise ValueError('Both chains required exactly once')
    if [cap['job']['endpoint'] for cap, v in entries] != [0, 1]:
        raise ValueError('Entry identity order')
    end = 2498
    tail = BASE_TAIL[:]
    previous = 27720851
    last_start = None
    previous_close = max((cap['attempt'] for cap, v in entries))
    c = sample['cycle']
    if type(c) != int or not 1 <= c <= 3:
        raise ValueError('Cycle ordinal')
    for ordinal in range(1, c + 1):
        current = sample if ordinal == c else strict_json((root / f'ROUND_{ordinal}_SAMPLE.json').read_bytes())
        update, details = qualify(current, captures, end, tail)
        if min((captures[n][0]['originalAttempt'] for n in current['calls'].values())) <= previous_close:
            raise ValueError('Entry/prior cycle must close before next cycle')
        previous_close = max(current['calls'].values())
        b = strict_json((root / f'CYCLE_{ordinal}_RANGE.json').read_bytes())
        start = b['cycleStartOffsetSeconds']
        for suffix in ('BINDING', 'PIN'):
            earlier = strict_json((root / f'CYCLE_{ordinal}_{suffix}.json').read_bytes())
            if any((b.get(k) != v for k, v in earlier.items())):
                raise ValueError('Immutable phase binding drift')
        first = min((cap['startOffsetSeconds'] for cap, v in captures.values() if cap['job']['cycle'] == ordinal))
        if b['number'] != details['context']['number'] or b['hash'] != details['context']['hash'] or b['end'] != end or (b['dailyCount'] != details['ledgerEnd']) or (b['number'] <= previous) or (not 0 <= start <= first):
            raise ValueError('Cycle binding/advance')
        if last_start is not None and start + 0.001 < last_start + 60:
            raise ValueError('Cycle spacing')
        last_start = start
        previous = b['number']
        end = details['ledgerEnd']
        tail = (tail + update['ledgerAppend']['words'])[-2:]
    return ({'status': 'PASS', 'kind': 'HEX_PROTOCOL_AUDIT', 'capturePromotable': True, 'cycle': c, 'sampleSha256': digest(encode(sample)), 'accounting': accounting, 'details': details}, update)
