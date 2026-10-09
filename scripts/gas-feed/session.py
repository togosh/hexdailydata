"""Gas policy over the maintained serial capture/physical worker implementation."""
import time
from capture_client import Session as CaptureSession, Stop, LimitReached
from protocol import validate_job, validate_rpc, capacity, objects

class GasSession(CaptureSession):
    job_validator = staticmethod(validate_job)
    capacity = staticmethod(capacity)
    rpc_validator = staticmethod(validate_rpc)
    object_counter = staticmethod(objects)
    request_seconds = 15
    native_reserve = 60
    segment_label = 'PULSECHAIN_GAS'

    def __init__(self, root, transport, clock=time.monotonic, sleep=time.sleep, synthetic=False):
        super().__init__(root, transport, clock, sleep, synthetic)
        self.deadline = self.started + 1200
        self.storage.limit = 1024 ** 3
        self.state.update(retryPolicyVersion='GAS_R1', rpcEndpointExtraAttempts=[0, 0], retryPolicy={'maximumAfterInitialPerLogicalPage': 2, 'maximumExtraAttemptsSession': 8, 'maximumExtraAttemptsEndpoint': 4, 'minimumDelaysSeconds': [5, 15]})
        self.persist()

    def dispatch_cutoff(self):
        return 1140 if self.closing else 1080

    def reserve_extra(self, q, is_retry):
        if is_retry:
            self.state['rpcEndpointExtraAttempts'][q['endpoint']] += 1

    def liabilities(self, q, remaining):
        return [q] * remaining + [c for control in self.controls for c in [control] * 3]

    def phase_check(self, q, tail, delay=0):
        now = self.clock() + delay
        finish = now + (len(tail) + 1) * 16 + 20 + len(self.controls) * 20 + 30 + 2
        if now + 15 >= self.started + self.dispatch_cutoff() or finish >= self.started + 1140:
            raise LimitReached('Gas data/control/publication/native closure time reserve')

    def budget(self, q, tail, cutoff=None, is_retry=False):
        s = self.state
        allq = [q, *tail]
        if self.closed or self.failed or s['pending'] is not None:
            raise Stop('Closed/uncertain gas session')
        if s['attempts'] + len(allq) > 48:
            raise LimitReached('Gas attempt reserve')
        for ep in (0, 1):
            jobs = [j for j in allq if j['endpoint'] == ep]
            if s['rpcEndpointAttempts'][ep] + len(jobs) > 24:
                raise LimitReached('Gas endpoint attempts')
        extras = sum((j is q for j in tail)) + int(is_retry)
        if s['extraAttempts'] + extras + 2 * len(self.controls) > 8:
            raise LimitReached('Gas shared retry reserve')
        for ep in (0, 1):
            liability = (extras if q['endpoint'] == ep else 0) + 2 * sum((c['endpoint'] == ep for c in self.controls))
            if s['rpcEndpointExtraAttempts'][ep] + liability > 4:
                raise LimitReached('Gas endpoint retry reserve')
        if s['chargedBytes'] + sum((capacity(j) for j in allq)) > 16 * 1024 ** 2:
            raise LimitReached('Gas charged wire body reserve')
        if s['chargedEntities'] + sum((j['maxRows'] for j in allq)) > 50000:
            raise LimitReached('Gas object reserve')
        self.phase_check(q, tail)
        self.storage.check(2 * sum((capacity(j) for j in allq)) + 262144, acquisition=True)

    def retry_allowed(self, q, cap, special, veto):
        return bool(not cap['usable'] and (not veto) and cap['closureKnown'] and cap.get('closedWithinDeadline') and (cap.get('failureKind') == 'transport_timeout' or (cap.get('complete') and cap.get('status') in (502, 503, 504))))

    def request(self, q, optional=False):
        original = self.state['attempts'] + 1
        prior = None
        try:
            for ordinal in range(3):
                tail = self.liabilities(q, 2 - ordinal)
                if ordinal:
                    delay = [5, 15][ordinal - 1]
                    self.phase_check(q, tail, delay)
                    self.sleep(delay)
                cap, data = self.attempt(q, tail, is_retry=ordinal > 0, original=original, prior=prior, retry_index=ordinal)
                if cap['usable']:
                    return (cap, data)
                if not cap['retryable']:
                    raise Stop(cap['stopReason'])
                prior = cap['attempt']
            raise Stop('Exact gas query exhausted recognized retries')
        except BaseException:
            self.failed = True
            raise
