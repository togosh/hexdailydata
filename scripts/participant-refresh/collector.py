"""One finite sequence of complete changed windows; no outer retry or resume."""
import sys, json, time, queue, threading, secrets, shutil
from pathlib import Path
HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
from durable import strict_json, encode, digest, selected_digest, utc, save
from capture_client import WorkerTransport, Stop
from session import ParticipantSession
from queries import make_job, FAMILIES, validate_data, validate_job
from retry_schedule import control_template, enabled

def controls(window):
    return control_template(window)

def remove_controls(s, kind, family=None, n=1, endpoint=None):
    for _ in range(n):
        at = next((i for i, c in enumerate(s.controls) if c['kind'] == kind and (family is None or c.get('family') == family) and (endpoint is None or c.get('endpoint') == endpoint)))
        s.controls.pop(at)

def pin(header):
    return {k: header[k] for k in ('number', 'hash', 'timestamp')}

def agree(headers, expected=None):
    if headers[0] != headers[1]:
        raise Stop('Paired header identity mismatch')
    if expected is not None and pin(headers[0]) != expected:
        raise Stop('Saved header identity drift')
    return pin(headers[0])

def run_window(s, index, base, exchange, seen):
    s.begin_window(index)
    s.controls = controls(index)
    plan = s.plan
    w = plan['windows'][index - 1]
    folder = s.root / f'window-{index:02d}'
    folder.mkdir()
    calls = []

    def ask(role, q):
        cap, value = s.request(q)
        calls.append({'role': role, 'attempt': cap['attempt'], 'job': q})
        return (cap, value)

    def rpc(role, number=None, phase='opening'):
        return [ask(role + str(ep), make_job(plan, index, 'rpc', phase, endpoint=ep, method='eth_chainId' if number is None else 'eth_getBlockByNumber', number=number))[1] for ep in (0, 1)]
    opening_base = None
    if index == 1:
        rpc('chain')
        opening_base = rpc('base-open', plan['base']['number'])
        agree(opening_base, plan['base'])
    opening = rpc('target-open', w['targetNumber'])
    target = agree(opening, plan['finalTarget'] if index == len(plan['windows']) and plan['finalTarget'].get('hash') is not None else None)
    if plan.get('combinedJob'):
        if len(plan['windows']) != 1 or target['number'] != 27754425:
            raise Stop('Combined exact participant target')
        plan['finalTarget'] = target
        s.storage.json(s.root / 'RESOLVED_PLAN.json', plan)
    reference = getattr(s, 'reference', None) if index == 1 else None
    if reference is not None and target != reference['target']:
        raise Stop('R1 first-target header drift')
    if target['timestamp'] <= base['timestamp'] or target['timestamp'] > time.time() + 30:
        raise Stop('Header time order/future')
    s.storage.json(s.root / f'WINDOW_{index}_BINDING.json', {'base': base, 'target': target, 'openingHeaders': opening, 'openingBaseHeaders': opening_base})
    for label, p in [('base', base), ('target', target)]:
        ask(label + '-meta-open', make_job(plan, index, 'meta', 'opening', pin=p))
    families = {}
    provenance = {}
    summaries = {}
    for family in FAMILIES:
        rows = {}
        prov = {}
        cursor = None
        first = 100
        first_page = None
        last_page = None
        number = 0
        growth = []
        family_root = folder / family
        family_root.mkdir()
        while True:
            q = make_job(plan, index, 'changes', pin=target, family=family, first=first, cursor=cursor)
            if reference is not None and family == 'tokenHolders' and number < 2:
                expected = reference['firstPageRequestSha256'] if number == 0 else reference['failedSecondPageRequestSha256']
                if digest(validate_job(q, plan)[2]) != expected:
                    raise Stop('R1 exact first/second query drift')
            began = s.clock()
            start_offset = began - s.started
            cap, data = ask(family + '-page', q)
            page = validate_data(q, data)
            if reference is not None and family == 'tokenHolders' and number == 0:
                if page != reference['rows']:
                    raise Stop('R1 first-page full-object mismatch')
                s.storage.json(s.root / 'R1_FIRST_PAGE_COMPARISON.json', {'status': 'PASS', 'rows': len(page), 'inheritedCoverage': 0, 'oldPageSha256': reference['pageSha256'], 'freshAttempt': cap['attempt'], 'fullSelectedObjectsEqual': True})
            number += 1
            raw = b''.join((encode(r) for r in page))
            s.storage.put(family_root / f'{number:05d}.ndjson', raw)
            if len(rows) + len(page) > 50000:
                raise Stop('Window family-key bound')
            for row in page:
                if row['id'] in rows:
                    raise Stop('Duplicate changed ID')
                rows[row['id']] = row
                prov[row['id']] = [{'window': index, 'attempt': cap['attempt'], 'capture': cap['capture'], 'responseSha256': cap['responseSha256'], 'family': family}]
            if first_page is None:
                first_page = (q, page)
            if page:
                last_page = (q, page)
            cursor = page[-1]['id'] if page else cursor
            s.storage.json(family_root / 'CURSOR.json', {'cursor': cursor, 'pages': number, 'rows': len(rows), 'explicitEmpty': not page}, replace=number > 1)
            elapsed = s.clock() - began
            receipt = {'query': q, 'attempt': cap['attempt'], 'rows': len(page), 'pageSha256': digest(raw), 'logicalStartOffset': start_offset, 'acceptedOffset': s.clock() - s.started, 'logicalSeconds': elapsed, 'completeBodyBytes': cap['responseBytes']}
            s.storage.json(family_root / f'{number:05d}.json', receipt)
            if not page:
                break
            if first == 100:
                growth.append(len(page) == 100 and elapsed <= 10 and (cap['responseBytes'] <= 524288))
                if len(growth) == 5:
                    if all(growth):
                        first = 500
                    growth = []
        repeats = [first_page, last_page] if last_page is not None else [first_page]
        remove_controls(s, 'changes', family, 2 - len(repeats))
        for n, (q, expected) in enumerate(repeats):
            remove_controls(s, 'changes', family)
            repeated = {**q, 'phase': 'control'}
            cap, data = ask(family + '-repeat-' + str(n), repeated)
            if validate_data(repeated, data) != expected:
                raise Stop('Changed-family boundary drift')
        families[family] = rows
        provenance[family] = prov
        summaries[family] = {'rows': len(rows), 'pagesIncludingEmpty': number, 'explicitEmpty': True, 'boundaryRepeats': len(repeats)}
        if family in ('tokenHolders', 'stakeStarts'):
            seen[family].update(rows)
            if len(seen[family]) > 50000:
                raise Stop('Session unique-key ceiling')
    affected = {}
    children = []
    for family, link in [('stakeEnds', 'stakeEnd'), ('stakeGoodAccountings', 'stakeGoodAccounting')]:
        for child in families[family].values():
            sid = child['stakeId']
            owner = child['stakerAddr'].lower()
            if sid in affected and affected[sid] != owner:
                raise Stop('Conflicting child owners')
            affected[sid] = owner
            children.append((link, child))
    seen['parents'].update(affected)
    if len(seen['parents']) > (10000 if plan.get('combinedJob') else 50000):
        raise Stop('Session affected-parent ceiling')
    parents = {}
    parent_prov = {}
    ids = sorted(affected)
    for at in range(0, len(ids), 50):
        batch = ids[at:at + 50]
        q = make_job(plan, index, 'parents', pin=target, family='stakeStarts', first=len(batch), ids=batch)
        cap, data = ask('parents', q)
        got = {}
        for row in data['stakeStarts']:
            if row['stakeId'] in got or row['stakerAddr'].lower() != affected[row['stakeId']]:
                raise Stop('Parent duplicate/owner mismatch')
            got[row['stakeId']] = row
            parents[row['id']] = row
            parent_prov[row['id']] = {'window': index, 'attempt': cap['attempt'], 'capture': cap['capture'], 'responseSha256': cap['responseSha256'], 'family': 'resolvedParent'}
        if set(got) != set(batch):
            raise Stop('Missing or ambiguous affected parent')
    numeric = {r['stakeId']: r for r in parents.values()}
    for link, child in children:
        if numeric[child['stakeId']][link] != child:
            raise Stop('Independent child/nested parent mismatch')
    starts = dict(families['stakeStarts'])
    start_prov = {k: list(v) for k, v in provenance['stakeStarts'].items()}
    child_only = sorted(set(parents) - set(starts))
    for id, row in parents.items():
        if id in starts and starts[id] != row:
            raise Stop('Changed and resolved parent conflict')
        starts[id] = row
        start_prov.setdefault(id, []).append(parent_prov[id])
    seen['stakeStarts'].update(starts)
    if len(seen['stakeStarts']) > 50000:
        raise Stop('Session unique-parent/start union')
    after = {'tokenHolders': [families['tokenHolders'][k] for k in sorted(families['tokenHolders'])], 'stakeStarts': [starts[k] for k in sorted(starts)]}
    source_counts = {f: len(families[f]) for f in FAMILIES}
    source_counts['affectedParents'] = len(affected)
    after_document = {'window': index, 'base': base, 'target': target, 'after': after, 'provenance': {'tokenHolders': provenance['tokenHolders'], 'stakeStarts': start_prov}, 'sourceCounts': source_counts, 'childOnly': child_only}
    s.storage.json(s.root / f'WINDOW_{index}_AFTER.json', after_document)
    exchange({'type': 'prepare', 'window': index, 'afterSha256': digest(encode(after_document))}, s.started + 5100)
    draft = strict_json((s.root / f'WINDOW_{index}_DRAFT.json').read_bytes())
    if draft['base'] != base or draft['target'] != target or any(([e['after'] for e in draft['changes'][f]] != after[f] for f in after)):
        raise Stop('Local draft changed captured after-values')
    groups = {}
    for f, entries in draft['changes'].items():
        for e in entries:
            tags = [e['kind']]
            if f == 'stakeStarts':
                tags += [k for k in ('stakeEnd', 'stakeGoodAccounting') if k in e['changedFields']]
                if e['id'] in child_only:
                    tags.append('child-only')
            for tag in tags:
                groups.setdefault((f, tag), []).append(e['id'])
    chosen = {f: set() for f in after}
    for (f, tag), group in sorted(groups.items()):
        chosen[f].update((group[0], group[-1]))
    if sum(map(len, chosen.values())) > 32:
        raise Stop('Witness ID ceiling')
    s.storage.json(folder / 'WITNESSES.json', {'groups': {f + ':' + k: v for (f, k), v in groups.items()}, 'chosen': {f: sorted(v) for f, v in chosen.items()}})
    for f in after:
        batch = sorted(chosen[f])
        byid = {e['id']: e for e in draft['changes'][f]}
        if not batch:
            remove_controls(s, 'witness', f, 2)
            continue
        for side, p in [('before', base), ('after', target)]:
            remove_controls(s, 'witness', f)
            q = make_job(plan, index, 'witness', 'control', pin=p, family=f, first=len(batch), ids=batch)
            cap, data = ask(f + '-' + side + '-witness', q)
            if {r['id']: r for r in data[f]} != {id: byid[id][side] for id in batch if byid[id][side] is not None}:
                raise Stop('Direct before/after witness mismatch')
    s.closing = True
    for label, p in [('base', base), ('target', target)]:
        remove_controls(s, 'meta')
        ask(label + '-meta-close', make_job(plan, index, 'meta', 'control', pin=p))
    for role, number, expected in [('target-close', target['number'], opening)] + ([('base-close', base['number'], opening_base)] if index == 1 else []):
        for ep in (0, 1):
            remove_controls(s, 'rpc', endpoint=ep)
            _, actual = ask(role + str(ep), make_job(plan, index, 'rpc', 'control', endpoint=ep, method='eth_getBlockByNumber', number=number))
            if actual != expected[ep]:
                raise Stop('Closing header drift')
    if s.controls:
        raise Stop('Unconsumed mandatory controls')
    seal = {'window': index, 'base': base, 'target': target, 'calls': calls, 'families': summaries, 'sourceCounts': source_counts, 'childOnly': child_only, 'sealedAt': utc()}
    s.storage.json(s.root / f'WINDOW_{index}_SEAL.json', seal)
    s.persist()
    from audit import audit_window
    proof = audit_window(s.root, index, plan, s.state)
    s.storage.json(s.root / f'WINDOW_{index}_AUDIT.json', proof)
    ack = exchange({'type': 'qualified', 'window': index, 'proofSha256': selected_digest(proof), 'auditFileSha256': digest(encode(proof))}, s.started + 5400)
    ack = {**ack, 'recordedOffsetSeconds': s.clock() - s.started, 'recordedAt': utc()}
    s.storage.json(s.root / f'WINDOW_{index}_ACK.json', ack)
    frontier = {'completedWindows': index, 'pin': target, 'generation': ack['generation'], 'productVersion': ack['productVersion']}
    s.storage.json(s.root / 'FRONTIER.json', frontier, replace=True)
    return target

def execute(output, preflight, test_transport=None, test_clock=None, test_sleep=None, test_exchange=None):
    root = Path(output).resolve()
    preflight = Path(preflight).resolve()
    binding = strict_json(preflight.read_bytes())
    synthetic = test_transport is not None
    if binding['verdict'] != 'PASS' or binding['taskId'] not in ('HDD-PARTICIPANT-CATCHUP-REFRESH-R1', 'HDD-PARTICIPANT-CATCHUP-REFRESH-R2') or binding['trialRoot'] != str(root) or (bool(binding.get('synthetic')) != synthetic):
        raise ValueError('Preflight authority/root')
    for name, h in binding['runtimeFiles'].items():
        if digest((REPOSITORY / name).read_bytes()) != h:
            raise ValueError('Frozen runtime changed')
    for name, h in binding['inputFiles'].items():
        if digest((preflight.parent / name).read_bytes()) != h:
            raise ValueError('Frozen input changed')
    if root.exists():
        raise ValueError('Existing/uncertain admission; no reset')
    if shutil.disk_usage(root.parent).free < 20 * 1024 ** 3:
        raise ValueError('Admission disk space')
    plan_raw = (preflight.parent / 'SCOPE.json').read_bytes()
    plan = strict_json(plan_raw)
    if plan['taskId'] != binding['taskId']:
        raise ValueError('Task/plan identity')
    reference = None
    reference_raw = None
    if enabled(plan) and not synthetic:
        reference_raw = (preflight.parent / 'R1_COMPARISON.json').read_bytes()
        reference = strict_json(reference_raw)
        if digest(reference_raw) != binding['inputFiles'].get('R1_COMPARISON.json'):
            raise ValueError('Unbound R1 comparison')
    root.mkdir()
    (root / 'temp').mkdir()
    (root / 'PLAN.json').write_bytes(plan_raw)
    nonce = secrets.token_hex(32)
    save(root / 'ADMISSION.json', {'task': binding['taskId'], 'nonce': nonce, 'recordedAt': utc(), 'runtimeFiles': binding['runtimeFiles'], 'planSha256': digest(plan_raw), 'preflightSha256': digest(preflight.read_bytes())})
    s = ParticipantSession(root, test_transport, plan, test_clock, test_sleep, True) if synthetic else ParticipantSession(root, WorkerTransport(nonce, worker_path=HERE / 'worker.py'), plan)
    if reference is not None:
        s.reference = reference
        s.storage.put(root / 'R1_COMPARISON.json', reference_raw)
    s.storage.json(root / 'FRONTIER.json', {'completedWindows': 0, 'pin': plan['base'], 'generation': binding['initialGeneration'], 'productVersion': binding['initialProductVersion']})
    incoming = queue.Queue()

    def reader():
        try:
            for line in sys.stdin:
                if len(line) > 32768:
                    raise ValueError('IPC size')
                incoming.put(strict_json(line))
        finally:
            incoming.put(None)
    if test_exchange is None:
        threading.Thread(target=reader, daemon=True).start()

    def exchange(message, deadline):
        if test_exchange:
            return test_exchange(message, deadline)
        allowance = min(180, deadline - s.clock())
        if allowance <= 0:
            raise Stop('Local publication deadline')
        message['expiresAtUnixSeconds'] = time.time() + allowance
        print(json.dumps(message), flush=True)
        try:
            answer = incoming.get(timeout=allowance)
        except queue.Empty:
            raise Stop('Local publication/acknowledgement unknown')
        if not isinstance(answer, dict) or answer.get('window') != message['window'] or answer.get('ok') is not True:
            raise Stop('Local admission/publication refused or unknown')
        return answer
    completed = 0
    base = plan['base']
    seen = {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')}
    try:
        for index in range(1, len(plan['windows']) + 1):
            base = run_window(s, index, base, exchange, seen)
            completed = index
        result = {'status': 'COMPLETE_SCOPED_CATCHUP', 'completedWindows': completed, 'frontier': base}
    except BaseException as exc:
        result = {'status': 'PARTIAL', 'completedWindows': completed, 'frontier': base, 'failure': type(exc).__name__ + ': ' + str(exc)}
    finally:
        s.close(result.get('failure', 'All consecutive windows and local publication closed'))
        result.update(accounting=s.state, networkSessionCount=0 if synthetic else 1, noAutomaticRestart=True, indexer='PARKED', sourceCoverage='accepted_base_plus_observed_updates', fullTargetInventoryProven=False)
        s.storage.json(root / 'RESULT.json', result)
        print(json.dumps({'type': 'closed', 'result': result}), flush=True)
    return 0 if result['status'] == 'COMPLETE_SCOPED_CATCHUP' else 2
if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != 'run':
        raise SystemExit('Explicit run OUTPUT PREFLIGHT required; no default requests')
    raise SystemExit(execute(sys.argv[2], sys.argv[3]))
