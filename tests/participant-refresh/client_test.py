"""Injected actual query/client/page/parent/auditor tests. External calls forbidden."""
import os, sys, json, tempfile, unittest, socket, subprocess, copy
from pathlib import Path
W = Path(__file__).resolve().parents[2]
R = Path(os.environ['HDD_TASK_ROOT'])

def forbidden(*args, **kwargs):
    raise AssertionError('Offline network/child forbidden')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = subprocess.Popen = forbidden
sys.path[:0] = [str(W / 'scripts/participant-refresh'), str(W / 'scripts/market-refresh')]
from queries import *
from durable import encode, digest, strict_json, selected_digest
from session import ParticipantSession
from capture_client import Stop, LimitReached
from collector import run_window
from audit import audit_window, audit_captures
PLAN = strict_json((R / 'SCOPE.json').read_bytes())

class Clock:

    def __init__(self):
        self.n = 0.0
        self.waits = []

    def __call__(self):
        return self.n

    def sleep(self, n):
        self.n += n
        self.waits.append(n)

def record(family, id, stake='20'):
    out = {}
    for f in SCHEMAS[family]['fields']:
        k = f['name']
        if k in CHILDREN:
            out[k] = None
            continue
        t = f['type']['ofType']['name']
        out[k] = False if t == 'Boolean' else '1' if t in ('BigInt', 'BigDecimal') else id if t == 'ID' else '0x' + 'a' * (64 if k == 'transactionHash' else 40)
    if 'stakeId' in out:
        out['stakeId'] = stake
    return out

class Fixture:

    def __init__(self, clock, holders=1, replies=None, drift=None):
        self.clock = clock
        self.holders = holders
        self.replies = list(replies or [])
        self.drift = drift
        self.queries = []
        self.base_holder = record('tokenHolders', '0x01')
        self.base_start = record('stakeStarts', '0x20')

    def pin(self, number):
        if number == PLAN['base']['number']:
            return PLAN['base']
        if number == PLAN['finalTarget']['number']:
            return PLAN['finalTarget']
        return {'number': number, 'hash': '0x' + format(number, '064x'), 'timestamp': PLAN['base']['timestamp'] + (number - PLAN['base']['number']) * 10}

    def data_rows(self, family, window, side='after'):
        if family == 'tokenHolders':
            rows = [{**self.base_holder, 'id': f'0x{x + 1:06x}', 'holderAddress': '0x' + format(x + 1, '040x'), 'tokenBalance': str(window + 1)} for x in range(self.holders)]
            if self.holders == 1:
                rows = [{**self.base_holder, 'tokenBalance': str(window + 1)}]
            return rows
        if family == 'stakeStarts':
            return []
        if family == 'stakeEnds':
            return [{**record('stakeEnds', 'end20'), 'payout': str(window + 1)}]
        if family == 'stakeGoodAccountings':
            return []

    def parent(self, window):
        return {**self.base_start, 'stakeEnd': self.data_rows('stakeEnds', window)[0]}

    def __call__(self, path, deadline, storage):
        q = strict_json(path.read_bytes())['job']
        self.queries.append(q)
        self.clock.n += 0.1
        status = 200
        if self.replies:
            reply = self.replies.pop(0)
            if reply in ('timeout', 'unknown'):
                return {'childReaped': reply != 'unknown', 'connectionClosed': reply != 'unknown', 'complete': False, 'failureKind': 'transport_timeout' if reply == 'timeout' else 'unknown_closure'}
            if isinstance(reply, tuple):
                status, reply = reply
            raw = reply if isinstance(reply, bytes) else encode(reply)
        elif q['kind'] == 'rpc':
            p = self.pin(q['number']) if q['number'] is not None else None
            value = '0x171' if p is None else {'number': hex(p['number']), 'hash': p['hash'], 'timestamp': hex(p['timestamp']), 'parentHash': '0x' + 'b' * 64, 'transactions': []}
            if self.drift == 'header' and q['phase'] == 'control':
                value['hash'] = '0x' + 'c' * 64
            raw = encode({'jsonrpc': '2.0', 'id': 1, 'result': value})
        else:
            p = q['pin']
            m = {'deployment': DEPLOYMENT, 'hasIndexingErrors': False, 'block': {**p, 'timestamp': None}}
            if self.drift == 'deployment':
                m['deployment'] = 'different'
            data = {'_meta': m}
            f = q['family']
            window = q['window']
            if q['kind'] == 'changes':
                rows = self.data_rows(f, window)
                rows = [r for r in rows if q['cursor'] is None or r['id'] > q['cursor']][:q['first']]
                if self.drift == 'repeat' and q['phase'] == 'control' and rows:
                    rows = [{**rows[0], 'tokenBalance': '999'}] if f == 'tokenHolders' else rows
                data[f] = rows
            elif q['kind'] == 'parents':
                data[f] = [] if self.drift == 'missing-parent' else [self.parent(window)]
            elif q['kind'] == 'witness':
                before = p['number'] == PLAN['windows'][window - 1]['fromInclusive']
                if f == 'stakeStarts':
                    rows = [self.base_start] if before and window == 1 else [self.parent(window - 1 if before else window)]
                elif self.holders == 1:
                    rows = [self.base_holder] if before and window == 1 else self.data_rows(f, window - 1 if before else window)
                else:
                    rows = [] if before and window == 1 else self.data_rows(f, window - 1 if before else window)
                data[f] = [r for r in rows if r['id'] in q['ids']]
            raw = encode({'data': data})
        (path.parent / 'response.body').write_bytes(raw)
        return {'status': status, 'complete': True, 'framingValidated': True, 'connectionClosed': True, 'childReaped': True, 'headers': [['Content-Length', str(len(raw))]], 'expectedBodyBytes': len(raw), 'framingKind': 'content-length', 'wireBodyBytes': len(raw), 'wireBodySha256': digest(raw)}

class Tests(unittest.TestCase):

    def session(self, **kwargs):
        parent = R / 'evidence/fixtures'
        parent.mkdir(exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix='participant-client-', dir=parent))
        clock = Clock()
        fixture = Fixture(clock, **kwargs)
        session = ParticipantSession(root, fixture, PLAN, clock, clock.sleep, True)
        session.storage.json(root / 'FRONTIER.json', {'completedWindows': 0})
        self.addCleanup(lambda: session.close('Synthetic test closure'))
        return (session, clock, fixture)

    def exchange(self, s, fixture):
        selected = {'tokenHolders': {fixture.base_holder['id']: fixture.base_holder} if fixture.holders == 1 else {}, 'stakeStarts': {fixture.base_start['id']: fixture.base_start}}
        generation = '1' * 64

        def exchange(m, deadline):
            nonlocal generation
            n = m['window']
            if m['type'] == 'prepare':
                a = strict_json((s.root / f'WINDOW_{n}_AFTER.json').read_bytes())
                changes = {f: [] for f in ('tokenHolders', 'stakeStarts')}
                for f, rows in a['after'].items():
                    for after in rows:
                        before = selected[f].get(after['id'])
                        fields = [k for k in after if before is None or before[k] != after[k]]
                        changes[f].append({'operation': 'upsert', 'family': f, 'id': after['id'], 'kind': 'new' if before is None else 'replacement' if fields else 'unchanged_overlap', 'before': before, 'after': after, 'beforeProvenance': None if before is None else {'generation': generation, 'rowSha256': selected_digest(before)}, 'afterProvenance': a['provenance'][f][after['id']], 'changedFields': fields})
                s.storage.json(s.root / f'WINDOW_{n}_DRAFT.json', {'schemaVersion': 2, 'complete': True, 'predecessor': generation, 'deployment': DEPLOYMENT, 'base': a['base'], 'target': a['target'], 'changes': changes, 'sourceCounts': a['sourceCounts'], 'fullTargetInventoryProven': False, 'deletionsSupported': False, 'reorgSafetyProven': False})
            else:
                draft = strict_json((s.root / f'WINDOW_{n}_DRAFT.json').read_bytes())
                for f, rows in draft['changes'].items():
                    for row in rows:
                        selected[f][row['id']] = row['after']
                generation = selected_digest(draft)
            return {'ok': True, 'window': n, 'generation': generation, 'productVersion': str(n) * 64}
        return exchange

    def test_composed_consecutive_children_pages_audit(self):
        s, c, f = self.session()
        base = PLAN['base']
        seen = {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')}
        exchange = self.exchange(s, f)
        for n in (1, 2):
            base = run_window(s, n, base, exchange, seen)
        s.close('Synthetic complete')
        proof = audit_window(s.root, 2, PLAN, s.state)
        self.assertTrue(proof['parentChecks'])
        self.assertEqual(len(seen['parents']), 1)
        second = strict_json((s.root / 'WINDOW_2_DRAFT.json').read_bytes())
        self.assertEqual(second['changes']['tokenHolders'][0]['before']['tokenBalance'], '2')
        self.assertEqual(second['changes']['stakeStarts'][0]['before']['stakeEnd']['payout'], '2')
        (R / 'evidence' / f'CLIENT_COMPOSED_{s.root.name}.json').write_bytes(encode({'status': 'PASS', 'synthetic': True, 'proof': proof, 'accounting': s.state, 'externalRequests': 0, 'root': str(s.root)}))

    def test_growth_exact_parent_batch_and_empty(self):
        s, c, f = self.session(holders=650)
        run_window(s, 1, PLAN['base'], self.exchange(s, f), {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')})
        pages = [q for q in f.queries if q['kind'] == 'changes' and q['family'] == 'tokenHolders' and (q['phase'] == 'data')]
        self.assertEqual([q['first'] for q in pages], [100] * 5 + [500, 500])
        self.assertTrue(any((q['kind'] == 'parents' and q['first'] == 1 for q in f.queries)))
        s2, _, f2 = self.session(holders=0)
        run_window(s2, 1, PLAN['base'], self.exchange(s2, f2), {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')})
        q = [q for q in f2.queries if q['kind'] == 'changes' and q['family'] == 'tokenHolders']
        self.assertEqual(len(q), 2)

    def test_retry_shared_ordinal_and_original_policy(self):
        errors = [{'errors': [{'message': 'Store error: store error: prepared statement "__diesel_stmt_1" already exists'}]}, {'errors': [{'message': 'Store error: store error: unnamed prepared statement does not exist'}]}]
        s, c, f = self.session(replies=errors)
        q = make_job(PLAN, 1, 'meta', pin=PLAN['base'])
        s.request(q)
        self.assertEqual(s.state['extraAttempts'], 2)
        self.assertIn(15, c.waits)
        self.assertIn(60, c.waits)
        audit_captures(s.root, PLAN, s.state)
        for message in [{'errors': [{'message': 'unknown'}]}, {'data': {'bad': 1}, **errors[0]}]:
            a, _, _ = self.session(replies=[message])
            self.assertRaises(Stop, a.request, q)
            self.assertEqual(a.state['attempts'], 1)

    def test_unknown_incomplete_rpc_error_charges(self):
        q = make_job(PLAN, 1, 'rpc', 'opening', method='eth_chainId')
        s, c, f = self.session(replies=['timeout', {'jsonrpc': '2.0', 'id': 1, 'result': '0x171'}])
        s.request(q)
        self.assertEqual(s.state['unknownEntityReservations'], 4)
        self.assertGreaterEqual(s.state['chargedBytes'], 16384)
        unknown, _, _ = self.session(replies=['unknown'])
        self.assertRaises(Stop, unknown.request, q)
        self.assertIsNotNone(unknown.state['pending'])
        refused, _, _ = self.session(replies=[(503, {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -1, 'message': 'server'}})])
        self.assertRaises(Stop, refused.request, q)
        self.assertEqual(refused.state['attempts'], 1)

    def test_drift_missing_parent_and_partial_preservation(self):
        for drift in ('header', 'deployment', 'repeat', 'missing-parent'):
            s, c, f = self.session(drift=drift)
            with self.assertRaises((Stop, ValueError)):
                run_window(s, 1, PLAN['base'], self.exchange(s, f), {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')})
            self.assertFalse((s.root / 'WINDOW_1_ACK.json').exists())
        s, c, f = self.session()
        seen = {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')}
        ex = self.exchange(s, f)
        base = run_window(s, 1, PLAN['base'], ex, seen)
        old = (s.root / 'FRONTIER.json').read_bytes()
        f.drift = 'deployment'
        self.assertRaises(Stop, run_window, s, 2, base, ex, seen)
        self.assertEqual((s.root / 'FRONTIER.json').read_bytes(), old)
        self.assertTrue(audit_window(s.root,1,PLAN,s.state)['complete'])
        self.assertRaises(ValueError,audit_window,s.root,2,PLAN,s.state)

    def test_actual_budget_consumers_and_corruption(self):
        q = make_job(PLAN, 1, 'meta', pin=PLAN['base'])
        for key, value in [('graphAttempts', 2199), ('graphChargedBytes', 256 * 1024 ** 2 - 32768), ('chargedEntities', 499999), ('graphExtraAttempts', 88), ('extraAttempts', 100)]:
            s, c, f = self.session()
            s.state[key] = value
            self.assertRaises(LimitReached, s.request, q)
            self.assertEqual(len(f.queries), 0)
        s, c, f = self.session()
        c.n = 5100
        self.assertRaises(LimitReached, s.request, q)
        a, _, fixture = self.session()
        run_window(a, 1, PLAN['base'], self.exchange(a, fixture), {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')})
        body = a.root / 'captures/00001/response.body'
        raw = body.read_bytes()
        body.write_bytes(raw.replace(b'171', b'172'))
        self.assertRaises(ValueError, audit_window, a.root, 1, PLAN, a.state)

    def test_saved_audit_tampering_and_worker_gate(self):
        s, c, f = self.session()
        seen = {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')}
        exchange = self.exchange(s, f)
        b = run_window(s, 1, PLAN['base'], exchange, seen)
        run_window(s, 2, b, exchange, seen)
        for name, change in [('WINDOW_2_AFTER.json', lambda v: v['provenance']['tokenHolders']['0x01'][0].update(attempt=1)), ('WINDOW_2_DRAFT.json', lambda v: v['changes']['tokenHolders'][0]['afterProvenance'][0].update(responseSha256='f' * 64)), ('WINDOW_2_SEAL.json', lambda v: v.update(sealedAt='2020-01-01T00:00:00+00:00')), ('WINDOW_1_ACK.json', lambda v: v.update(recordedOffsetSeconds=9999))]:
            path = s.root / name
            original = path.read_bytes()
            value = strict_json(original)
            change(value)
            path.write_bytes(encode(value))
            self.assertRaises(ValueError, audit_window, s.root, 2, PLAN, s.state)
            path.write_bytes(original)
        from worker import gate
        qroot = s.root / 'captures/00007'
        request = qroot / 'request.json'
        q = strict_json(request.read_bytes())['job']
        (s.root / 'PLAN.json').write_bytes(encode(PLAN))
        (s.root / 'ADMISSION.json').write_bytes(encode({'nonce': 'SYNTHETIC', 'runtimeFiles': {}, 'planSha256': digest(encode(PLAN))}))
        old_state = (s.root / 'ACCOUNTING.json').read_bytes()
        old_frontier = (s.root / 'FRONTIER.json').read_bytes()
        state = {**s.state, 'status': 'ADMITTED', 'pending': {'requestPath': str(request)}}
        (s.root / 'ACCOUNTING.json').write_bytes(encode(state))
        (s.root / 'FRONTIER.json').write_bytes(encode({'completedWindows': 0}))
        self.assertEqual(gate(request, 'SYNTHETIC')[0], 'POST')
        self.assertRaises(ValueError, gate, request, 'WRONG')
        (s.root / 'FRONTIER.json').write_bytes(encode({'completedWindows': 1}))
        self.assertRaises(ValueError, gate, request, 'SYNTHETIC')
        (s.root / 'ACCOUNTING.json').write_bytes(old_state)
        (s.root / 'FRONTIER.json').write_bytes(old_frontier)

    def test_empty_window_and_later_growth_and_durability(self):
        s, c, f = self.session(holders=0)
        f.data_rows = lambda *args, **kwargs: []
        run_window(s, 1, PLAN['base'], self.exchange(s, f), {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')})
        self.assertTrue(audit_window(s.root, 1, PLAN, s.state)['complete'])
        a, clock, fixture = self.session(holders=1150)
        transport = fixture.__call__
        count = 0

        def slow(path, deadline, storage):
            nonlocal count
            q = strict_json(path.read_bytes())['job']
            if q['kind'] == 'changes' and q['family'] == 'tokenHolders' and (q['phase'] == 'data'):
                count += 1
                if count == 1:
                    clock.n += 11
            return transport(path, deadline, storage)
        a.transport = slow
        run_window(a, 1, PLAN['base'], self.exchange(a, fixture), {k: set() for k in ('tokenHolders', 'stakeStarts', 'parents')})
        pages = [q for q in fixture.queries if q['kind'] == 'changes' and q['family'] == 'tokenHolders' and (q['phase'] == 'data')]
        self.assertEqual([q['first'] for q in pages], [100] * 10 + [500, 500])
        d, dc, df = self.session()
        put = d.storage.json

        def durable(*args, **kwargs):
            put(*args, **kwargs)
            if str(args[0]).endswith('capture.json'):
                dc.n += 2
        d.storage.json = durable
        q = make_job(PLAN, 1, 'meta', pin=PLAN['base'])
        d.request(q)
        d.request(q)
        audit_captures(d.root, PLAN, d.state)
if __name__ == '__main__':
    unittest.main()
