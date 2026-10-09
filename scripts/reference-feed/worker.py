"""Exact new admission/numbered pin, then unchanged framed HTTPS transport."""
import sys, time
sys.dont_write_bytecode = True
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
from durable import strict_json, digest
from protocol import validate_job, capacity
from http_worker import perform

def main():
    request_path, body_path, meta_path, nonce = sys.argv[1:]
    request = Path(request_path).resolve()
    root = request.parents[2]
    admission = strict_json((root / 'ADMISSION.json').read_bytes())
    state = strict_json((root / 'ACCOUNTING.json').read_bytes())
    if admission['task'] != 'HDD-BTC-ETH-REFERENCE-FEED-R1' or admission['family'] != 'reference' or admission['nonce'] != nonce or state['pending']['requestPath'] != str(request) or state['status'] != 'ADMITTED' or time.time() + 30 >= admission['startedAtUnixSeconds'] + 1080:
        raise ValueError('Exact unused reference admission/deadline')
    for name, expected in admission['runtimeFiles'].items():
        if digest((HERE.parents[1] / name).read_bytes()) != expected:
            raise ValueError('Frozen reference runtime changed')
    req = strict_json(request.read_bytes())
    q = req['job']
    method, url, body = validate_job(q)
    if body != (request.parent / 'request.body').read_bytes() or req['url'] != url:
        raise ValueError('Request binding changed')
    if q['phase'] not in ('entry', 'head'):
        cycle = strict_json((root / f"CYCLE_{q['cycle']}_BINDING.json").read_bytes())
        number = int(q['params'][0 if q['method'] == 'eth_getBlockByNumber' else 1], 16)
        if number != cycle['number']:
            raise ValueError('Unselected numeric pin')
    if state['attempts'] > 80 or max(state['rpcEndpointAttempts']) > 40 or state['extraAttempts'] > 8 or state['chargedBytes'] > 12582912 or state['chargedEntities'] > 20000:
        raise ValueError('Reference hard caps')
    perform(method, url, body, body_path, meta_path, capacity(q), timeout=28, user_agent='HDD-USD-Reference/1.0')

if __name__ == '__main__':
    main()
