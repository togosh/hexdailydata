"""Reference policy over the maintained physical client and closed RPC retry loop."""
import time, importlib.util
from pathlib import Path
from capture_client import Session as CaptureSession, Stop, LimitReached
from protocol import validate_job, validate_rpc, capacity, objects

# Reuse the already-reviewed finite RPC loop/classifier, not a nested retry loop.
spec = importlib.util.spec_from_file_location('reviewed_protocol_session', Path(__file__).resolve().parents[1] / 'protocol-feed/session.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)

class ReferenceSession(CaptureSession):
    job_validator = staticmethod(validate_job)
    capacity = staticmethod(capacity)
    rpc_validator = staticmethod(validate_rpc)
    object_counter = staticmethod(objects)
    request = previous.ProtocolSession.request
    retry_allowed = previous.ProtocolSession.retry_allowed
    reserve_extra = previous.ProtocolSession.reserve_extra
    maximum_extras = 8
    request_seconds = 30
    native_reserve = 60
    segment_label = 'BTC_ETH_REFERENCE'

    def __init__(self, root, transport, clock=time.monotonic, sleep=time.sleep, synthetic=False, elapsed=0):
        super().__init__(root, transport, clock, sleep, synthetic)
        self.started -= elapsed
        self.deadline = self.started + 1200
        self.storage.limit = 1024**3
        self.state.update(retryPolicyVersion='BTC_ETH_REFERENCE_R1', rpcEndpointExtraAttempts=[0, 0], retryPolicy={'maximumAfterInitialPerLogicalPage': 2, 'maximumExtraAttemptsSession': 8, 'minimumDelaysSeconds': [5, 15]})
        self.persist()

    def dispatch_cutoff(self):
        return 1080

    def liabilities(self, q, remaining):
        # Reserve every mandatory closing request, and one shared pool of at
        # most two control extras (not two extras for each of six controls).
        worst = max(self.controls, key=capacity) if self.controls else None
        reserve = min(2, max(0, 8 - self.state['extraAttempts'] - remaining))
        return [q] * remaining + self.controls[:] + ([worst] * reserve if worst else [])

    def phase_check(self, q, tail, delay=0):
        now = self.clock() + delay
        # 20 seconds exact-query wait liability plus 20 for the shared control
        # retry pool, 30 for publication, 2 native final settlement.
        finish = now + (1 + len(tail)) * 31 + 40 + 32
        if now + 30 >= self.started + 1080 or finish >= self.started + 1080:
            raise LimitReached('Reference mandatory control/publication/closure reserve')

    def budget(self, q, tail, cutoff=None, is_retry=False):
        s, allq = self.state, [q, *tail]
        remaining = sum(j is q for j in tail)
        control_extras = len(tail) - remaining - len(self.controls)
        if self.closed or self.failed or s['pending'] is not None:
            raise Stop('Closed/uncertain reference session')
        if s['attempts'] + len(allq) > 80:
            raise LimitReached('Reference attempts including controls')
        for ep in (0, 1):
            # Shared control retry slots could land on either provider.
            count = (1 + remaining) * (q['endpoint'] == ep) + sum(j['endpoint'] == ep for j in self.controls) + control_extras
            if s['rpcEndpointAttempts'][ep] + count > 40:
                raise LimitReached('Reference endpoint reserve')
        query_extras = sum(j is q for j in tail) + int(is_retry)
        if s['extraAttempts'] + query_extras + control_extras > 8:
            raise LimitReached('Reference shared retry cap')
        if s['chargedBytes'] + sum(map(capacity, allq)) > 12582912 or s['chargedEntities'] + sum(j['maxRows'] for j in allq) > 20000:
            raise LimitReached('Reference bytes/objects including controls')
        self.phase_check(q, tail)
        self.storage.check(2 * sum(map(capacity, allq)) + 262144, acquisition=True)
