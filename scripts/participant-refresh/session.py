"""Finite participant policy over the maintained durable serial transport."""
import time, copy
from capture_client import Session as CaptureSession, Stop, LimitReached
from durable import strict_json
from queries import validate_job, validate_rpc, validate_data, capacity, objects, plan_valid
from retry_schedule import enabled, VERSION, WAITS, COUNTERS, slow_eligible, requirements

class ParticipantSession(CaptureSession):
    capacity = staticmethod(capacity)
    rpc_validator = staticmethod(validate_rpc)
    graph_validator = staticmethod(validate_data)
    object_counter = staticmethod(objects)
    maximum_extras = 100
    request_seconds = 30
    native_reserve = 180
    segment_label = 'PARTICIPANT_REFRESH'

    def __init__(self, root, transport, plan, clock=time.monotonic, sleep=time.sleep, synthetic=False):
        plan_valid(plan)
        self.plan = plan
        self.slow_schedule = enabled(plan)
        self.retry_ordinal = 0
        self.job_validator = lambda q: validate_job(q, self.plan)
        super().__init__(root, transport, clock, sleep, synthetic)
        self.deadline = self.started + 5400
        self.storage.entry_limit = 24000
        self.storage.limit = 4 * 1024 ** 3
        self.state.update(graphExtraAttempts=0, rpcExtraAttempts=0, retryPolicyVersion='HOLDER_R3', retryPolicy={'maximumAfterInitialPerLogicalPage': 2, 'maximumExtraAttemptsSession': 100, 'graphExtras': 88, 'rpcExtras': 12, 'minimumDelaysSeconds': [15, 60]})
        if self.slow_schedule:
            self.state.update(retryScheduleVersion=VERSION, retrySchedule=copy.deepcopy(plan['retry']))
        self.persist()

    def attempt(self, *args, **kwargs):
        cap, data = super().attempt(*args, **kwargs)
        if cap.get('closureKnown'):
            self.last_closed = self.clock()
        return (cap, data)

    def begin_window(self, number):
        if self.clock() - self.started >= 4200:
            raise LimitReached('New window cutoff')
        if number != self.cycle_ordinal + 1 or number > len(self.plan['windows']):
            raise Stop('Window sequence')
        self.cycle_ordinal = number
        self.cycle_started = self.clock()
        self.closing = False

    def dispatch_cutoff(self):
        return 5100

    def reserve_extra(self, q, is_retry):
        if is_retry:
            self.state[('rpc' if q['kind'] == 'rpc' else 'graph') + 'ExtraAttempts'] += 1

    def liabilities(self, q, remaining):
        return [q] * remaining + [item for c in self.controls for item in [c] * 3]

    def phase_check(self, q, tail, delay=0):
        now = self.clock() + delay
        query_waits = sum(WAITS[self.retry_ordinal:2]) if self.slow_schedule else 75
        finish = now + (1 + len(tail)) * 31 + query_waits + 75 * len(self.controls)
        if now + 30 >= self.started + 5100 or finish >= self.started + 5100 or finish + 180 >= self.deadline:
            raise LimitReached('Current-window controls/retries/publication deadline reserve')

    def budget(self, q, tail, cutoff=None, is_retry=False):
        if self.slow_schedule:
            if self.closed or self.failed or self.state['pending'] is not None:
                raise Stop('Closed/uncertain session')
            offset = self.clock() - self.started
            counters = copy.deepcopy({k: self.state[k] for k in COUNTERS})
            try:
                reserved = requirements(q, self.controls, self.retry_ordinal, counters, offset)
            except ValueError as e:
                raise LimitReached(str(e)) from e
            self.storage.check(2 * reserved['bodyBytesReserved'] + 262144, acquisition=True)
            self.storage.json(self.root / 'reservations' / f"{self.state['attempts'] + 1:05d}.json", {
                'scheduleVersion': VERSION, 'attempt': self.state['attempts'] + 1,
                'query': q, 'ordinal': self.retry_ordinal, 'offset': offset,
                'controls': self.controls, 'countersBefore': counters, 'reserved': reserved})
            return
        s = self.state
        jobs = [q, *tail]
        if self.closed or self.failed or s['pending'] is not None:
            raise Stop('Closed/uncertain session')
        if s['attempts'] + len(jobs) > 2248:
            raise LimitReached('Combined attempt reserve')
        for kind, limit, body in [('graph', 2200, 256 * 1024 ** 2), ('rpc', 48, 8 * 1024 ** 2)]:
            subset = [j for j in jobs if ('rpc' if j['kind'] == 'rpc' else 'graph') == kind]
            if s[kind + 'Attempts'] + len(subset) > limit or s[kind + 'ChargedBytes'] + sum(map(capacity, subset)) > body:
                raise LimitReached(kind + ' attempt/body reserve')
        for ep in (0, 1):
            if s['rpcEndpointAttempts'][ep] + sum((j['kind'] == 'rpc' and j['endpoint'] == ep for j in jobs)) > 24:
                raise LimitReached('RPC endpoint reserve')
        if s['chargedBytes'] + sum(map(capacity, jobs)) > 264 * 1024 ** 2 or s['chargedEntities'] + sum((j['maxRows'] for j in jobs)) > 500000:
            raise LimitReached('Combined body/object reserve')
        exact = sum((j is q for j in tail)) + int(is_retry)
        for kind, limit in [('graph', 88), ('rpc', 12)]:
            needed = (exact if ('rpc' if q['kind'] == 'rpc' else 'graph') == kind else 0) + 2 * sum((('rpc' if c['kind'] == 'rpc' else 'graph') == kind for c in self.controls))
            if s[kind + 'ExtraAttempts'] + needed > limit:
                raise LimitReached(kind + ' extra reserve')
        if s['extraAttempts'] + exact + 2 * len(self.controls) > 100:
            raise LimitReached('Shared extra reserve')
        self.phase_check(q, tail)
        self.storage.check(2 * sum(map(capacity, jobs)) + 262144, acquisition=True)

    def retry_allowed(self, q, cap, special, veto):
        if q['kind'] == 'rpc' and (not cap['usable']) and cap.get('complete') and (not cap.get('parseError')):
            parsed = strict_json((self.root / f"captures/{cap['attempt']:05d}/response.body").read_bytes())
            if isinstance(parsed, dict) and ('jsonrpc' in parsed or 'error' in parsed):
                cap['rpcEnvelopeRetryVeto'] = True
                return False
        return bool(not cap['usable'] and (not veto) and cap['closureKnown'] and cap.get('closedWithinDeadline') and (special or cap.get('failureKind') in ('transport_timeout', 'network') or (cap.get('complete') and cap.get('status') in (502, 503, 504))))

    def request(self, q, optional=False):
        original = self.state['attempts'] + 1
        prior = None
        cap = None
        try:
            for ordinal in range(6 if self.slow_schedule else 3):
                self.retry_ordinal = ordinal
                if ordinal > 2 and not slow_eligible(q, cap):
                    raise Stop('Exact query exhausted ordinary retries; slow tier ineligible')
                tail = self.liabilities(q, max(0, 2 - ordinal))
                if ordinal:
                    delay = WAITS[ordinal - 1]
                    self.phase_check(q, tail, delay)
                    if self.slow_schedule:
                        try:
                            requirements(q, self.controls, ordinal, self.state, self.clock() - self.started, delay)
                        except ValueError as e:
                            raise LimitReached(str(e)) from e
                    self.sleep(delay)
                cap, data = self.attempt(q, tail, is_retry=ordinal > 0, original=original, prior=prior, retry_index=ordinal)
                if cap['usable']:
                    return (cap, data)
                if not cap['retryable']:
                    raise Stop(cap['stopReason'])
                prior = cap['attempt']
            raise Stop('Exact query exhausted recognized retries')
        except BaseException:
            self.failed = True
            raise
