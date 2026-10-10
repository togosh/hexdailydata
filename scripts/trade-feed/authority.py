"""The recovery has a separate exact grant; the old trade wire ID is unchanged."""
from pathlib import Path
from durable import strict_json, digest

AUTHORITY = 'HDD-BTC-ETH-CURRENT-REFERENCE-TRANSPORT-RECOVERY-R1'
ROOT = Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\transport-recovery-r1')
ISOLATION_AUTHORITY = 'HDD-BTC-ETH-CURRENT-REFERENCE-WORKER-STDIN-ISOLATION-R1'
ISOLATION_ROOT = ROOT.parent/'worker-stdin-isolation-r1'


def validate_authority(admission, session):
    session = Path(session).resolve()
    recovery = any(session.is_relative_to(root) for root in (ROOT, ISOLATION_ROOT)) or 'authorityTaskId' in admission
    if not recovery:
        return  # Legacy mode retains its existing admission and spent-state gates.
    root, authority = (ISOLATION_ROOT, ISOLATION_AUTHORITY) if session == ISOLATION_ROOT/'session' else (ROOT, AUTHORITY)
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


def validate_recovery_documents(admission, session, scope_bytes, pre_bytes, marker, *, root=ROOT, authority=AUTHORITY):
    if (root, authority) not in ((ROOT, AUTHORITY), (ISOLATION_ROOT, ISOLATION_AUTHORITY)):
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
