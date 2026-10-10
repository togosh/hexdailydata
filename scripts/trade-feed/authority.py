"""The recovery has a separate exact grant; the old trade wire ID is unchanged."""
from pathlib import Path
from durable import strict_json, digest

AUTHORITY = 'HDD-BTC-ETH-CURRENT-REFERENCE-TRANSPORT-RECOVERY-R1'
ROOT = Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\transport-recovery-r1')


def validate_authority(admission, session):
    session = Path(session).resolve()
    recovery = session.is_relative_to(ROOT) or 'authorityTaskId' in admission
    if not recovery:
        return  # Legacy mode retains its existing admission and spent-state gates.
    if session != ROOT/'session' or admission.get('authorityTaskId') != AUTHORITY:
        raise ValueError('Exact recovery authority/session required')
    if admission.get('synthetic') is not False:
        raise ValueError('Public recovery admission cannot be synthetic')
    validate_recovery_documents(admission, session, (ROOT/'packet/SCOPE.json').read_bytes(),
                                (ROOT/'PREFLIGHT.json').read_bytes(),
                                strict_json((ROOT/'PUBLIC_ADMISSION.json').read_bytes()))
    pre = strict_json((ROOT/'PREFLIGHT.json').read_bytes())
    if digest((ROOT/'evidence/PREFLIGHT_REVIEW.json').read_bytes()) != pre['independentReviewSha256']:
        raise ValueError('Recovery review binding')
    if digest((ROOT/'evidence/READY.json').read_bytes()) != pre['readySha256']:
        raise ValueError('Recovery loaded-ready binding')


def validate_recovery_documents(admission, session, scope_bytes, pre_bytes, marker):
    if Path(session) != ROOT/'session' or admission.get('authorityTaskId') != AUTHORITY or admission.get('synthetic') is not False:
        raise ValueError('Exact recovery document identity')
    nonce = admission.get('nonce')
    if not isinstance(nonce, str) or len(nonce) != 64 or any(c not in '0123456789abcdef' for c in nonce):
        raise ValueError('Recovery nonce shape')
    if digest(scope_bytes) != admission.get('scopeSha256'):
        raise ValueError('Recovery scope binding')
    scope = strict_json(scope_bytes)
    if scope['taskId'] != AUTHORITY or Path(scope['network']['sessionPath']) != session:
        raise ValueError('Recovery scope identity')
    if digest(pre_bytes) != admission['preflightSha256']:
        raise ValueError('Recovery preflight binding')
    pre = strict_json(pre_bytes)
    if (pre['authorityTaskId'] != AUTHORITY or pre['taskRoot'] != str(ROOT)
            or pre.get('synthetic') is not False or pre['verdict'] != 'PASS'
            or pre['runtimeFiles'] != admission['runtimeFiles']):
        raise ValueError('Recovery preflight identity')
    if (marker.get('authorityTaskId') != AUTHORITY or marker.get('nonce') != admission['nonce']
            or marker.get('output') != str(session) or marker.get('scopeSha256') != digest(scope_bytes)
            or marker.get('preflightSha256') != digest(pre_bytes)):
        raise ValueError('Recovery marker identity')
