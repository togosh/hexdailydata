"""Participant-only scheduling. The HOLDER_R3 error classifier is unchanged."""
from queries import capacity, FAMILIES
from retry_policy import CLASSIFICATIONS

VERSION = 'PARTICIPANT_CATCHUP_R2'
WAITS = (15, 60, 120, 240, 300)
COUNTERS = ('attempts', 'extraAttempts', 'graphAttempts', 'rpcAttempts',
            'chargedBytes', 'graphChargedBytes', 'rpcChargedBytes',
            'chargedEntities', 'graphExtraAttempts', 'rpcExtraAttempts',
            'rpcEndpointAttempts')


def enabled(plan):
    if plan.get('retry', {}).get('scheduleVersion') != VERSION:
        if plan.get('taskId') == 'HDD-PARTICIPANT-CATCHUP-REFRESH-R2':
            raise ValueError('Missing R2 retry schedule')
        return False
    r = plan['retry']
    expected = {'ordinaryMaximumExtras': 2, 'ordinaryMinimumWaitSeconds': [15, 60],
                'optionalSlowMaximumAdditionalExtras': 3, 'maximumExtrasForEligibleDataQuery': 5,
                'allOrdinalWaitSeconds': list(WAITS), 'controlMetadataWitnessRpcMaximumExtras': 2,
                'optionalSlowEligibleJob': {'kind': ['changes', 'parents'], 'phase': 'data', 'protocol': 'graph'}}
    if any(r.get(k) != v for k, v in expected.items()):
        raise ValueError('Changed R2 retry schedule')
    return True


def slow_eligible(q, previous):
    return bool(q['kind'] in ('changes', 'parents') and q['phase'] == 'data'
                and previous and previous.get('retryable') and not previous.get('usable')
                and previous.get('status') == 200 and previous.get('classification') in CLASSIFICATIONS
                and all(previous.get(k) is True for k in ('complete', 'bodyDurable', 'framingValidated',
                    'closureKnown', 'closedWithinDeadline', 'childReaped', 'connectionClosed'))
                and not any(previous.get(k) for k in ('failureKind', 'transportError', 'validationError',
                    'parseError', 'accessRestricted')))


def control_template(window):
    graph = [{'kind': 'changes', 'family': f, 'first': 500, 'endpoint': 0,
              'maxRows': 1504 if f == 'stakeStarts' else 504} for f in FAMILIES for _ in range(2)]
    graph += [{'kind': 'witness', 'family': f, 'first': 32, 'endpoint': 0, 'maxRows': 100}
              for f in ('tokenHolders', 'stakeStarts') for _ in range(2)]
    graph += [{'kind': 'meta', 'endpoint': 0, 'maxRows': 4} for _ in range(2)]
    return graph + [{'kind': 'rpc', 'method': 'eth_getBlockByNumber', 'endpoint': ep, 'maxRows': 4096}
                    for ep in (0, 1) for _ in range(2 if window == 1 else 1)]


def remaining(q, controls, ordinal):
    return [q] * max(0, 2 - ordinal) + [item for c in controls for item in [c] * 3]


def requirements(q, controls, ordinal, counters, offset, delay=0):
    """One next dispatch plus ordinary liabilities; never reserve speculative slow extras."""
    if not 0 <= ordinal <= (5 if q['kind'] in ('changes', 'parents') and q['phase'] == 'data' else 2):
        raise ValueError('Retry ordinal ceiling')
    jobs = [q, *remaining(q, controls, ordinal)]
    current_waits = sum(WAITS[ordinal:2]) if ordinal < 2 else 0
    finish = offset + delay + len(jobs) * 31 + current_waits + 75 * len(controls)
    if offset + delay + 30 >= 5100 or finish >= 5100 or finish + 180 >= 5400:
        raise ValueError('Current-window controls/retries/publication deadline reserve')
    if counters['attempts'] + len(jobs) > 2248:
        raise ValueError('Combined attempt reserve')
    needed_extras = max(0, 2 - ordinal) + int(ordinal > 0)
    for kind, attempts, body, extras in [('graph', 2200, 256 * 1024 ** 2, 88), ('rpc', 48, 8 * 1024 ** 2, 12)]:
        subset = [j for j in jobs if ('rpc' if j['kind'] == 'rpc' else 'graph') == kind]
        if counters[kind + 'Attempts'] + len(subset) > attempts or counters[kind + 'ChargedBytes'] + sum(map(capacity, subset)) > body:
            raise ValueError(kind + ' attempt/body reserve')
        liability = (needed_extras if ('rpc' if q['kind'] == 'rpc' else 'graph') == kind else 0)
        liability += 2 * sum(('rpc' if c['kind'] == 'rpc' else 'graph') == kind for c in controls)
        if counters[kind + 'ExtraAttempts'] + liability > extras:
            raise ValueError(kind + ' extra reserve')
    for ep in (0, 1):
        if counters['rpcEndpointAttempts'][ep] + sum(j['kind'] == 'rpc' and j['endpoint'] == ep for j in jobs) > 24:
            raise ValueError('RPC endpoint reserve')
    if counters['extraAttempts'] + needed_extras + 2 * len(controls) > 100:
        raise ValueError('Shared extra reserve')
    body = sum(map(capacity, jobs)); objects = sum(j['maxRows'] for j in jobs)
    if counters['chargedBytes'] + body > 264 * 1024 ** 2 or counters['chargedEntities'] + objects > 500000:
        raise ValueError('Combined body/object reserve')
    return {'physicalAttemptsReserved': len(jobs), 'bodyBytesReserved': body,
            'objectsReserved': objects, 'ordinaryControls': len(controls),
            'futureWaitSecondsReserved': current_waits + 75 * len(controls),
            'finishOffsetBound': finish, 'publicationSecondsReserved': 180}


class ControlReplay:
    """Reconstruct control liabilities from accepted rows and physical request order."""
    def __init__(self):
        self.window = None
        self.controls = []
        self.nonempty = set()
        self.repeat_started = set()

    def remove(self, kind, family=None, endpoint=None):
        i = next(i for i, c in enumerate(self.controls) if c['kind'] == kind
                 and (family is None or c.get('family') == family)
                 and (endpoint is None or c.get('endpoint') == endpoint))
        self.controls.pop(i)

    def before(self, q, retry):
        if q['window'] != self.window:
            self.window = q['window']; self.controls = control_template(self.window)
            self.nonempty = set(); self.repeat_started = set()
        if retry or q['phase'] != 'control':
            return self.controls
        k = q['kind']; f = q['family']
        if k == 'changes':
            if f not in self.repeat_started:
                if f not in self.nonempty:self.remove(k, f)
                self.repeat_started.add(f)
            self.remove(k, f)
        elif k in ('witness', 'meta'):
            for family in ('tokenHolders', 'stakeStarts'):
                if family not in self.nonempty:
                    self.controls = [c for c in self.controls if not (c['kind'] == 'witness' and c['family'] == family)]
                if k == 'witness' and family == f:break
            self.remove(k, f if k == 'witness' else None)
        elif k == 'rpc':self.remove(k, endpoint=q['endpoint'])
        return self.controls

    def observe(self, q, value):
        if value is not None and q['phase'] == 'data' and q['kind'] in ('changes', 'parents') and value[q['family']]:
            self.nonempty.add(q['family'])
