"""Exact gas admission and shape gate, then the unchanged framed physical HTTP worker."""
import sys
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
        cycle = strict_json((root / f"CYCLE_{q['cycle']}_BINDING.json").read_bytes())
        if q['method'] in ('eth_getBlockByNumber', 'eth_feeHistory'):
            number = q['params'][1] if q['method'] == 'eth_feeHistory' else q['params'][0]
            if int(number, 16) != cycle['number']:
                raise ValueError('Unselected contextual block')
        if q['phase'] == 'witness':
            witness = strict_json((root / 'WITNESS_BINDING.json').read_bytes())
            if witness['cycle'] != q['cycle'] or q['params'] != [witness['transactionHash']]:
                raise ValueError('Unselected transaction')
    if state['attempts'] > 48 or max(state['rpcEndpointAttempts']) > 24:
        raise ValueError('Attempt cap')
    perform(method, url, body, body_path, meta_path, capacity(q), timeout=10, user_agent='HDD-PulseChain-Gas/1.0')
if __name__ == '__main__':
    main()
