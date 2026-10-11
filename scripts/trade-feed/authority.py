"""The recovery has a separate exact grant; the old trade wire ID is unchanged."""
from pathlib import Path
from durable import strict_json, digest
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'unified-refresh'))
from offline_profile import admitted as unified_admitted

AUTHORITY = 'HDD-BTC-ETH-CURRENT-REFERENCE-TRANSPORT-RECOVERY-R1'
ROOT = Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\transport-recovery-r1')
ISOLATION_AUTHORITY = 'HDD-BTC-ETH-CURRENT-REFERENCE-WORKER-STDIN-ISOLATION-R1'
ISOLATION_ROOT = ROOT.parent/'worker-stdin-isolation-r1'
COOKIE_AUTHORITY = 'HDD-BTC-ETH-CURRENT-REFERENCE-RESPONSE-COOKIE-HANDLING-R1'
COOKIE_ROOT = ROOT.parent/'response-cookie-handling-r1'
COOKIE_POLICY = 'ignore-response-cookies-no-replay-v1'
OPERATING_AUTHORITY = 'HDD-BTC-ETH-OPERATING-REFRESH-R1'
OPERATING_ROOT = ROOT.parent/'operating-refresh-r1'
OPERATING_R2_AUTHORITY = 'HDD-BTC-ETH-OPERATING-REFRESH-R2'
OPERATING_R2_ROOT = ROOT.parent/'operating-refresh-r2'
OPERATING_AUTHORITIES = (OPERATING_AUTHORITY, OPERATING_R2_AUTHORITY)
OPERATING_PROFILE_ID = 'operating-16-slots-v1'


def trade_profile(admission):
    """Exact versioned authority, never caller-supplied arbitrary allowances."""
    if unified_admitted(admission):
        if (admission.get('family')!='trade' or admission.get('tradeProfileId')!='unified-single-pair-1'
                or type(admission.get('tradeSlot')) is not int or not 1<=admission['tradeSlot']<=16
                or admission.get('responseCookiePolicyId')!=COOKIE_POLICY):
            raise ValueError('Exact offline single-pair profile')
        b=admission['allowance'];seconds=min(600,b['seconds'])
        return dict(cycles=1,logical=3,attempts=min(6,b['httpAttempts']),extras=min(3,b['httpExtras']),seconds=seconds,dispatch=min(535,seconds-65),
                    charged_bytes=min(6*2162688,b['httpChargedBytes']),objects=min(120000,b['chargedEntities']),maximum_start_lag=None,
                    first_cycle=admission['tradeSlot'])
    if admission.get('authorityTaskId') in OPERATING_AUTHORITIES:
        if (admission.get('tradeProfileId') != OPERATING_PROFILE_ID
                or admission.get('job') != 'trade-operating-16-slots'
                or admission.get('responseCookiePolicyId') != COOKIE_POLICY):
            raise ValueError('Exact operating profile required')
        return dict(cycles=16, logical=33, attempts=66, extras=33, seconds=1200,
                    dispatch=1135, charged_bytes=144*1024**2, objects=1320000,
                    maximum_start_lag=5)
    if admission.get('tradeProfileId') is not None:
        raise ValueError('Operating profile outside exact authority')
    return dict(cycles=3, logical=7, attempts=14, extras=7, seconds=600,
                dispatch=535, charged_bytes=32*1024**2, objects=280000,
                maximum_start_lag=None)


def cookie_policy(admission):
    """Only the exact new authority can select the receiving-only amendment."""
    selected = admission.get('responseCookiePolicyId')
    if unified_admitted(admission):
        trade_profile(admission)
        return COOKIE_POLICY
    if admission.get('authorityTaskId') in (COOKIE_AUTHORITY, *OPERATING_AUTHORITIES):
        if selected != COOKIE_POLICY:
            raise ValueError('Exact response cookie policy required')
        return COOKIE_POLICY
    if selected is not None:
        raise ValueError('Response cookie policy outside exact authority')
    return None


def validate_authority(admission, session):
    session = Path(session).resolve()
    from operating_authority import live,validate
    if live(admission):return validate(admission,session)
    from public_profile import is_public,validate_authority as validate_public
    if is_public(admission):return validate_public(admission,session)
    recovery = any(session.is_relative_to(root) for root in (ROOT, ISOLATION_ROOT, COOKIE_ROOT, OPERATING_ROOT, OPERATING_R2_ROOT)) or 'authorityTaskId' in admission
    if not recovery:
        return  # Legacy mode retains its existing admission and spent-state gates.
    root, authority = ((OPERATING_R2_ROOT, OPERATING_R2_AUTHORITY) if session == OPERATING_R2_ROOT/'session' else
                       (OPERATING_ROOT, OPERATING_AUTHORITY) if session == OPERATING_ROOT/'session' else
                       (COOKIE_ROOT, COOKIE_AUTHORITY) if session == COOKIE_ROOT/'session' else
                       (ISOLATION_ROOT, ISOLATION_AUTHORITY) if session == ISOLATION_ROOT/'session' else (ROOT, AUTHORITY))
    if session != root/'session' or admission.get('authorityTaskId') != authority:
        raise ValueError('Exact recovery authority/session required')
    if admission.get('synthetic') is not False:
        raise ValueError('Public recovery admission cannot be synthetic')
    validate_recovery_documents(admission, session, (root/'packet/SCOPE.json').read_bytes(),
                                (root/'PREFLIGHT.json').read_bytes(),
                                strict_json((root/'PUBLIC_ADMISSION.json').read_bytes()), root=root, authority=authority)
    pre = strict_json((root/'PREFLIGHT.json').read_bytes())
    if digest((root/'evidence/PREFLIGHT_REVIEW.json').read_bytes()) != pre['independentReviewSha256']:
        raise ValueError('Recovery review binding')
    if digest((root/'evidence/READY.json').read_bytes()) != pre['readySha256']:
        raise ValueError('Recovery loaded-ready binding')
    if authority == ISOLATION_AUTHORITY:
        gate = (root/'evidence/CAUSAL_GATE.json').read_bytes()
        if digest(gate) != pre.get('causalGateSha256') or strict_json(gate).get('status') != 'PASS':
            raise ValueError('Causal gate binding')
    if authority == COOKIE_AUTHORITY:
        gate = (root/'evidence/POLICY_GATE.json').read_bytes()
        if digest(gate) != pre.get('policyGateSha256') or strict_json(gate).get('status') != 'PASS':
            raise ValueError('Response policy gate binding')
    if authority in OPERATING_AUTHORITIES:
        gate = (root/'evidence/OPERATING_GATE.json').read_bytes()
        if digest(gate) != pre.get('operatingGateSha256') or strict_json(gate).get('status') != 'PASS':
            raise ValueError('Operating gate binding')


def validate_recovery_documents(admission, session, scope_bytes, pre_bytes, marker, *, root=ROOT, authority=AUTHORITY):
    if (root, authority) not in ((ROOT, AUTHORITY), (ISOLATION_ROOT, ISOLATION_AUTHORITY), (COOKIE_ROOT, COOKIE_AUTHORITY), (OPERATING_ROOT, OPERATING_AUTHORITY), (OPERATING_R2_ROOT, OPERATING_R2_AUTHORITY)):
        raise ValueError('Unknown public grant')
    if Path(session) != root/'session' or admission.get('authorityTaskId') != authority or admission.get('synthetic') is not False:
        raise ValueError('Exact recovery document identity')
    nonce = admission.get('nonce')
    if not isinstance(nonce, str) or len(nonce) != 64 or any(c not in '0123456789abcdef' for c in nonce):
        raise ValueError('Recovery nonce shape')
    if digest(scope_bytes) != admission.get('scopeSha256'):
        raise ValueError('Recovery scope binding')
    scope = strict_json(scope_bytes)
    if scope['taskId'] != authority or Path(scope['network']['sessionPath']) != session:
        raise ValueError('Recovery scope identity')
    if digest(pre_bytes) != admission['preflightSha256']:
        raise ValueError('Recovery preflight binding')
    pre = strict_json(pre_bytes)
    if (pre['authorityTaskId'] != authority or pre['taskRoot'] != str(root)
            or pre.get('synthetic') is not False or pre['verdict'] != 'PASS'
            or pre['runtimeFiles'] != admission['runtimeFiles']):
        raise ValueError('Recovery preflight identity')
    if (marker.get('authorityTaskId') != authority or marker.get('nonce') != admission['nonce']
            or marker.get('output') != str(session) or marker.get('scopeSha256') != digest(scope_bytes)
            or marker.get('preflightSha256') != digest(pre_bytes)):
        raise ValueError('Recovery marker identity')
    if authority in (COOKIE_AUTHORITY, *OPERATING_AUTHORITIES):
        if (cookie_policy(admission) != COOKIE_POLICY
                or pre.get('responseCookiePolicyId') != COOKIE_POLICY
                or marker.get('responseCookiePolicyId') != COOKIE_POLICY
                or scope['network']['responseCookiePolicy']['id'] != COOKIE_POLICY):
            raise ValueError('Response cookie policy document binding')
    if authority in OPERATING_AUTHORITIES:
        profile = trade_profile(admission)
        if pre.get('tradeProfileId') != OPERATING_PROFILE_ID or marker.get('tradeProfileId') != OPERATING_PROFILE_ID:
            raise ValueError('Operating profile document binding')
        n=scope['network']
        expected={'maximumPhysicalAttempts':profile['attempts'],'maximumLogicalRequests':profile['logical'],
                  'normalGetCount':profile['logical'],'maximumTotalRetries':profile['extras'],
                  'maximumSessionSecondsIncludingClosure':profile['seconds'],
                  'maximumNewDispatchOffsetSeconds':profile['dispatch'],
                  'maximumChargedBytes':profile['charged_bytes'],
                  'maximumParsedObjectsAcrossResponses':profile['objects'],
                  'perAttemptDurableReservationBytes':2162688,
                  'minimumCompleteAttemptAndClosureReserveSeconds':65}
        if any(n.get(k)!=v for k,v in expected.items()) or n['plan']['cycles']!=16 or n['plan']['cycleOffsetsSeconds']!=list(range(0,901,60)) or n['plan']['maximumOrdinaryStartLagSeconds']!=5:
            raise ValueError('Operating scope limits binding')
