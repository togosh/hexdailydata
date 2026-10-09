"""One admitted two-cycle job; no standalone admission or retry of a whole cycle."""
import sys, time, json, queue, threading
sys.dont_write_bytecode = True
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
from durable import strict_json, digest, encode, utc
from capture_client import WorkerTransport, Stop
from session import ReferenceSession
from protocol import job, call, FEEDS, compare_headers, reading, compare_round
from audit import audit_round

def run_cycles(s, exchange):
    for ep in (0, 1): s.request(job(ep, 'eth_chainId', []))
    last_start, previous, prior_identities, prior_rounds = None, 0, None, None
    for cycle in (1, 2):
        if last_start is not None: s.sleep(max(0, 60 - (s.clock() - last_start)))
        if s.clock() - s.started >= 900: raise Stop('New cycle cutoff')
        s.cycle_started = s.clock()
        last_start = s.cycle_started
        s.cycle_ordinal, s.closing = cycle, False
        # Reserve mandatory controls even before choosing the actual number.
        def controls(number):
            return [job(ep, 'eth_call', call(a, 'round', number), cycle, 'close-round') for a in FEEDS for ep in (0, 1)] + [job(ep, 'eth_getBlockByNumber', [hex(number), False], cycle, 'close') for ep in (0, 1)]
        s.controls = controls(3)
        exchange({'type': 'begin', 'cycle': cycle}, s.started + 1080)
        calls = {}
        def ask(key, ep, method, params, phase):
            cap, value = s.request(job(ep, method, params, cycle, phase))
            calls[key] = cap['attempt']
            return value
        heads = [ask('head'+str(ep), ep, 'eth_getBlockByNumber', ['latest', False], 'head') for ep in (0, 1)]
        number = min(h['number'] for h in heads) - 2
        if number <= previous: raise Stop('Number did not advance; no extra polling')
        s.storage.json(s.root / f'CYCLE_{cycle}_BINDING.json', {'number': number, 'latest': [h['number'] for h in heads], 'cycleStartOffsetSeconds': s.cycle_started - s.started})
        s.controls = controls(number)
        opening = [ask('open'+str(ep), ep, 'eth_getBlockByNumber', [hex(number), False], 'open') for ep in (0, 1)]
        compare_headers(*opening)
        identities, rounds = {}, {}
        for asset, proxy in FEEDS.items():
            codes = [ask(asset+'-code'+str(ep), ep, 'eth_getCode', [proxy, hex(number)], 'code') for ep in (0, 1)]
            if codes[0] != codes[1]: raise Stop('Paired code mismatch')
            identity = {'proxy': proxy, 'code': codes[0]}
            if prior_identities and identity['code'] != prior_identities[asset]['code']: raise Stop('Runtime drift')
            for method in ('decimals', 'description', 'aggregator', 'round'):
                values = [ask(asset+'-'+method+str(ep), ep, 'eth_call', call(asset, method, number), method) for ep in (0, 1)]
                if values[0] != values[1]: raise Stop('Paired '+method+' mismatch')
                if method == 'round':
                    rounds[asset] = values[0]
                    reading(asset, values[0], opening[0], time.time())
                    if prior_rounds: compare_round(prior_rounds[asset], values[0])
                else:
                    identity[method] = values[0]
                    if prior_identities and values[0] != prior_identities[asset][method]: raise Stop('Proxy identity drift')
            identities[asset] = identity
        s.closing = True
        while s.controls:
            q = s.controls.pop(0)
            cap, value = s.request(q)
            asset = next((a for a, proxy in FEEDS.items() if q['method'] == 'eth_call' and q['params'][0]['to'] == proxy), None)
            if asset:
                if value != rounds[asset]: raise Stop('Closing tuple drift')
            else: compare_headers(opening[0], value)
            calls[(asset+'-close-round' if asset else 'close') + str(q['endpoint'])] = cap['attempt']
        sample = {'cycle': cycle, 'calls': calls, 'selectedBlock': number, 'sealedAt': utc()}
        s.storage.json(s.root / f'ROUND_{cycle}_SAMPLE.json', sample)
        s.persist()
        proof, update = audit_round(s.root, sample, s.state)
        s.storage.json(s.root / f'ROUND_{cycle}_AUDIT.json', proof)
        s.storage.json(s.root / f'ROUND_{cycle}_UPDATE.json', update)
        ack = exchange({'type': 'qualified', 'cycle': cycle, 'update': f'ROUND_{cycle}_UPDATE.json', 'updateSha256': digest(encode(update)), 'auditSha256': digest(encode(proof)), 'pin': opening[0], 'sealedAt': sample['sealedAt']}, s.started + 1140)
        s.storage.json(s.root / f'ROUND_{cycle}_PUBLICATION_ACK.json', ack)
        previous = number
        prior_identities, prior_rounds = identities, rounds
    return {'status': 'COMPLETE_FINITE_TRIAL', 'rounds': 2}

def main():
    if len(sys.argv) != 2:
        print('No requests. Existing bound admission directory required.')
        return 0
    root = Path(sys.argv[1]).resolve()
    a = strict_json((root / 'ADMISSION.json').read_bytes())
    if a['task'] != 'HDD-BTC-ETH-REFERENCE-FEED-R1' or a['family'] != 'reference' or a['jobRoot'] != str(root) or a.get('synthetic') or (root / 'ACCOUNTING.json').exists():
        raise ValueError('Exact unused public reference admission')
    for name, sha in a['runtimeFiles'].items():
        if digest((HERE.parents[1] / name).read_bytes()) != sha: raise ValueError('Frozen runtime changed')
    elapsed = time.time() - a['startedAtUnixSeconds']
    if not 0 <= elapsed <= 30: raise ValueError('Expired admission')
    s = ReferenceSession(root, WorkerTransport(a['nonce'], worker_path=HERE / 'worker.py'), elapsed=elapsed)
    incoming = queue.Queue()
    def reader():
        try:
            for line in sys.stdin:
                if len(line) > 32768: raise ValueError('IPC bound')
                incoming.put(strict_json(line))
        finally: incoming.put(None)
    threading.Thread(target=reader, daemon=True).start()
    def exchange(message, deadline):
        allowance = min(30, deadline - s.clock())
        if allowance <= 0: raise Stop('No controller/publication time')
        message['expiresAtUnixSeconds'] = time.time() + allowance
        print(json.dumps(message), flush=True)
        try: answer = incoming.get(timeout=allowance)
        except queue.Empty: raise Stop('Publication acknowledgement unknown')
        if not isinstance(answer, dict) or answer.get('ok') is not True or answer.get('cycle') != message['cycle']:
            raise Stop('Controller acknowledgement refused/unknown')
        return answer
    try: result = run_cycles(s, exchange)
    except BaseException as e:
        result = {'status': 'PARTIAL', 'failure': type(e).__name__+': '+str(e), 'rounds': len(list(root.glob('ROUND_*_PUBLICATION_ACK.json')))}
    finally:
        s.close(result.get('failure', 'Both cycles and publication acknowledgements closed'))
        result.update(accounting=s.state, networkSessionCount=1, noAutomaticRestart=True, indexer='PARKED')
        s.storage.json(root / 'RESULT.json', result)
        print(json.dumps({'type': 'closed', 'result': result}), flush=True)
    return 0 if result['status'].startswith('COMPLETE_') else 2

if __name__ == '__main__': raise SystemExit(main())
