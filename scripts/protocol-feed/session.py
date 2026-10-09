"""Protocol policy over the maintained serial capture/physical worker implementation."""
import time
from capture_client import Session as CaptureSession, Stop, LimitReached
from protocol import validate_job, validate_rpc, capacity, objects
from durable import strict_json

class ProtocolSession(CaptureSession):
    job_validator = staticmethod(validate_job)
    capacity = staticmethod(capacity)
    rpc_validator = staticmethod(validate_rpc)
    object_counter = staticmethod(objects)
    request_seconds = 20
    native_reserve = 60
    segment_label = 'HEX_PROTOCOL'

    def __init__(self, root, transport, clock=time.monotonic, sleep=time.sleep, synthetic=False):
        super().__init__(root, transport, clock, sleep, synthetic)
        self.deadline = self.started + 1800
        self.storage.limit = 1024 ** 3
        self.state.update(retryPolicyVersion='HEX_PROTOCOL_R1', rpcEndpointExtraAttempts=[0, 0], retryPolicy={'maximumAfterInitialPerLogicalPage': 2, 'maximumExtraAttemptsSession': 12, 'maximumExtraAttemptsEndpoint': 6, 'minimumDelaysSeconds': [5, 15]})
        self.persist()

    def dispatch_cutoff(self):
        return 1710 if self.closing else 1620

    def reserve_extra(self, q, is_retry):
        if is_retry:
            self.state['rpcEndpointExtraAttempts'][q['endpoint']] += 1

    def liabilities(self, q, remaining):
        return [q] * remaining + [c for control in self.controls for c in [control] * 3]

    def phase_check(self, q, tail, delay=0):
        now = self.clock() + delay
        finish = now + (len(tail) + 1) * 21 + 20 + len(self.controls) * 20 + 30 + 2
        if now + 20 >= self.started + self.dispatch_cutoff() or finish >= self.started + 1740:
            raise LimitReached('Protocol data/control/publication/native closure time reserve')

    def budget(self, q, tail, cutoff=None, is_retry=False):
        s = self.state
        allq = [q, *tail]
        if self.closed or self.failed or s['pending'] is not None:
            raise Stop('Closed/uncertain protocol session')
        if s['attempts'] + len(allq) > 72:
            raise LimitReached('Protocol attempt reserve')
        for ep in (0, 1):
            jobs = [j for j in allq if j['endpoint'] == ep]
            if s['rpcEndpointAttempts'][ep] + len(jobs) > 36:
                raise LimitReached('Protocol endpoint attempts')
        extras = sum((j is q for j in tail)) + int(is_retry)
        if s['extraAttempts'] + extras + 2 * len(self.controls) > 12:
            raise LimitReached('Protocol shared retry reserve')
        for ep in (0, 1):
            liability = (extras if q['endpoint'] == ep else 0) + 2 * sum((c['endpoint'] == ep for c in self.controls))
            if s['rpcEndpointExtraAttempts'][ep] + liability > 6:
                raise LimitReached('Protocol endpoint retry reserve')
        if s['chargedBytes'] + sum((capacity(j) for j in allq)) > 16 * 1024 ** 2:
            raise LimitReached('Protocol charged wire body reserve')
        if s['chargedEntities'] + sum((j['maxRows'] for j in allq)) > 20000:
            raise LimitReached('Protocol object reserve')
        self.phase_check(q, tail)
        self.storage.check(2 * sum((capacity(j) for j in allq)) + 262144, acquisition=True)

    def retry_allowed(self, q, cap, special, veto):
        if not cap['usable'] and cap.get('complete') and (not cap.get('parseError')):
            parsed = strict_json((self.root / f"captures/{cap['attempt']:05d}/response.body").read_bytes())
            if isinstance(parsed, dict) and ('jsonrpc' in parsed or 'error' in parsed):
                cap['rpcEnvelopeRetryVeto'] = True
                return False
        return bool(not cap['usable'] and (not veto) and cap['closureKnown'] and cap.get('closedWithinDeadline') and (cap.get('failureKind') in ('transport_timeout', 'network') or (cap.get('complete') and cap.get('status') in (502, 503, 504))))

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
            raise Stop('Exact protocol query exhausted recognized retries')
        except BaseException:
            self.failed = True
            raise
