"""Narrow unchanged market-policy consumers of the shared physical capture hooks."""
import sys, os, tempfile, socket, subprocess, unittest
from pathlib import Path
W = Path(__file__).resolve().parents[2]
R = Path(os.environ['HDD_TASK_ROOT'])

def forbidden(*a, **k):
    raise AssertionError('External dispatch forbidden')
socket.getaddrinfo = forbidden
socket.socket.connect = forbidden
subprocess.Popen = forbidden
sys.path[:0] = [str(W / 'scripts/market-refresh')]
from durable import encode, digest, strict_json
from capture_client import Session, Stop, WorkerTransport
from task_queries import rpc_job, graph_job, SCOPE

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

    def __init__(self, answers, status=200):
        self.answers = iter(answers)
        self.status = status

    def __call__(self, path, deadline, storage):
        raw = encode(next(self.answers))
        (path.parent / 'response.body').write_bytes(raw)
        return {'status': self.status, 'complete': True, 'framingValidated': True, 'childReaped': True, 'connectionClosed': True, 'headers': [['Content-Length', str(len(raw))]], 'expectedBodyBytes': len(raw), 'wireBodyBytes': len(raw), 'framingKind': 'content-length', 'wireBodySha256': digest(raw)}

class Tests(unittest.TestCase):

    def make(self, tr):
        d = Path(tempfile.mkdtemp(prefix='market-hooks-', dir=R / 'scratch'))
        c = Clock()
        return (Session(d, tr, c, c.sleep, True), c)

    def test_original_rpc_no_retry_and_graph_retry(self):
        q = rpc_job(0, 'eth_chainId', [])
        s, c = self.make(Transport([{'jsonrpc': '2.0', 'id': 1, 'result': '0x171'}]))
        cap, value = s.request(q)
        self.assertEqual(value, 369)
        self.assertEqual(cap['segment'], 'MARKET_REFRESH')
        self.assertEqual(s.request_seconds, 30)
        s, c = self.make(Transport([{'error': 'unavailable'}], 503))
        with self.assertRaises(Stop):
            s.request(q)
        self.assertEqual(s.state['attempts'], 1)
        meta = {'deployment': SCOPE['expectedDeployments'][0], 'hasIndexingErrors': False, 'block': {'number': 27760000, 'hash': None, 'timestamp': None}}
        s, c = self.make(Transport([{'errors': [{'message': 'Store error: database unavailable'}]}, {'errors': [{'message': 'Store error: store error: unnamed prepared statement does not exist'}]}, {'data': {'_meta': meta}}]))
        s.request(graph_job('meta', 0, pin=None, deployment=meta['deployment']))
        self.assertEqual(s.state['extraAttempts'], 2)
        self.assertIn(15, c.waits)
        self.assertIn(60, c.waits)

    def test_default_physical_worker_not_gas(self):
        worker = WorkerTransport('synthetic', popen=forbidden)
        self.assertEqual(worker.worker_path, W / 'scripts/market-refresh/http_worker.py')
if __name__ == '__main__':
    unittest.main()
