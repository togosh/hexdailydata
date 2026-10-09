"""Exact gas admission and shape gate, then the unchanged framed physical HTTP worker."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
from durable import strict_json, digest
from protocol import validate_job, capacity, kind, call
from http_worker import perform

def main():
    request_path, body_path, meta_path, nonce = sys.argv[1:]
    request = Path(request_path).resolve()
    root = request.parents[2]
    admission = strict_json((root / 'ADMISSION.json').read_bytes())
    state = strict_json((root / 'ACCOUNTING.json').read_bytes())
    if admission['nonce'] != nonce or state['pending']['requestPath'] != str(request) or state['status'] != 'ADMITTED':
        raise ValueError('No bound gas admission')
    repository = HERE.parents[1]
    for name, expected in admission['runtimeFiles'].items():
        if digest((repository / name).read_bytes()) != expected:
            raise ValueError('Frozen gas runtime changed')
    req = strict_json(request.read_bytes())
    q = req['job']
    method, url, body = validate_job(q)
    if body != (request.parent / 'request.body').read_bytes():
        raise ValueError('Exact request bytes changed')
    if q['phase'] not in ('entry', 'head'):
        suffix = 'RANGE' if q['phase'] in ('range', 'first', 'last', 'close-global') else 'PIN' if q['method'] == 'eth_call' else 'BINDING'
        cycle = strict_json((root / f"CYCLE_{q['cycle']}_{suffix}.json").read_bytes())
        if q['method'] == 'eth_getBlockByNumber' and int(q['params'][0], 16) != cycle['number']:
            raise ValueError('Unselected number')
        if q['method'] == 'eth_getCode' and int(q['params'][1], 16) != cycle['number']:
            raise ValueError('Unselected code pin')
        if q['method'] == 'eth_call':
            if q['params'][1] != {'blockHash': cycle['hash'], 'requireCanonical': True}:
                raise ValueError('Unselected hash')
            k = kind(q)
            data = q['params'][0]['data']
            if k == 'range' and data != call('range', cycle['hash'], cycle['end'] - 2, cycle['dailyCount'])[0]['data']:
                raise ValueError('Unselected range')
            if k == 'daily':
                d = cycle['end'] if q['phase'] == 'first' else cycle['dailyCount'] - 1
                if data != call('daily', cycle['hash'], d)[0]['data']:
                    raise ValueError('Unselected getter')
    if state['attempts'] > 72 or max(state['rpcEndpointAttempts']) > 36:
        raise ValueError('Attempt cap')
    perform(method, url, body, body_path, meta_path, capacity(q), timeout=18, user_agent='HDD-HEX-Protocol/1.0')
if __name__ == '__main__':
    main()
