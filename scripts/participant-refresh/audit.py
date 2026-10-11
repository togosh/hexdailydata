"""Reconstruct completed windows from original framed bodies and physical request order."""
from pathlib import Path
from datetime import datetime
from durable import strict_json, digest, selected_digest, encode
from http_framing import verify_framing
from retry_policy import classify_error_only, CLASSIFICATIONS
from queries import validate_job, validate_data, validate_rpc, capacity, objects, make_job, FAMILIES, DEPLOYMENT
from retry_schedule import enabled, VERSION, WAITS, COUNTERS, ControlReplay, slow_eligible, requirements

def public_combined_schedule(root, plan):
    """Recognize only this admitted combined profile; historical policies stay fixed."""
    if plan.get('unifiedProfileId')!='unified-five-feed-public-qualification-2':return False
    from public_profile import ROOT,PACKET,is_public
    raw=(root/'PLAN.json').read_bytes();original=strict_json(raw)
    admission=strict_json((root/'ADMISSION.json').read_bytes())
    binding=strict_json((root/'WINDOW_1_BINDING.json').read_bytes())
    if (not plan.get('combinedJob') or not is_public(admission) or admission['family']!='participants'
        or admission['job']!='participants-1' or root.resolve()!=ROOT/'session/participants-1'
        or admission['planSha256']!=digest(raw) or admission['scopeSha256']!=PACKET['packet/SCOPE.json']
        or admission['unifiedProfileId']!=plan['unifiedProfileId']
        or {**plan,'finalTarget':original['finalTarget']}!=original
        or plan['base']!=admission['initial']['participant']['base']
        or plan['finalTarget']!=binding['target'] or plan['base']!=binding['base']
        or plan['finalTarget']['number']!=27758521 or plan['base']['number']!=27754425):
        raise ValueError('Exact combined public retry authority/plan')
    return True

def retry_maximum(q, previous, standalone, exact_public_combined):
    return 5 if (standalone or exact_public_combined) and slow_eligible(q,previous) else 2

def audit_captures(root, plan, state, window=None, terminal=False):
    root = Path(root)
    r2 = enabled(plan)
    combined = bool(plan.get('combinedJob'))
    public_slow=public_combined_schedule(root,plan)
    if combined:
        from combined import audit_reservations
        audit_reservations(root, state, capacity)
    if r2 and (state.get('retryScheduleVersion') != VERSION or state.get('retrySchedule') != plan['retry']):
        raise ValueError('Schedule identity')
    control_replay = ControlReplay()
    reference = strict_json((root / 'R1_COMPARISON.json').read_bytes()) if r2 and not combined and state['mode'] == 'OWNER_AUTHORIZED_PUBLIC' else None
    if reference is not None:
        binding = strict_json((root.parent / 'PREFLIGHT.json').read_bytes())
        if digest((root / 'R1_COMPARISON.json').read_bytes()) != binding['inputFiles'].get('R1_COMPARISON.json'):
            raise ValueError('Frozen R1 comparison identity')
    lines = (root / 'LEDGER.jsonl').read_bytes().splitlines(keepends=True)
    caps = []
    totals = {'attempts': 0, 'extraAttempts': 0, 'chargedBytes': 0, 'observedBytes': 0, 'chargedEntities': 0, 'returnedEntities': 0, 'unknownEntityReservations': 0, 'graphAttempts': 0, 'rpcAttempts': 0, 'graphChargedBytes': 0, 'rpcChargedBytes': 0, 'graphExtraAttempts': 0, 'rpcExtraAttempts': 0}
    endpoints = [0, 0]
    last = None
    extras = {}
    originals = {}
    for number, line in enumerate(lines, 1):
        cap = strict_json(line)
        q = cap['job']
        if r2 and not combined:
            controls = control_replay.before(q, cap['retry'])
            reservation = strict_json((root / 'reservations' / f'{number:05d}.json').read_bytes())
            counters = {k: (list(endpoints) if k == 'rpcEndpointAttempts' else totals[k]) for k in COUNTERS}
            if reservation['scheduleVersion'] != VERSION or reservation['attempt'] != number or reservation['query'] != q or reservation['ordinal'] != cap['retryIndex'] or reservation['controls'] != controls or reservation['countersBefore'] != counters:
                raise ValueError('Independent dispatch reservation')
            if not 0 <= reservation['offset'] <= cap['startOffsetSeconds']:
                raise ValueError('Reservation must precede dispatch')
            reserved = requirements(q, controls, cap['retryIndex'], counters, reservation['offset'])
            if reserved != reservation['reserved']:
                raise ValueError('Reservation quantities')
            requirements(q, controls, cap['retryIndex'], counters, cap['startOffsetSeconds'])
        if not 0 <= cap['startOffsetSeconds'] < 5100 or not 0 <= cap['durationSeconds'] <= 30.01 or cap['startOffsetSeconds'] + cap['durationSeconds'] > 5220:
            raise ValueError('Physical clock bound')
        if last is None or q['window'] != last['job']['window']:
            if cap['startOffsetSeconds'] >= 4200:
                raise ValueError('Window dispatch cutoff')
            if last is not None:
                if q['window'] != last['job']['window'] + 1:
                    raise ValueError('Window ordinal chain')
                ack = strict_json((root / f"WINDOW_{q['window'] - 1}_ACK.json").read_bytes())
                if ack.get('ok') is not True or ack['window'] != q['window'] - 1 or ack['recordedOffsetSeconds'] > cap['startOffsetSeconds'] or (datetime.fromisoformat(ack['recordedAt']) > datetime.fromisoformat(cap['startedAt'])):
                    raise ValueError('Prior local publication acknowledgement')
        folder = root / f'captures/{number:05d}'
        if cap != strict_json((folder / 'capture.json').read_bytes()) or cap['attempt'] != number:
            raise ValueError('Capture/ledger sequence')
        req = strict_json((folder / 'request.json').read_bytes())
        method, url, body = validate_job(q, plan)
        if req['job'] != q or req['url'] != url or req['method'] != method or (body != (folder / 'request.body').read_bytes()) or (digest(body) != cap['requestSha256']):
            raise ValueError('Exact physical request')
        if reference is not None and q['window'] == 1 and q['kind'] == 'changes' and q['family'] == 'tokenHolders' and q['phase'] == 'data' and q['cursor'] in (None, reference['lastId']):
            expected = reference['firstPageRequestSha256'] if q['cursor'] is None else reference['failedSecondPageRequestSha256']
            if digest(body) != expected:raise ValueError('R1 exact query comparison')
        raw = (folder / 'response.body').read_bytes()
        if len(raw) != cap['responseBytes'] or digest(raw) != cap['responseSha256']:
            raise ValueError('Saved body identity')
        if not cap['closureKnown'] or not cap['bodyDurable'] or (not cap['childReaped']) or (not cap['connectionClosed']):
            raise ValueError('Unknown/undurable window response')
        if last is not None and cap['startOffsetSeconds'] + 0.002 < last['startOffsetSeconds'] + last['durationSeconds'] + 1:
            raise ValueError('Serial post-closure pacing')
        frame_path = folder / 'response.framing'
        frame = frame_path.read_bytes() if frame_path.exists() else None
        if frame is not None and (len(frame) != cap['framingEvidenceBytes'] or digest(frame) != cap['framingEvidenceSha256']):
            raise ValueError('Framing identity')
        wire = verify_framing(cap, raw, capacity(q), frame) if cap['complete'] else capacity(q)
        parsed = None
        count = None
        if cap['complete']:
            try:
                parsed = strict_json(raw)
                if not isinstance(parsed,dict):raise ValueError('Response object required')
                count = objects(parsed)
            except (ValueError,UnicodeError,RecursionError):
                if not cap.get('parseError') or not terminal or number!=len(lines):raise
                parsed=None;count=None
        if count is not None and count > q['maxRows']:
            raise ValueError('Source object reservation overrun')
        charged = count if count is not None else q['maxRows']
        if cap['chargedBytes'] != wire or cap['chargedEntities'] != charged or cap['entityRows'] != count:
            raise ValueError('Conservative charge mismatch')
        kind = 'rpc' if q['kind'] == 'rpc' else 'graph'
        classification = None if kind == 'rpc' else classify_error_only(parsed, cap, 'HOLDER_R3')
        if cap['classification'] != classification:
            raise ValueError('Original retry classification')
        if cap['usable']:
            if cap['status'] != 200 or not cap['complete'] or (not cap['closedWithinDeadline']) or (not cap['identityValidated']):
                raise ValueError('Usable response gates')
            if kind == 'rpc':
                value = validate_rpc(q, parsed)
            else:
                if set(parsed) - {'data', 'extensions'}:
                    raise ValueError('Graph error/extra envelope')
                validate_data(q, parsed['data'])
                value = parsed['data']
        elif terminal and number==len(lines) and not cap['usable']:
            value=None
        else:
            if not cap['retryable']:
                raise ValueError('Unusable response in qualified window')
            if not cap['closedWithinDeadline'] or cap.get('accessRestricted') or cap.get('validationError') or cap.get('parseError') or (cap.get('failureKind') in ('body_cap', 'owner_cancellation', 'local_or_protocol', 'transport_terminal', 'unknown_closure', 'attempt_deadline')):
                raise ValueError('Retry veto guard')
            if isinstance(parsed, dict) and parsed.get('errors') and (classification not in CLASSIFICATIONS):
                raise ValueError('Unknown error retry')
            if kind == 'rpc' and isinstance(parsed, dict) and ('jsonrpc' in parsed or 'error' in parsed):
                raise ValueError('RPC error retry veto')
            if not (classification in CLASSIFICATIONS or cap.get('failureKind') in ('transport_timeout', 'network') or (cap['complete'] and cap['status'] in (502, 503, 504))):
                raise ValueError('Unrecognized retry')
            value = None
        if cap['retry']:
            maximum = retry_maximum(q,last,r2,public_slow)
            if last is None or last['usable'] or (not last['retryable']) or (last['job'] != q) or (cap['retryOf'] != last['attempt']) or (cap['originalAttempt'] != last['originalAttempt']) or (cap['retryIndex'] != last['retryIndex'] + 1) or (not 1 <= cap['retryIndex'] <= maximum):
                raise ValueError('One exact retry ordinal')
            if cap['startOffsetSeconds'] + 0.002 < last['startOffsetSeconds'] + last['durationSeconds'] + WAITS[cap['retryIndex'] - 1]:
                raise ValueError('Retry wait')
        elif cap['retryIndex'] or cap['retryOf'] is not None or cap['originalAttempt'] != number or (last is not None and (not last['usable'])):
            raise ValueError('Skipped exhausted query or original ordinal')
        if reference is not None and cap['usable'] and q['window'] == 1:
            if q['kind'] == 'rpc' and q['number'] == reference['target']['number'] and any(value[k] != reference['target'][k] for k in reference['target']):
                raise ValueError('R1 opening target comparison')
            if q['kind'] == 'changes' and q['phase'] == 'data' and q['family'] == 'tokenHolders' and q['cursor'] is None and value['tokenHolders'] != reference['rows']:
                raise ValueError('R1 first-page values')
        totals['attempts'] += 1
        totals['extraAttempts'] += int(cap['retry'])
        totals['chargedBytes'] += wire
        totals['observedBytes'] += len(raw)
        totals['chargedEntities'] += charged
        totals['returnedEntities'] += count or 0
        totals['unknownEntityReservations'] += q['maxRows'] if count is None else 0
        totals[kind + 'Attempts'] += 1
        totals[kind + 'ChargedBytes'] += wire
        totals[kind + 'ExtraAttempts'] += int(cap['retry'])
        if kind == 'rpc':
            endpoints[q['endpoint']] += 1
        caps.append((cap, value if window is None or q['window'] == window else None, line))
        last = cap
        if r2:control_replay.observe(q, value)
    if state['pending'] is not None or any((state[k] != v for k, v in totals.items())) or state['rpcEndpointAttempts'] != endpoints:
        raise ValueError('Closed accounting reconciliation')
    if totals['attempts'] > 2248 or totals['graphAttempts'] > 2200 or totals['rpcAttempts'] > 48 or (max(endpoints) > 24) or (totals['extraAttempts'] > 100) or (totals['graphExtraAttempts'] > 88) or (totals['rpcExtraAttempts'] > 12) or (totals['graphChargedBytes'] > 256 * 1024 ** 2) or (totals['rpcChargedBytes'] > 8 * 1024 ** 2) or (totals['chargedEntities'] > 500000):
        raise ValueError('Gross bound')
    return (caps, totals)

def audit_window(root, index, plan, state):
    root = Path(root)
    caps, _ = audit_captures(root, plan, state, index, terminal=True)
    selected = [(c, v, line) for c, v, line in caps if c['job']['window'] == index]
    usable = [(c, v) for c, v, _ in selected if c['usable']]
    at = 0
    binding = strict_json((root / f'WINDOW_{index}_BINDING.json').read_bytes())
    base = binding['base']
    target = binding['target']
    w = plan['windows'][index - 1]
    if base['number'] != w['fromInclusive'] or target['number'] != w['targetNumber']:
        raise ValueError('Window domain')
    if index == 1 and base != plan['base'] or (index > 1 and base != strict_json((root / f'WINDOW_{index - 1}_BINDING.json').read_bytes())['target']) or (index == len(plan['windows']) and target != plan['finalTarget']):
        raise ValueError('Consecutive/saved pin')

    def take(q):
        nonlocal at
        if at >= len(usable) or usable[at][0]['job'] != q:
            raise ValueError('Physical request order/query plan')
        cap, value = usable[at]
        at += 1
        return (cap, value)

    def rpc(number=None, phase='opening'):
        return [take(make_job(plan, index, 'rpc', phase, endpoint=ep, method='eth_chainId' if number is None else 'eth_getBlockByNumber', number=number))[1] for ep in (0, 1)]
    base_headers = None
    if index == 1:
        rpc()
        base_headers = rpc(base['number'])
        if base_headers[0] != base_headers[1] or {k: base_headers[0][k] for k in base} != base:
            raise ValueError('Opening base headers')
    headers = rpc(target['number'])
    if headers[0] != headers[1] or {k: headers[0][k] for k in target} != target or target['timestamp'] <= base['timestamp']:
        raise ValueError('Opening target headers')
    for p in (base, target):
        take(make_job(plan, index, 'meta', 'opening', pin=p))
    provenance = {}
    families = {}
    folder = root / f'window-{index:02d}'
    for family in FAMILIES:
        provenance[family] = {}
        cursor = None
        first = 100
        pages = 0
        rows = {}
        initial = None
        last = None
        growth = []
        while True:
            q = make_job(plan, index, 'changes', pin=target, family=family, first=first, cursor=cursor)
            cap, data = take(q)
            page = validate_data(q, data)
            pages += 1
            receipt = strict_json((folder / family / f'{pages:05d}.json').read_bytes())
            raw = (folder / family / f'{pages:05d}.ndjson').read_bytes()
            if raw != b''.join((encode(r) for r in page)) or receipt['pageSha256'] != digest(raw) or receipt['query'] != q or (receipt['attempt'] != cap['attempt']) or (receipt['rows'] != len(page)) or (receipt['completeBodyBytes'] != cap['responseBytes']):
                raise ValueError('Durable page receipt')
            if receipt['logicalStartOffset'] > caps[cap['originalAttempt'] - 1][0]['startOffsetSeconds'] + 0.002 or receipt['acceptedOffset'] + 0.002 < cap['startOffsetSeconds'] + cap['durationSeconds'] or receipt['logicalSeconds'] + 0.002 < cap['startOffsetSeconds'] + cap['durationSeconds'] - receipt['logicalStartOffset']:
                raise ValueError('Growth logical duration')
            if initial is None:
                initial = (q, page)
            if page:
                last = (q, page)
            for r in page:
                if r['id'] in rows:
                    raise ValueError('Duplicate family row')
                rows[r['id']] = r
                provenance[family][r['id']] = [{'window': index, 'attempt': cap['attempt'], 'capture': cap['capture'], 'responseSha256': cap['responseSha256'], 'family': family}]
            if len(rows) > 50000:
                raise ValueError('Changed-family bound')
            cursor = page[-1]['id'] if page else cursor
            if not page:
                break
            if first == 100:
                growth.append(len(page) == 100 and receipt['logicalSeconds'] <= 10 and (cap['responseBytes'] <= 524288))
                if len(growth) == 5:
                    if all(growth):
                        first = 500
                    growth = []
        for q, expected in [initial, last] if last is not None else [initial]:
            repeat = {**q, 'phase': 'control'}
            _, data = take(repeat)
            if validate_data(repeat, data) != expected:
                raise ValueError('First/last/empty repeat')
        families[family] = rows
    affected = {}
    children = []
    for family, link in [('stakeEnds', 'stakeEnd'), ('stakeGoodAccountings', 'stakeGoodAccounting')]:
        for row in families[family].values():
            sid = row['stakeId']
            owner = row['stakerAddr'].lower()
            if sid in affected and affected[sid] != owner:
                raise ValueError('Child owner conflict')
            affected[sid] = owner
            children.append((link, row))
    parents = {}
    parent_prov = {}
    ids = sorted(affected)
    for offset in range(0, len(ids), 50):
        batch = ids[offset:offset + 50]
        cap, data = take(make_job(plan, index, 'parents', pin=target, family='stakeStarts', first=len(batch), ids=batch))
        got = {}
        for r in data['stakeStarts']:
            if r['stakeId'] in got or r['stakerAddr'].lower() != affected[r['stakeId']]:
                raise ValueError('Parent identity')
            got[r['stakeId']] = r
            parents[r['id']] = r
            parent_prov[r['id']] = {'window': index, 'attempt': cap['attempt'], 'capture': cap['capture'], 'responseSha256': cap['responseSha256'], 'family': 'resolvedParent'}
        if set(got) != set(batch):
            raise ValueError('Missing parent')
    numeric = {r['stakeId']: r for r in parents.values()}
    for link, child in children:
        if numeric[child['stakeId']][link] != child:
            raise ValueError('Independent child relation')
    start_prov = {k: list(v) for k, v in provenance['stakeStarts'].items()}
    starts = dict(families['stakeStarts'])
    child_only = sorted(set(parents) - set(starts))
    for id, row in parents.items():
        if id in starts and starts[id] != row:
            raise ValueError('Changed/resolved parent conflict')
        starts[id] = row
        start_prov.setdefault(id, []).append(parent_prov[id])
    after = {'tokenHolders': [families['tokenHolders'][k] for k in sorted(families['tokenHolders'])], 'stakeStarts': [starts[k] for k in sorted(starts)]}
    observed = strict_json((root / f'WINDOW_{index}_AFTER.json').read_bytes())
    draft = strict_json((root / f'WINDOW_{index}_DRAFT.json').read_bytes())
    if observed['after'] != after or observed['childOnly'] != child_only or any(([e['after'] for e in draft['changes'][f]] != after[f] for f in after)):
        raise ValueError('Exact retained after records')
    source_counts = {f: len(families[f]) for f in FAMILIES}
    source_counts['affectedParents'] = len(affected)
    expected_provenance = {'tokenHolders': provenance['tokenHolders'], 'stakeStarts': start_prov}
    if observed != {'window': index, 'base': base, 'target': target, 'after': after, 'provenance': expected_provenance, 'sourceCounts': source_counts, 'childOnly': child_only}:
        raise ValueError('Exact captured window envelope')
    if draft['schemaVersion'] != 2 or draft['complete'] is not True or draft['base'] != base or (draft['target'] != target) or (draft['deployment'] != DEPLOYMENT) or (draft['sourceCounts'] != source_counts) or any((draft[k] is not False for k in ('fullTargetInventoryProven', 'deletionsSupported', 'reorgSafetyProven'))):
        raise ValueError('Draft qualification envelope')
    if index > 1 and draft['predecessor'] != strict_json((root / f'WINDOW_{index - 1}_ACK.json').read_bytes())['generation']:
        raise ValueError('Draft predecessor')
    for f, entries in draft['changes'].items():
        for e in entries:
            if e['afterProvenance'] != expected_provenance[f][e['id']]:
                raise ValueError('After provenance mismatch')
    groups = {}
    chosen = {f: set() for f in after}
    for f, entries in draft['changes'].items():
        for e in entries:
            tags = [e['kind']] + ([k for k in ('stakeEnd', 'stakeGoodAccounting') if k in e['changedFields']] + (['child-only'] if e['id'] in child_only else []) if f == 'stakeStarts' else [])
            for tag in tags:
                groups.setdefault((f, tag), []).append(e['id'])
    for (f, tag), group in sorted(groups.items()):
        chosen[f].update((group[0], group[-1]))
    if sum(map(len, chosen.values())) > 32:
        raise ValueError('Witness count')
    for f in after:
        batch = sorted(chosen[f])
        byid = {e['id']: e for e in draft['changes'][f]}
        if not batch:
            continue
        for side, p in [('before', base), ('after', target)]:
            _, data = take(make_job(plan, index, 'witness', 'control', pin=p, family=f, first=len(batch), ids=batch))
            if {r['id']: r for r in data[f]} != {id: byid[id][side] for id in batch if byid[id][side] is not None}:
                raise ValueError('Witness comparison')
    for p in (base, target):
        take(make_job(plan, index, 'meta', 'control', pin=p))
    if rpc(target['number'], 'control') != headers or (index == 1 and rpc(base['number'], 'control') != base_headers):
        raise ValueError('Closing headers')
    if at != len(usable):
        raise ValueError('Unplanned extra successful request')
    seal = strict_json((root / f'WINDOW_{index}_SEAL.json').read_bytes())
    if datetime.fromisoformat(seal['sealedAt']) < max((datetime.fromisoformat(c['finishedAt']) for c, _ in usable)) or seal['base'] != base or seal['target'] != target or (seal['sourceCounts'] != source_counts) or (seal['childOnly'] != child_only):
        raise ValueError('Premature or inconsistent window seal')
    if [x['attempt'] for x in seal['calls']] != [c['attempt'] for c, _ in usable]:
        raise ValueError('Seal request chain')
    return {'format': 'participant-window-proof-1', 'complete': True, 'base': base, 'target': target, 'deployment': DEPLOYMENT, 'captureLedgerSha256': digest(b''.join((line for _, _, line in selected))), 'afterSha256': {f: selected_digest(rows) for f, rows in after.items()}, 'families': list(FAMILIES), 'explicitEmptyAndRepeats': True, 'parentChecks': True, 'witnessChecks': True, 'closingHeadersAndMetadata': True, 'networkClosureKnown': True}
