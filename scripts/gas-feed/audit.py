"""Rebuild each gas update from saved framed responses, not a claimed market audit."""
import json
from pathlib import Path
from durable import strict_json, digest, encode
from http_framing import verify_framing
from protocol import validate_job, validate_rpc, capacity, objects, compare_headers, compare_closing_header, gas_reading, instant

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
            key = (q['cycle'], q['endpoint'], q['method'], q['phase'])
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
        access = cap.get('status') in (401, 402, 403, 429) or any(w in raw.lower() for w in (b'payment required', b'authentication required', b'unauthorized', b'api key required'))
        veto = access or cap.get('validationError') or cap.get('parseError') or cap.get('failureKind') in ('body_cap', 'owner_cancellation', 'local_or_protocol', 'transport_terminal', 'unknown_closure', 'attempt_deadline')
        retryable = bool(not cap['usable'] and not veto and (cap.get('failureKind') == 'transport_timeout' or cap['complete'] and cap.get('status') in (502, 503, 504)))
        if bool(cap['retryable']) != retryable:
            raise ValueError('Retry classification drift')
        start = cap['startOffsetSeconds']
        cutoff = 1140 if q['phase'] == 'close' else 1080
        if start >= cutoff or cap['durationSeconds'] > 15.1 or start + cap['durationSeconds'] > 1140.1:
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
    if len(ledger) > 48 or max(eps) > 24 or extras > 8 or (max(ep_extras) > 4) or (charges > 16 * 1024 ** 2) or (entities > 50000):
        raise ValueError('Session cap')
    for k, v in {'chargedBytes': charges, 'chargedEntities': entities, 'observedBytes': observed, 'returnedEntities': returned, 'extraAttempts': extras, 'rpcEndpointAttempts': eps, 'rpcEndpointExtraAttempts': ep_extras, 'unknownEntityReservations': unknown}.items():
        if state[k] != v:
            raise ValueError('Accounting mismatch ' + k)
    return (captures, {'attempts': len(ledger), 'chargedBytes': charges, 'chargedObjects': entities, 'extras': extras, 'perEndpoint': eps})

def qualify(sample, captures):
    cycle = sample['cycle']
    calls = sample['calls']
    used = set()

    def value(key, m, phase, ep):
        n = calls[key]
        if n in used:
            raise ValueError('Double-used sample call')
        used.add(n)
        cap, v = captures[n]
        q = cap['job']
        if not cap['usable'] or (q['method'], q['phase'], q['endpoint'], q['cycle']) != (m, phase, ep, cycle):
            raise ValueError('Sample request role')
        return (cap, v)
    heads = [value('head' + str(ep), 'eth_getBlockByNumber', 'head', ep)[1] for ep in (0, 1)]
    number = min((h['number'] for h in heads)) - 2
    if number <= 27720851:
        raise ValueError('Context before seed')
    opens = [value('open' + str(ep), 'eth_getBlockByNumber', 'open', ep)[1] for ep in (0, 1)]
    compare_headers(*opens)
    if opens[0]['number'] != number:
        raise ValueError('Selected context')
    for ep in (0, 1):
        c, h = value('close' + str(ep), 'eth_getBlockByNumber', 'close', ep)
        compare_closing_header(opens[ep], h)
    prices = [value('gas' + str(ep), 'eth_gasPrice', 'sample', ep) for ep in (0, 1)]
    quote_time = prices[0][0]['startedAt']
    age = instant(quote_time).timestamp() - opens[0]['timestamp']
    if not 0 <= age <= 300:
        raise ValueError('Nonfuture timely context')
    tips = []
    for ep in (0, 1):
        key = 'tip' + str(ep)
        tips.append(value(key, 'eth_maxPriorityFeePerGas', 'sample', ep) if key in calls else (None, {'capability': 'skipped_unsupported'}))
    histories = []
    for ep in (0, 1):
        key = 'history' + str(ep)
        if key in calls:
            if cycle != 1:
                raise ValueError('History outside first cycle')
            h = value(key, 'eth_feeHistory', 'history', ep)[1]
            histories.append(h)
            if 'minedBaseFees' in h and opens[ep]['baseFeePerGas'] is not None and (h['minedBaseFees'][-1] != opens[ep]['baseFeePerGas']):
                raise ValueError('History/context base fee mismatch')
    if len(histories) == 2 and all(('minedBaseFees' in h for h in histories)):
        a, b = histories
        for n in range(max(a['oldestBlock'], b['oldestBlock']), number + 1):
            if a['minedBaseFees'][n - a['oldestBlock']] != b['minedBaseFees'][n - b['oldestBlock']]:
                raise ValueError('Overlapping mined history mismatch')
    witnesses = []
    for ep in (0, 1):
        row = {}
        for kind, m in [('transaction', 'eth_getTransactionByHash'), ('receipt', 'eth_getTransactionReceipt')]:
            key = kind + str(ep)
            if key in calls:
                cap, v = value(key, m, 'witness', ep)
                row[kind] = v
                if v.get('available'):
                    shared = next((t for t in opens[0]['transactions'] if t in set(opens[1]['transactions'])), None)
                    if v['transactionHash'] != shared or cap['job']['params'] != [shared] or v['blockHash'] != opens[0]['hash'] or (v['blockNumber'] != number) or (v['transactionIndex'] != opens[ep]['transactions'].index(shared)):
                        raise ValueError('Mined witness identity drift')
        if row:
            witnesses.append(row)
    if len(witnesses) == 2:
        for kind in ('transaction', 'receipt'):
            a, b = (w.get(kind, {}) for w in witnesses)
            if a.get('available') and b.get('available'):
                for field in ('transactionHash', 'blockHash', 'blockNumber', 'transactionIndex'):
                    if a[field] != b[field]:
                        raise ValueError('Paired mined witness identity mismatch')
                for field in ('gasUsed', 'effectiveGasPrice'):
                    if a.get(field) is not None and b.get(field) is not None and a[field] != b[field]:
                        raise ValueError('Paired mined witness execution mismatch')
    if used != set(calls.values()):
        raise ValueError('Unrecognized sample call')
    tip = tips[0][1]
    tip_start = tips[0][0]['startedAt'] if tips[0][0] else None
    reading = gas_reading(prices[0][1], tip, opens[0], quote_time, tip_start)
    runtime = []
    for w in witnesses:
        r = w.get('receipt', {})
        if r.get('available') and r.get('gasUsed') is not None and (r.get('effectiveGasPrice') is not None):
            runtime.append({'gasUsed': r['gasUsed'], 'effectiveGasPrice': r['effectiveGasPrice'], 'executionGasCostRaw': str(int(r['gasUsed']) * int(r['effectiveGasPrice'])), 'includesSeparateBlobOrOtherFees': False})
    details = {'context': opens[0], 'primaryQuoteInterval': [prices[0][0]['startedAt'], prices[0][0]['finishedAt']], 'secondaryQuoteInterval': [prices[1][0]['startedAt'], prices[1][0]['finishedAt']], 'primarySuggestion': prices[0][1], 'secondarySuggestion': prices[1][1], 'prioritySuggestions': [t[1] for t in tips], 'primaryTipInterval': None if not tips[0][0] else [tips[0][0]['startedAt'], tips[0][0]['finishedAt']], 'feeHistory': histories, 'witnesses': witnesses, 'executionCostExamples': runtime, 'groupedTime': reading['observedAtUtc'], 'suggestionsUnpinned': True, 'noSuggestionEqualityOrBasePlusTipRequirement': True, 'unitDisplay': 'PulseChain raw smallest units/gas; *Wei is an EVM API alias'}
    return ({'readings': [reading], 'liquidityHistory': [], 'receiptSha256': digest(encode(sample))}, details)

def audit_round(root, sample, state):
    captures, accounting = audit_captures(root, state)
    entries = [(cap, v) for cap, v in captures.values() if cap['job']['phase'] == 'entry' and cap['usable']]
    if {cap['job']['endpoint'] for cap, v in entries if v == 369} != {0, 1}:
        raise ValueError('Both chain identities required')
    c = sample['cycle']
    if type(c) is not int or not 1 <= c <= 3:
        raise ValueError('Finite cycle ordinal')
    prior_number = 27720851
    prior_start = None
    for ordinal in range(1, c + 1):
        first = [cap for cap, v in captures.values() if cap['job']['cycle'] == ordinal and cap['job']['phase'] == 'head' and cap['retryIndex'] == 0]
        opening = [v for cap, v in captures.values() if cap['job']['cycle'] == ordinal and cap['job']['phase'] == 'open' and cap['usable']]
        if len(first) != 2 or len(opening) != 2 or opening[0]['number'] <= prior_number:
            raise ValueError('Cycle continuity/strict context advance')
        binding = strict_json((Path(root) / f'CYCLE_{ordinal}_BINDING.json').read_bytes())
        start = binding['cycleStartOffsetSeconds']
        if binding['number'] != opening[0]['number'] or start < 0 or start > min(cap['startOffsetSeconds'] for cap in first):
            raise ValueError('Cycle start/block binding')
        if prior_start is not None and start + 0.001 < prior_start + 60:
            raise ValueError('Cycle minimum start spacing')
        prior_start = start
        prior_number = opening[0]['number']
    expected = {prefix + str(ep) for prefix in ('head', 'open', 'gas', 'close') for ep in (0, 1)}
    for ep in (0, 1):
        unsupported = any((cap['job']['method'] == 'eth_maxPriorityFeePerGas' and cap['job']['endpoint'] == ep and (cap['job']['cycle'] < c) and isinstance(v, dict) and (v.get('capability') == 'unsupported') for cap, v in captures.values()))
        if not unsupported:
            expected.add('tip' + str(ep))
    if c == 1:
        expected.update(('history0', 'history1'))
    for ordinal in range(1, c + 1):
        opening = [v for cap, v in captures.values() if cap['usable'] and cap['job']['cycle'] == ordinal and (cap['job']['phase'] == 'open')]
        if len(opening) == 2 and any((h['transactions'] for h in opening)):
            shared = set(opening[0]['transactions']) & set(opening[1]['transactions'])
            if ordinal == c and shared:
                expected.update((k + str(ep) for k in ('transaction', 'receipt') for ep in (0, 1)))
            break
    if set(sample['calls']) != expected:
        raise ValueError('Exact optional/control schedule')
    update, details = qualify(sample, captures)
    return ({'status': 'PASS', 'kind': 'PULSECHAIN_GAS_AUDIT', 'capturePromotable': True, 'cycle': sample['cycle'], 'sampleSha256': digest(encode(sample)), 'accounting': accounting, 'details': details}, update)
