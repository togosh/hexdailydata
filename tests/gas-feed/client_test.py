"""Actual gas client/collector/auditor, fully injected; network and child launch forbidden."""
import sys, os, json, unittest, tempfile, socket, subprocess, time, hashlib
from pathlib import Path
W = Path(__file__).resolve().parents[2]
R = Path(os.environ['HDD_TASK_ROOT'])

def forbidden(*a, **k):
    raise AssertionError('Offline network/child forbidden')
socket.getaddrinfo = forbidden
socket.create_connection = forbidden
socket.socket.connect = forbidden
subprocess.Popen = forbidden
sys.path[:0] = [str(W / 'scripts/gas-feed'), str(W / 'scripts/market-refresh')]
from durable import strict_json, encode, digest
from protocol import *
from session import GasSession
from collector import run_cycles
from capture_client import Stop, LimitReached
from audit import audit_round, audit_captures

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

    def __init__(self, replies=None, unsupported=False, drift=False, optional_missing=False, receipt_drift=False):
        self.replies = iter(replies) if replies is not None else None
        self.queries = []
        self.unsupported = unsupported
        self.drift = drift
        self.optional_missing = optional_missing
        self.receipt_drift = receipt_drift
        self.timestamp = int(time.time()) - 20

    def __call__(self, path, deadline, storage):
        q = strict_json(path.read_bytes())['job']
        self.queries.append(q)
        if self.replies is not None:
            v = next(self.replies)
            if v == 'timeout':
                return {'childReaped': True, 'connectionClosed': True, 'complete': False, 'failureKind': 'transport_timeout'}
            if v == 'unknown':
                return {'childReaped': False, 'connectionClosed': False, 'complete': False}
            if isinstance(v, bytes):
                raw = v
            else:
                raw = encode(v)
        else:
            m = q['method']
            p = q['params']
            ep = q['endpoint']
            n = 27720900 + q['cycle'] * 10
            if m == 'eth_chainId':
                v = '0x171'
            elif m == 'eth_getBlockByNumber':
                n = n + 2 if p[0] == 'latest' else int(p[0], 16)
                v = {'number': hex(n), 'hash': '0x' + format(n, '064x'), 'parentHash': '0x' + format(n - 1, '064x'), 'timestamp': hex(self.timestamp + q['cycle']), 'baseFeePerGas': '0x3e8', 'gasUsed': '0x5208', 'gasLimit': '0x1c9c380', 'transactions': ['0x' + 'a' * 64], 'legitimateExtraField': None}
                if self.drift and q['phase'] == 'close':
                    v['baseFeePerGas'] = '0x3e9'
                if self.optional_missing and q['phase'] == 'close':
                    for field in ('baseFeePerGas', 'gasUsed', 'gasLimit'):
                        v.pop(field)
            elif m == 'eth_gasPrice':
                v = hex(1100 + ep * 200 + q['cycle'])
            elif m == 'eth_maxPriorityFeePerGas':
                v = '0x0'
            elif m == 'eth_feeHistory':
                v = {'oldestBlock': hex(int(p[1], 16) - 1), 'baseFeePerGas': ['0x3e8', '0x3e8', '0x3e9'], 'gasUsedRatio': [0.4, 0.5], 'reward': [['0x0', '0x1', '0x2']] * 2}
            else:
                v = {'hash': '0x' + 'a' * 64, 'transactionHash': '0x' + 'a' * 64, 'blockHash': '0x' + format(n, '064x'), 'blockNumber': hex(n), 'transactionIndex': '0x0', 'gasUsed': '0x5208', 'effectiveGasPrice': '0x44c'}
                if ep == 1 and m == 'eth_getTransactionReceipt':
                    if self.optional_missing:
                        v.pop('gasUsed'); v.pop('effectiveGasPrice')
                    if self.receipt_drift:
                        v['gasUsed'] = '0x5209'
            reply = {'jsonrpc': '2.0', 'id': 1, 'result': v}
            if self.unsupported and m == 'eth_maxPriorityFeePerGas' and (ep == 1):
                reply = {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32601, 'message': 'Method not found'}}
            raw = encode(reply)
        (path.parent / 'response.body').write_bytes(raw)
        return {'status': 200, 'complete': True, 'framingValidated': True, 'connectionClosed': True, 'childReaped': True, 'headers': [['Content-Length', str(len(raw))]], 'expectedBodyBytes': len(raw), 'framingKind': 'content-length', 'wireBodyBytes': len(raw), 'wireBodySha256': digest(raw)}

class Tests(unittest.TestCase):

    def session(self, tr):
        d = R / 'evidence/fixtures'
        d.mkdir(exist_ok=True)
        root = Path(tempfile.mkdtemp(prefix='gas-', dir=d))
        c = Clock()
        return (GasSession(root, tr, c, c.sleep, True), c)

    def test_composed_three_cycles_unequal_suggestions_optional_skips_short_history(self):
        tr = Transport(unsupported=True)
        s, c = self.session(tr)
        result = run_cycles(s, 3, lambda m, d: {'ok': True, 'cycle': m['cycle']})
        s.close('synthetic complete')
        self.assertEqual(result['rounds'], 3)
        self.assertEqual(s.state['attempts'], 36)
        self.assertEqual(sum((q['method'] == 'eth_maxPriorityFeePerGas' and q['endpoint'] == 1 for q in tr.queries)), 1)
        samples = []
        for n in range(1, 4):
            sample = strict_json((s.root / f'ROUND_{n}_SAMPLE.json').read_bytes())
            proof, u = audit_round(s.root, sample, s.state)
            self.assertEqual(u['readings'][0]['gasPriceWei'], str(1100 + n))
            self.assertEqual(u['readings'][0]['priorityFeeWei'], '0')
            if n == 1:
                self.assertEqual(proof['details']['feeHistory'][0]['minedBlocks'], 2)
                self.assertEqual(proof['details']['feeHistory'][0]['predictedNextBaseFee'], '1001')
            samples.append({'sample': sample, 'proof': proof, 'update': u})
        target = R / f'evidence/SYNTHETIC_GAS_{s.root.name}.json'
        with target.open('xb') as f:
            f.write(encode({'status': 'PASS', 'synthetic': True, 'root': str(s.root), 'samples': samples, 'accounting': s.state, 'externalRequests': 0}))

    def test_quantities_optional_and_midnight(self):
        for bad in ['0x00', '-1', '1.1', '0x' + 'f' * 65, 1, None]:
            with self.assertRaises(ValueError):
                quantity(bad)
        self.assertEqual(quantity('0x' + 'f' * 64), 2 ** 256 - 1)
        context = {'timestamp': int(instant('2026-10-08T23:59:59Z').timestamp()), 'baseFeePerGas': '0'}
        r = gas_reading('123', '0', context, '2026-10-09T00:00:01Z', '2026-10-09T00:00:03Z')
        self.assertEqual(r['baseFeeWei'], None)
        self.assertEqual(r['priorityFeeWei'], '0')
        self.assertEqual(r['observedAtUtc'], '2026-10-09T00:00:01Z')
        r = gas_reading('123', '0', context, '2026-10-08T23:59:58Z', '2026-10-09T00:00:01Z')
        self.assertEqual(r['baseFeeWei'], '0')
        self.assertIsNone(r['priorityFeeWei'])
        q = job(0, 'eth_maxPriorityFeePerGas', [], 1, 'sample')
        self.assertEqual(validate_rpc(q, {'jsonrpc': '2.0', 'id': 1, 'result': '-1'})['capability'], 'rejected')
        for bad in [{'jsonrpc': '2.0', 'id': 1, 'error': {}, 'result': '0x0'}, {'jsonrpc': '2.0', 'id': 2, 'result': '0x0'}]:
            with self.assertRaises(ValueError):
                validate_rpc(q, bad)
        self.assertFalse(validate_rpc(job(0, 'eth_getTransactionReceipt', ['0x' + 'a' * 64], 1, 'witness'), {'jsonrpc': '2.0', 'id': 1, 'result': None})['available'])
        self.assertEqual(denomination_witness()['executionCostRaw'], '540508413939399861632')

    def test_retry_accounting_and_terminal_unknown(self):
        q = job(0, 'eth_chainId', [])
        s, c = self.session(Transport(['timeout', {'jsonrpc': '2.0', 'id': 1, 'result': '0x171'}]))
        cap, v = s.request(q)
        self.assertEqual(v, 369)
        self.assertEqual(s.state['extraAttempts'], 1)
        self.assertEqual(s.state['rpcEndpointExtraAttempts'], [1, 0])
        self.assertIn(5, c.waits)
        self.assertGreaterEqual(s.state['chargedBytes'], 16384)
        audit_captures(s.root, s.state)
        s, c = self.session(Transport(['timeout', 'timeout', {'jsonrpc': '2.0', 'id': 1, 'result': '0x171'}]))
        s.request(q)
        self.assertEqual(s.state['extraAttempts'], 2)
        self.assertIn(15, c.waits)
        audit_captures(s.root, s.state)
        optional = job(0, 'eth_maxPriorityFeePerGas', [], 1, 'sample')
        s, c = self.session(Transport([{'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32000, 'message': 'payment required'}}]))
        with self.assertRaises(Stop):
            s.request(optional)
        self.assertEqual(s.state['attempts'], 1)
        for reply in ['unknown', b'{"jsonrpc":"2.0","id":1,"id":1,"result":"0x171"}', {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -1, 'message': 'arbitrary'}}]:
            s, c = self.session(Transport([reply]))
            with self.assertRaises(Stop):
                s.request(q)
            self.assertEqual(s.state['attempts'], 1)
            self.assertEqual(s.state['extraAttempts'], 0)
            if reply == 'unknown':
                self.assertIsNotNone(s.state['pending'])
                self.assertEqual(s.state['chargedBytes'], 16384)

    def test_scope_caps_drift_and_no_outer_retry(self):
        for q in [dict(job(0, 'eth_chainId', []), endpoint=2), dict(job(0, 'eth_chainId', []), method='eth_call')]:
            with self.assertRaises(ValueError):
                validate_job(q)
        s, c = self.session(Transport())
        c.n = 1080
        with self.assertRaises(LimitReached):
            s.request(job(0, 'eth_chainId', []))
        self.assertEqual(s.state['attempts'], 0)
        s, c = self.session(Transport(drift=True))
        with self.assertRaises((Stop, ValueError)):
            run_cycles(s, 3, lambda m, d: {'ok': True, 'cycle': m['cycle']})
        self.assertFalse((s.root / 'ROUND_1_UPDATE.json').exists())
        self.assertFalse((s.root / 'CYCLE_2_BINDING.json').exists())

    def test_optional_missingness_is_not_identity_drift(self):
        s, c = self.session(Transport(optional_missing=True))
        result = run_cycles(s, 1, lambda m, d: {'ok': True, 'cycle': m['cycle']})
        self.assertEqual(result['rounds'], 1)
        sample = strict_json((s.root / 'ROUND_1_SAMPLE.json').read_bytes())
        proof, update = audit_round(s.root, sample, s.state)
        self.assertIsNone(proof['details']['witnesses'][1]['receipt']['gasUsed'])
        self.assertEqual(len(proof['details']['executionCostExamples']), 1)
        s, c = self.session(Transport(receipt_drift=True))
        with self.assertRaisesRegex(ValueError, 'execution mismatch'):
            run_cycles(s, 1, lambda m, d: {'ok': True, 'cycle': m['cycle']})
        self.assertFalse((s.root / 'ROUND_1_UPDATE.json').exists())
if __name__ == '__main__':
    unittest.main()
