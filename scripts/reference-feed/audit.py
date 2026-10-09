"""Saved-capture audit: original bytes, accounting, exact schedule, paired ABI controls."""
from pathlib import Path
from durable import strict_json, digest, encode
from http_framing import verify_framing
from protocol import validate_job, validate_rpc, capacity, objects, compare_headers, instant, call, kind, FEEDS, reading, compare_round

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
                if not isinstance(parsed, dict):
                    raise ValueError('Response object required')
                count = objects(parsed)
            except (ValueError, UnicodeError, RecursionError):
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
        cutoff = 1080
        if start >= cutoff or cap['durationSeconds'] > 30.1 or start + cap['durationSeconds'] > 1140.1:
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
    if len(ledger) > 80 or max(eps) > 40 or extras > 8 or (charges > 12 * 1024 ** 2) or (entities > 20000):
        raise ValueError('Session cap')
    for k, v in {'chargedBytes': charges, 'chargedEntities': entities, 'observedBytes': observed, 'returnedEntities': returned, 'extraAttempts': extras, 'rpcEndpointAttempts': eps, 'rpcEndpointExtraAttempts': ep_extras, 'unknownEntityReservations': unknown}.items():
        if state[k] != v:
            raise ValueError('Accounting mismatch ' + k)
    for k, v in {'rpcAttempts': len(ledger), 'rpcChargedBytes': charges, 'graphAttempts': 0, 'graphChargedBytes': 0, 'docsAttempts': 0, 'docsChargedBytes': 0, 'graphEndpointAttempts': [0, 0], 'schemaAttempts': [0, 0]}.items():
        if state[k] != v:
            raise ValueError('RPC-only accounting mismatch ' + k)
    return (captures, {'attempts': len(ledger), 'chargedBytes': charges, 'chargedObjects': entities, 'extras': extras, 'perEndpoint': eps})

def qualify(sample, captures):
    cycle, calls, used, expected = sample['cycle'], sample['calls'], set(), []
    def take(key, method, phase, ep, params=None):
        expected.append(key)
        n = calls[key]
        if n in used:
            raise ValueError('Double used capture')
        used.add(n)
        cap, v = captures[n]
        q = cap['job']
        if not cap['usable'] or (q['method'], q['phase'], q['endpoint'], q['cycle']) != (method, phase, ep, cycle) or params is not None and q['params'] != params:
            raise ValueError('Exact capture role/numbered arguments')
        return v
    heads = [take('head'+str(ep), 'eth_getBlockByNumber', 'head', ep, ['latest', False]) for ep in (0, 1)]
    number = min(h['number'] for h in heads) - 2
    opens = [take('open'+str(ep), 'eth_getBlockByNumber', 'open', ep, [hex(number), False]) for ep in (0, 1)]
    compare_headers(*opens)
    pin = opens[0]
    if sample['selectedBlock'] != number:
        raise ValueError('Selected numeric pin')
    identities, rounds = {}, {}
    for asset, proxy in FEEDS.items():
        codes = [take(asset+'-code'+str(ep), 'eth_getCode', 'code', ep, [proxy, hex(number)]) for ep in (0, 1)]
        if codes[0] != codes[1]:
            raise ValueError('Paired proxy runtime code')
        identity = {'proxy': proxy, 'code': codes[0]}
        for method in ('decimals', 'description', 'aggregator', 'round'):
            values = [take(asset+'-'+method+str(ep), 'eth_call', method, ep, call(asset, method, number)) for ep in (0, 1)]
            if values[0] != values[1]:
                raise ValueError('Paired proxy '+method+' disagreement')
            if method == 'round': rounds[asset] = values[0]
            else: identity[method] = values[0]
        identities[asset] = identity
    for asset in FEEDS:
        for ep in (0, 1):
            if take(asset+'-close-round'+str(ep), 'eth_call', 'close-round', ep, call(asset, 'round', number)) != rounds[asset]:
                raise ValueError('Closing tuple drift')
    for ep in (0, 1):
        compare_headers(pin, take('close'+str(ep), 'eth_getBlockByNumber', 'close', ep, [hex(number), False]))
    if len(calls) != 30 or used != set(calls.values()) or sorted(calls, key=calls.get) != expected:
        raise ValueError('Exact 30-request cycle schedule')
    successful = {n for n, (cap, v) in captures.items() if cap['job']['cycle'] == cycle and cap['usable']}
    if used != successful:
        raise ValueError('Unused successful cycle calls')
    logical = [cap['originalAttempt'] for cap, v in captures.values() if cap['job']['cycle'] == cycle and not cap['retryIndex']]
    if logical != [captures[calls[k]][0]['originalAttempt'] for k in expected]:
        raise ValueError('Unexpected logical cycle call')
    now = instant(sample['sealedAt']).timestamp()
    if now < instant(captures[max(used)][0]['finishedAt']).timestamp() or not 0 <= now - pin['timestamp'] <= 600:
        raise ValueError('Seal/context time')
    readings = [reading(asset, rounds[asset], pin, now) for asset in FEEDS]
    return {'readings': readings, 'liquidityHistory': [], 'receiptSha256': digest(encode(sample))}, {'pin': pin, 'identities': identities, 'rounds': rounds, 'readings': readings, 'pinning': 'explicit numeric B with paired opening/closing headers; not hash-parameter execution', 'sameRound': None}

def audit_round(root, sample, state):
    root = Path(root)
    captures, accounting = audit_captures(root, state)
    entries = [(cap, v) for cap, v in captures.values() if cap['job']['phase'] == 'entry' and cap['usable']]
    if len(entries) != 2 or [cap['job']['endpoint'] for cap, v in entries if v == 1] != [0, 1] or any(cap['job']['cycle'] > 0 for cap, v in list(captures.values())[:entries[-1][0]['attempt']]):
        raise ValueError('Both chain identities before cycles')
    c = sample['cycle']
    if type(c) is not int or not 1 <= c <= 2:
        raise ValueError('Cycle ordinal')
    previous = None
    previous_close = entries[-1][0]['attempt']
    last_start = None
    for ordinal in range(1, c + 1):
        current = sample if ordinal == c else strict_json((root / f'ROUND_{ordinal}_SAMPLE.json').read_bytes())
        update, details = qualify(current, captures)
        binding = strict_json((root / f'CYCLE_{ordinal}_BINDING.json').read_bytes())
        start = binding['cycleStartOffsetSeconds']
        first = min(captures[n][0]['startOffsetSeconds'] for n in current['calls'].values())
        if binding['number'] != details['pin']['number'] or not 0 <= start <= first or start >= 900 or last_start is not None and start + .001 < last_start + 60:
            raise ValueError('Cycle binding/start/cutoff')
        if min(captures[n][0]['originalAttempt'] for n in current['calls'].values()) <= previous_close:
            raise ValueError('Prior closure before new cycle')
        if previous:
            if details['pin']['number'] <= previous['pin']['number'] or details['identities'] != previous['identities']:
                raise ValueError('Second pin/identity drift')
            details['sameRound'] = {asset: compare_round(previous['rounds'][asset], details['rounds'][asset]) for asset in FEEDS}
        last_start, previous_close, previous = start, max(current['calls'].values()), details
    return {'status': 'PASS', 'kind': 'BTC_ETH_REFERENCE_AUDIT', 'capturePromotable': True, 'cycle': c, 'sampleSha256': digest(encode(sample)), 'accounting': accounting, 'details': details}, update
