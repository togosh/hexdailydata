"""Synthetic only: actual collector, native ownership and HTTP framing paths.
No socket/DNS is permitted; Node validators execute locally against injected bodies.
"""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import importlib.util, io, json, socket, subprocess, types, unittest, hashlib
from unittest.mock import patch
W = Path(__file__).resolve().parents[2]
R = Path(sys.argv[1])
suffix = sys.argv[2] if len(sys.argv) > 2 else ''
O = R / 'evidence' / ('transport-fixtures' + suffix)
O.mkdir()

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
c = load('candidate_collector', W / 'scripts/benchmark-reference/collector.py')
g = load('candidate_worker', W / 'scripts/benchmark-reference/get_worker.py')

def deny(*a, **k):
    raise AssertionError('TEST NETWORK DENIED')
socket.getaddrinfo = deny
socket.create_connection = deny
socket.socket = deny
S = json.loads((R / 'SCOPE.json').read_text())
results = []

def save(p, v):
    p.write_text(json.dumps(v, indent=2) + '\n', encoding='utf-8')

def connection(raw):

    class Socket:

        def makefile(self, *a, **k):
            return io.BytesIO(raw)

    class Conn:

        def __init__(self, *a, **k):
            self.closed = False

        def request(self, method, path, headers):
            assert method == 'GET' and path.startswith('/api/v2/ohlc/')
            assert headers['Accept-Encoding'] == 'identity'
            assert set(headers) == {'Accept', 'Accept-Encoding', 'User-Agent', 'Connection'}

        def getresponse(self):
            r = self.response_class(Socket())
            r.begin()
            return r

        def close(self):
            self.closed = True
    return Conn

def response(body, status=200, headers=None):
    h = headers if headers is not None else [('Content-Length', str(len(body)))]
    return ('HTTP/1.1 ' + str(status) + ' Synthetic\r\n' + ''.join((k + ': ' + v + '\r\n' for k, v in h)) + '\r\n').encode() + body

def candles(q, shift=0, empty=False):
    start = q['query'].get('start', q['query'].get('end', 0) - (q['query']['limit'] - 1) * q['query']['step'])
    rows = [] if empty else [{'timestamp': str(start + (i + shift) * q['query']['step']), 'open': '2.00', 'high': '4', 'low': '1', 'close': '3', 'volume': '0'} for i in range(q['query']['limit'])]
    return json.dumps({'data': {'pair': q['expectedMarket'], 'ohlc': rows}}).encode()

def owner(reaped=True, timeout=False, interrupted=None):
    return {'reaped': reaped, 'timeout': timeout, 'interrupted': interrupted, 'exit': 0 if not timeout else -9, 'seconds': 1, 'stdout': '', 'stderr': ''}

class Tests(unittest.TestCase):

    def test_worker_bounds_and_framing(self):
        cases = [('complete', response(b'{}'), True), ('chunked', response(b'2\r\n{}\r\n0\r\n\r\n', headers=[('Transfer-Encoding', 'chunked')]), True), ('truncated', response(b'x', headers=[('Content-Length', '2')]), False), ('oversize', response(b'', headers=[('Content-Length', str(1048577))]), False), ('both-framing', response(b'{}', headers=[('Content-Length', '2'), ('Transfer-Encoding', 'chunked')]), False), ('header-cap', response(b'{}', headers=[('X-Test' + str(i), 'x' * 3000) for i in range(24)]), False)]
        for name, raw, ok in cases:
            d = O / name
            d.mkdir()
            g.perform(S['network']['normalRequests'][0]['url'], d, connection(raw))
            r = json.loads((d / 'response.json').read_text())
            self.assertEqual(r['complete'], ok, name)
            self.assertTrue(r['connectionClosed'])
            self.assertLessEqual(r.get('headerBytes', 0), 65536)
            if ok:
                charge = c.verify_framing(r, (d / 'response.body').read_bytes(), 1048576, (d / 'response.framing').read_bytes() if (d / 'response.framing').exists() else None)
                self.assertEqual(charge, len(raw) - r['headerBytes'])
        results.append('actual worker: header/body/framing bounds, complete/chunked/truncated capture')

    def scenario(self, name, modes, shift=0, elapsed=0):
        root = O / name
        root.mkdir()
        (root / 'temp').mkdir()
        scope = json.loads(json.dumps(S))
        scope['local']['taskOutputRoot'] = str(root)
        save(root / 'SCOPE.json', scope)
        save(root / 'PREFLIGHT.json', {'verdict': 'PASS', 'bindings': {}, 'synthetic': True})
        clock = [0.0]
        starts = []
        queries = []
        real_native = c.native

        def native(args, env, wait=27, reap=2):
            if args[0] == 'node':
                return real_native(args, env, wait, reap)
            d = Path(args[-2]).parent
            q = json.loads((d / 'request.json').read_text())['logical']
            queries.append(q)
            starts.append(clock[0])
            clock[0] += 1
            mode = modes.pop(0) if modes else 'ok'
            if mode in ('timeout', 'uncertain', 'interrupt'):
                return owner(mode != 'uncertain', mode == 'timeout', 'TimeoutExpired' if mode == 'timeout' else 'KeyboardInterrupt')
            raw = response(candles(q, shift, mode == 'empty')) if mode == 'ok' or mode == 'empty' else response(b'error', int(mode))
            g.perform(q['url'], d, connection(raw))
            if mode == 'tamper':
                raise AssertionError('unreachable')
            if elapsed:
                clock[0] += elapsed
            return owner()
        with patch.object(c, 'native', native), patch.object(c, 'time', types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda t: clock.__setitem__(0, clock[0] + t))):
            rc = c.run(root)
        a = json.loads((root / 'session/ACCOUNTING.json').read_text())
        self.assertEqual(a['attempts'], len(starts))
        self.assertEqual(a['chargedObjects'], sum((q['query']['limit'] for q in queries)))
        self.assertEqual(a['chargedBytes'], sum((r['chargedBytes'] for r in a['requests'])))
        for i in range(1, len(starts)):
            self.assertGreaterEqual(starts[i] - starts[i - 1], 2)
        with self.assertRaises(FileExistsError):
            c.run(root)
        return (a, queries, starts, rc)

    def test_parent_success_and_edges(self):
        a, qs, _, rc = self.scenario('normal', [])
        self.assertEqual((rc, a['attempts'], a['extras']), (0, 8, 0))
        self.assertEqual(qs, S['network']['normalRequests'])
        a, qs, _, rc = self.scenario('edges', [], 1)
        self.assertEqual((rc, a['attempts']), (0, 10))
        self.assertEqual(a['conditionalAssets'], ['BTC', 'ETH'])
        self.assertEqual([q['id'] for q in qs if 'boundary' in q['id']], ['btc-boundary-early', 'eth-boundary-early'])
        a, qs, _, rc = self.scenario('maximum', ['503', 'ok'] * 4, 1)
        self.assertEqual((rc, a['attempts'], a['extras']), (0, 14, 4))
        self.assertLessEqual(a['chargedBytes'], 16777216)
        self.assertLessEqual(a['chargedObjects'], 14000)
        results.append('actual serial parent + Node page validator: 8 normal and 10 conditional schedules; exclusive admission')

    def test_parent_failures_retries_and_charges(self):
        a, q, starts, rc = self.scenario('retry', ['503', 'ok'])
        self.assertEqual((rc, a['attempts'], a['extras']), (0, 9, 1))
        self.assertEqual(q[0], q[1])
        self.assertGreaterEqual(starts[1] - starts[0], 3)
        a, q, _, rc = self.scenario('timeout', ['timeout', 'ok'])
        self.assertEqual(rc, 0)
        self.assertEqual(a['requests'][0]['chargedBytes'], 1114112)
        for name, modes, count, extras in [('rate', ['429'], 1, 0), ('redirect', ['302'], 1, 0), ('twice', ['503', '504'], 2, 1), ('four-shared', ['503', 'ok'] * 5, 9, 4), ('empty', ['empty'], 1, 0), ('interrupt', ['interrupt'], 1, 0), ('uncertain', ['uncertain'], 1, 0)]:
            a, q, _, rc = self.scenario(name, modes)
            self.assertEqual(rc, 2, name)
            self.assertEqual((a['attempts'], a['extras']), (count, extras), name)
            self.assertEqual(a['status'], 'STOPPED_UNCERTAIN' if name == 'uncertain' else 'CLOSED', name)
        a, _, _, rc = self.scenario('deadline', [], elapsed=565)
        self.assertEqual((rc, a['attempts']), (2, 1))
        results.append('actual parent: same-URL retries, shared cap, full timeout charges, stop on 429/redirect/empty/interrupt/unknown closure/deadline')

    def test_native_cleanup(self):

        class Child:
            returncode = None

            def __init__(self, error, reap):
                self.error = error
                self.reap = reap
                self.calls = 0
                self.killed = False

            def communicate(self, timeout):
                self.calls += 1
                if self.calls == 1:
                    raise self.error
                if not self.reap:
                    raise subprocess.TimeoutExpired('synthetic', timeout)
                self.returncode = -9
                return (b'', b'')

            def kill(self):
                self.killed = True

            def poll(self):
                return self.returncode
        for error in (subprocess.TimeoutExpired('synthetic', 27), KeyboardInterrupt()):
            for reap in (True, False):
                child = Child(error, reap)
                with patch.object(c.subprocess, 'Popen', return_value=child):
                    r = c.native(['synthetic'], {})
                self.assertEqual(r['reaped'], reap)
                self.assertTrue(child.killed)
                self.assertEqual(child.calls, 2)
        results.append('actual native owner: timeout and interrupt kill/reap, unknown closure retained')

    def test_binding_and_parameter_refusal(self):
        root = O / 'binding-refusal'
        root.mkdir()
        scope = json.loads(json.dumps(S))
        scope['local']['taskOutputRoot'] = str(root)
        save(root / 'SCOPE.json', scope)
        save(root / 'PREFLIGHT.json', {'verdict': 'PASS', 'bindings': {str(root / 'SCOPE.json'): '0' * 64}})
        with self.assertRaises(AssertionError):
            c.run(root)
        self.assertFalse((root / 'session').exists())
        session = root / 'session'
        session.mkdir()
        d = session / '01'
        d.mkdir()
        q = json.loads(json.dumps(S['network']['normalRequests'][0]))
        q['url'] += '&extra=1'
        save(d / 'request.json', {'logical': q, 'nonce': 'synthetic', 'attempt': 1})
        save(session / 'ADMISSION.json', {'nonce': 'synthetic', 'bindings': {}})
        save(session / 'ACCOUNTING.json', {'status': 'ADMITTED', 'pending': {'request': str(d / 'request.json')}, 'attempts': 1})
        with patch.object(sys, 'argv', ['worker', str(d / 'request.json'), str(root)]), self.assertRaises(AssertionError):
            g.main()
        self.assertFalse((d / 'response.json').exists())
        results.append('actual admission/worker: changed bindings and changed exact URL rejected before HTTP')
suite = unittest.defaultTestLoader.loadTestsFromTestCase(Tests)
run = unittest.TextTestRunner(verbosity=2).run(suite)
save(R / ('evidence/TRANSPORT_TESTS' + suffix + '.json'), {'status': 'PASS' if run.wasSuccessful() else 'FAIL', 'synthetic': True, 'externalRequests': 0, 'tests': run.testsRun, 'cases': results, 'failures': len(run.failures), 'errors': len(run.errors)})
sys.exit(0 if run.wasSuccessful() else 1)
