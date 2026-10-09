"""Synthetic actual serial client, page captures, strict auditor; no network or subprocess."""
import sys, os, time, unittest, tempfile, socket, subprocess, json
from pathlib import Path
W = Path(__file__).resolve().parents[2]
R = Path(os.environ['HDD_TASK_ROOT'])

def forbidden(*a, **k):
    raise AssertionError('Offline network/child forbidden')
socket.getaddrinfo = socket.create_connection = socket.socket.connect = subprocess.Popen = forbidden
sys.path[:0] = [str(W / 'scripts/protocol-feed'), str(W / 'scripts/market-refresh')]
from durable import strict_json, encode, digest
from protocol import *
from session import ProtocolSession
from collector import run_cycles
from audit import audit_round, audit_captures, qualify
from capture_client import Stop, LimitReached

class Clock:

    def __init__(self):
        self.n = 0
        self.waits = []

    def __call__(self):
        return self.n

    def sleep(self, n):
        self.n += n
        self.waits.append(n)

class Transport:

    def __init__(self, replies=None, drift=None, new=2):
        self.replies = iter(replies) if replies is not None else None
        self.queries = []
        self.drift = drift
        self.new = new
        self.timestamp = int(time.time()) - 30

    def __call__(self, path, deadline, storage):
        q = strict_json(path.read_bytes())['job']
        self.queries.append(q)
        status=200
        if self.replies is not None:
            v = next(self.replies)
            if isinstance(v,tuple):status,v=v
            if v in ('timeout', 'network', 'unknown'):
                return {'childReaped': v != 'unknown', 'connectionClosed': v != 'unknown', 'complete': False, 'failureKind': 'transport_timeout' if v == 'timeout' else v}
            raw = v if isinstance(v, bytes) else encode(v)
        else:
            m, p, c, ep = (q['method'], q['params'], q['cycle'], q['endpoint'])
            n = 27720900 + c * 10
            t = self.timestamp + c
            k = kind(q)
            d = 2498 + self.new

            def packed(day):
                return BASE_TAIL[day - 2496] if day < 2498 else str((1234567890123 << 72) + 987654321 + day)
            if m == 'eth_chainId':
                v = '0x171'
            elif m == 'eth_getBlockByNumber':
                n = n + 2 if p[0] == 'latest' else int(p[0], 16)
                v = {'number': hex(n), 'hash': '0x' + word(n), 'parentHash': '0x' + word(n - 1), 'timestamp': hex(t), 'transactions': []}
                if self.drift == 'header' and q['phase'] == 'close':
                    v['hash'] = '0x' + 'a' * 64
            elif m == 'eth_getCode':
                v = strict_json((R / 'method-reference/accepted-ledger/captures/003-pulsechainOfficial-code.response.body').read_bytes())['result']
            elif k == 'global':
                w = [10000000000, 12000000000000, 123456, 0, d, 99000000000000, 0, 0, 0, 0, t, 90000000000, 0]
                if self.drift == 'global' and q['phase'] == 'close-global':
                    w[9] = 1
                v = '0x' + ''.join((word(x) for x in w))
            elif k == 'supply':
                v = '0x' + word(90000000000)
            elif k == 'range':
                data = p[0]['data'][10:]
                a, b = (int(data[:64], 16), int(data[64:], 16))
                w = [int(packed(i)) for i in range(a, b)]
                if self.drift == 'overlap':
                    w[0] += 1
                v = '0x' + ''.join((word(x) for x in [32, b - a, *w]))
            elif k == 'daily':
                v = '0x' + ''.join((word(int(x)) for x in unpack(int(packed(int(p[0]['data'][10:], 16))))))
            raw = encode({'jsonrpc': '2.0', 'id': 1, 'result': v})
        (path.parent / 'response.body').write_bytes(raw)
        return {'status': status, 'complete': True, 'framingValidated': True, 'connectionClosed': True, 'childReaped': True, 'headers': [['Content-Length', str(len(raw))]], 'expectedBodyBytes': len(raw), 'framingKind': 'content-length', 'wireBodyBytes': len(raw), 'wireBodySha256': digest(raw)}

class Tests(unittest.TestCase):

    def session(self, tr):
        d = R / 'evidence/fixtures'
        d.mkdir(exist_ok=True)
        p = Path(tempfile.mkdtemp(prefix='protocol-', dir=d))
        c = Clock()
        return (ProtocolSession(p, tr, c, c.sleep, True), c)

    def test_composed_three_cycles(self):
        s, c = self.session(Transport())
        result = run_cycles(s, 3, lambda m, d: {'ok': True, 'cycle': m['cycle']})
        s.close('synthetic complete')
        self.assertEqual(result['appendedDays'], 2)
        self.assertEqual(s.state['attempts'], 50)
        samples = []
        for n in range(1, 4):
            sample = strict_json((s.root / f'ROUND_{n}_SAMPLE.json').read_bytes())
            proof, u = audit_round(s.root, sample, s.state)
            samples.append({'sample': sample, 'proof': proof, 'update': u})
            self.assertEqual(len(u['ledgerAppend']['words']), 2 if n == 1 else 0)
        (R / f'evidence/SYNTHETIC_PROTOCOL_{s.root.name}.json').write_bytes(encode({'status': 'PASS', 'synthetic': True, 'root': str(s.root), 'samples': samples, 'accounting': s.state, 'externalRequests': 0}))

    def test_one_none_and_controls(self):
        for new in (0, 1):
            s, c = self.session(Transport(new=new))
            run_cycles(s, 1, lambda m, d: {'ok': True, 'cycle': m['cycle']})
            s.close('synthetic')
            self.assertEqual(s.state['attempts'], 18 if new == 0 else 20)
        for drift in ('header', 'global', 'overlap'):
            s, c = self.session(Transport(drift=drift))
            with self.assertRaises((Stop, ValueError)):
                run_cycles(s, 3, lambda m, d: {'ok': True, 'cycle': m['cycle']})
            self.assertFalse((s.root / 'ROUND_1_UPDATE.json').exists())
            self.assertFalse((s.root / 'CYCLE_2_BINDING.json').exists())
            s.close('synthetic rejected')

    def test_exact_32_33_padding_and_day(self):
        pin = {'number': 27720900, 'hash': '0x' + 'a' * 64, 'timestamp': 1575331200 + 2600 * 86400}
        g = ['0'] * 13
        g[2] = '1'
        g[4] = '2530'
        g[10] = str(pin['timestamp'])
        suffix = ['0'] * 32
        r, a = qualify_values(pin, [g, g], [['0'], ['0']], [BASE_TAIL + suffix] * 2, 2498, BASE_TAIL, {2498: [['0'] * 3] * 2, 2529: [['0'] * 3] * 2})
        self.assertEqual(len(a['words']), 32)
        g[4] = '2531'
        with self.assertRaises(ValueError):
            qualify_values(pin, [g, g], [['0'], ['0']], [BASE_TAIL + suffix] * 2, 2498, BASE_TAIL, {})
        with self.assertRaises(ValueError):
            unpack(1 << 200)
        q = job(0, 'eth_call', call('range', pin['hash'], 2496, 2498), 1, 'range')
        with self.assertRaises(ValueError):
            validate_rpc(q, {'jsonrpc': '2.0', 'id': 1, 'result': '0x' + ''.join((word(x) for x in [64, 2, 0, 0]))})

    def test_retries_unknown_terminal_budgets(self):
        q = job(0, 'eth_chainId', [])
        ok = {'jsonrpc': '2.0', 'id': 1, 'result': '0x171'}
        s, c = self.session(Transport(['timeout', 'network', ok]))
        s.request(q)
        self.assertEqual(s.state['extraAttempts'], 2)
        self.assertIn(5, c.waits)
        self.assertIn(15, c.waits)
        audit_captures(s.root, s.state)
        s.close('synthetic')
        for value in ['unknown', b'{"jsonrpc":"2.0","id":1,"id":1,"result":"0x171"}', {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -1, 'message': 'arbitrary'}}]:
            s, c = self.session(Transport([value]))
            with self.assertRaises(Stop):
                s.request(q)
            self.assertEqual(s.state['attempts'], 1)
            self.assertEqual(s.state['extraAttempts'], 0)
            if value == 'unknown':
                self.assertIsNotNone(s.state['pending'])
                self.assertEqual(s.state['chargedBytes'], 4096)
            s.close('synthetic terminal')
        s, c = self.session(Transport())
        c.n = 1620
        with self.assertRaises(LimitReached):
            s.request(q)
        self.assertEqual(s.state['attempts'], 0)
        s.close('synthetic cutoff')

    def test_original_witness(self):
        for name in ('004-pulsechainOfficial-global', '008-g4mm4Pulsechain-global'):
            raw = strict_json((R / f'method-reference/accepted-ledger/captures/{name}.response.body').read_bytes())
            values = words(raw['result'], 13)
            self.assertEqual(values[4], 2498)
            self.assertEqual(values[10], 1791215285)

    def test_http_rpc_error_is_terminal(self):
        q=job(0,'eth_chainId',[])
        for code in (-32601,-32000):
            s,c=self.session(Transport([(503,{'jsonrpc':'2.0','id':1,'error':{'code':code,'message':'mandatory method rejected'}})]))
            with self.assertRaises(Stop):s.request(q)
            self.assertEqual(s.state['attempts'],1);self.assertEqual(s.state['extraAttempts'],0)
            audit_captures(s.root,s.state);s.close('synthetic HTTP/RPC terminal')
        s,c=self.session(Transport([(503,{'message':'temporary gateway failure'}),{'jsonrpc':'2.0','id':1,'result':'0x171'}]))
        s.request(q);self.assertEqual(s.state['extraAttempts'],1);audit_captures(s.root,s.state);s.close('synthetic known gateway')

    def test_saved_physical_order_and_seal(self):
        import copy
        s,c=self.session(Transport());run_cycles(s,1,lambda m,d:{'ok':True,'cycle':m['cycle']})
        sample=strict_json((s.root/'ROUND_1_SAMPLE.json').read_bytes());captures,_=audit_captures(s.root,s.state)
        bad=copy.deepcopy(sample);bad['sealedAt']=captures[1][0]['startedAt']
        with self.assertRaisesRegex(ValueError,'Seal before'):qualify(bad,captures,2498,BASE_TAIL)
        bad=copy.deepcopy(sample); altered=copy.deepcopy(captures)
        a,b=bad['calls']['range0'],bad['calls']['close-global0']
        altered[a],altered[b]=altered[b],altered[a]
        bad['calls']['range0'],bad['calls']['close-global0']=b,a
        with self.assertRaisesRegex(ValueError,'physical'):qualify(bad,altered,2498,BASE_TAIL)
        s.close('synthetic auditor negatives')
if __name__ == '__main__':
    unittest.main()
