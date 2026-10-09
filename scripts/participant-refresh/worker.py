"""Frozen plan and selected-window gate before the reused physical HTTP worker."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
from durable import strict_json, digest
from queries import validate_job, capacity, plan_valid
from http_worker import perform

def gate(request, nonce):
    request = Path(request).resolve()
    root = request.parents[2]
    admission = strict_json((root / 'ADMISSION.json').read_bytes())
    state = strict_json((root / 'ACCOUNTING.json').read_bytes())
    if admission['nonce'] != nonce or state['status'] != 'ADMITTED' or state['pending']['requestPath'] != str(request):
        raise ValueError('Unbound admission')
    repository = HERE.parents[1]
    for name, expected in admission['runtimeFiles'].items():
        if digest((repository / name).read_bytes()) != expected:
            raise ValueError('Frozen runtime changed')
    plan_raw = (root / 'PLAN.json').read_bytes()
    if digest(plan_raw) != admission['planSha256']:
        raise ValueError('Frozen plan changed')
    plan = strict_json(plan_raw)
    if plan.get('combinedJob') and (root / 'RESOLVED_PLAN.json').exists():
        resolved = strict_json((root / 'RESOLVED_PLAN.json').read_bytes())
        if {**resolved, 'finalTarget': plan['finalTarget']} != plan or resolved['finalTarget']['number'] != plan['finalTarget']['number']:
            raise ValueError('Resolved target altered frozen plan')
        plan = resolved
    plan_valid(plan)
    q = strict_json(request.read_bytes())['job']
    method, url, body = validate_job(q, plan)
    if body != (request.parent / 'request.body').read_bytes():
        raise ValueError('Request bytes changed')
    w = q['window']
    frontier = strict_json((root / 'FRONTIER.json').read_bytes())
    if w != frontier['completedWindows'] + 1:
        raise ValueError('Unpublished predecessor')
    if q['kind'] != 'rpc':
        binding = strict_json((root / f'WINDOW_{w}_BINDING.json').read_bytes())
        if q['pin'] not in (binding['base'], binding['target']):
            raise ValueError('Uncorroborated graph pin')
    if state['attempts'] > 2248 or state['graphAttempts'] > 2200 or state['rpcAttempts'] > 48 or (max(state['rpcEndpointAttempts']) > 24):
        raise ValueError('Attempt ceilings')
    return (method, url, body, capacity(q))

def main():
    request, body_path, meta_path, nonce = sys.argv[1:]
    method, url, body, maximum = gate(request, nonce)
    perform(method, url, body, body_path, meta_path, maximum, timeout=28, user_agent='HDD-Participant-Refresh/1.0')
if __name__ == '__main__':
    main()
