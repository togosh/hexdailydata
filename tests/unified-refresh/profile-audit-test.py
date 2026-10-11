"""Saved-evidence tamper refusals; no writes, bases, execution or network."""
import copy
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/unified-refresh'))
import audit_parent


def denied(*args, **kwargs):
    raise AssertionError('Network forbidden')


socket.getaddrinfo = socket.create_connection = socket.socket.connect = denied
root = Path(sys.argv[1]).resolve()
original = audit_parent.read
assert audit_parent.audit(root)['status'] == 'PASS'
cases = []
mutations = [
    ('profile identity', 'PROFILE.json', lambda x: x['parent'].__setitem__('seconds', x['parent']['seconds'] + 1), 'Profile parent identity/limits'),
    ('parent binding', 'PARENT_ACCOUNTING.json', lambda x: x.__setitem__('profileSha256', '0' * 64), 'Profile parent identity/limits'),
    ('parent limits', 'PARENT_ACCOUNTING.json', lambda x: x['limits'].__setitem__('attempts', 999), 'Profile parent identity/limits'),
    ('child binding', 'trade-1/ADMISSION.json', lambda x: x.__setitem__('parentProfileSha256', '0' * 64), 'Profile child identity/limits'),
    ('child limits', 'trade-1/ADMISSION.json', lambda x: x['parentLimits'].__setitem__('attempts', 999), 'Profile child identity/limits'),
    ('final endpoint counters', 'PARENT_ACCOUNTING.json', lambda x: x['rpcEndpointAttempts'].__setitem__(0, x['rpcEndpointAttempts'][0] + 1), 'Profile final reconciliation'),
]
if (root / 'trade-1/DISPATCH_SKIPPED.json').exists():
    mutations.append(('no-child binding', 'trade-1/DISPATCH_SKIPPED.json', lambda x: x.__setitem__('jobAdmissionSha256', '0' * 64), 'Prepared no-child dispatch evidence'))
for name, relative, mutate, expected in mutations:
    def altered(path):
        value = original(path)
        if Path(path).resolve() == root / relative:
            value = copy.deepcopy(value)
            mutate(value)
        return value
    with patch.object(audit_parent, 'read', altered):
        try:
            audit_parent.audit(root)
        except ValueError as error:
            assert str(error) == expected, (name, str(error))
        else:
            raise AssertionError('Tamper accepted: ' + name)
    cases.append(name)
print(json.dumps(dict(status='PASS', savedOnly=True, source=str(root), cases=cases, externalRequests=0)))
