"""One finite gas observation session; explicit parent publication acknowledgement."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
import time, json, secrets, queue, threading, shutil
from durable import strict_json, encode, digest, save, utc
from capture_client import WorkerTransport, Stop
from session import GasSession
from protocol import job, compare_headers, compare_closing_header, denomination_witness
from audit import audit_round

def recorded(s, name, value):
    s.storage.json(s.root / name, value)

def run_cycles(s, maximum, exchange):
    for ep in (0, 1):
        s.request(job(ep, 'eth_chainId', []))
    last_start = None
    previous = 27720851
    skip_tips = set()
    witness_done = False
    accepted = []
    recorded(s, 'DENOMINATION_REFERENCE.json', denomination_witness())
    for cycle in range(1, maximum + 1):
        if last_start is not None:
            s.sleep(max(0, 60 - (s.clock() - last_start)))
        s.cycle_started = s.clock()
        last_start = s.cycle_started
        s.cycle_ordinal = cycle
        s.closing = False
        s.controls = [job(ep, 'eth_getBlockByNumber', [hex(27720852), False], cycle, 'close') for ep in (0, 1)]
        exchange({'type': 'begin', 'cycle': cycle}, s.started + 1080)
        calls = {}

        def ask(key, ep, m, p, phase):
            cap, value = s.request(job(ep, m, p, cycle, phase))
            calls[key] = cap['attempt']
            return value
        heads = [ask('head' + str(ep), ep, 'eth_getBlockByNumber', ['latest', False], 'head') for ep in (0, 1)]
        number = min((h['number'] for h in heads)) - 2
        if number <= previous:
            raise Stop('Context did not advance; no alternative block/head hunt')
        recorded(s, f'CYCLE_{cycle}_BINDING.json', {'number': number, 'latest': [h['number'] for h in heads], 'cycleStartOffsetSeconds': s.cycle_started - s.started})
        s.controls = [job(ep, 'eth_getBlockByNumber', [hex(number), False], cycle, 'close') for ep in (0, 1)]
        opening = [ask('open' + str(ep), ep, 'eth_getBlockByNumber', [hex(number), False], 'open') for ep in (0, 1)]
        compare_headers(*opening)
        age = time.time() - opening[0]['timestamp']
        if not 0 <= age <= 300:
            raise Stop('Context not plausible/nonfuture within 300 seconds')
        for ep in (0, 1):
            ask('gas' + str(ep), ep, 'eth_gasPrice', [], 'sample')
        for ep in (0, 1):
            if ep in skip_tips:
                continue
            tip = ask('tip' + str(ep), ep, 'eth_maxPriorityFeePerGas', [], 'sample')
            if isinstance(tip, dict) and tip.get('capability') == 'unsupported':
                skip_tips.add(ep)
        if cycle == 1:
            for ep in (0, 1):
                ask('history' + str(ep), ep, 'eth_feeHistory', ['0x10', hex(number), [10, 50, 90]], 'history')
        if not witness_done and any((h['transactions'] for h in opening)):
            witness_done = True
            shared = next((t for t in opening[0]['transactions'] if t in set(opening[1]['transactions'])), None)
            recorded(s, 'WITNESS_BINDING.json', {'cycle': cycle, 'number': number, 'transactionHash': shared, 'selection': 'first shared hash of earliest sampled nonempty B'})
            if shared:
                for ep in (0, 1):
                    ask('transaction' + str(ep), ep, 'eth_getTransactionByHash', [shared], 'witness')
                    ask('receipt' + str(ep), ep, 'eth_getTransactionReceipt', [shared], 'witness')
        s.closing = True
        while s.controls:
            q = s.controls.pop(0)
            ep = q['endpoint']
            cap, closed = s.request(q)
            calls['close' + str(ep)] = cap['attempt']
            compare_closing_header(opening[ep], closed)
        sample = {'cycle': cycle, 'calls': calls, 'selectedBlock': number, 'sealedAt': utc(), 'skipUnsupportedTips': sorted(skip_tips)}
        recorded(s, f'ROUND_{cycle}_SAMPLE.json', sample)
        s.persist()
        proof, update = audit_round(s.root, sample, s.state)
        recorded(s, f'ROUND_{cycle}_AUDIT.json', proof)
        recorded(s, f'ROUND_{cycle}_UPDATE.json', update)
        ack = exchange({'type': 'qualified', 'cycle': cycle, 'update': f'ROUND_{cycle}_UPDATE.json', 'updateSha256': digest(encode(update)), 'auditSha256': digest(encode(proof)), 'pin': opening[0], 'sealedAt': sample['sealedAt']}, s.started + 1140)
        recorded(s, f'ROUND_{cycle}_PUBLICATION_ACK.json', ack)
        accepted.append(ack)
        previous = number
    return {'status': 'COMPLETE_FINITE_TRIAL', 'rounds': len(accepted), 'integrityClosed': True}

def execute(mode, output, binding_path, test_transport=None, test_clock=None, test_sleep=None, test_exchange=None):
    root = Path(output).resolve()
    binding_path = Path(binding_path)
    binding = strict_json(binding_path.read_bytes())
    synthetic = test_transport is not None
    if mode not in ('once', 'trial') or binding['verdict'] != 'PASS' or bool(binding.get('synthetic')) != synthetic:
        raise ValueError('Exact gas preflight/mode')
    if binding['taskId'] != 'HDD-PULSECHAIN-GAS-FEED-R1' or binding['trialRoot'] != str(root):
        raise ValueError('Gas task/root binding')
    for name, expected in binding['runtimeFiles'].items():
        if digest((REPOSITORY / name).read_bytes()) != expected:
            raise ValueError('Frozen source/runtime changed')
    for name, expected in binding['inputFiles'].items():
        if digest((binding_path.parent / name).read_bytes()) != expected:
            raise ValueError('Plan/scope/real seed binding changed')
    if root.exists():
        raise ValueError('Existing or uncertain gas admission; no reset/restart')
    if shutil.disk_usage(root.parent).free < 20 * 1024 ** 3:
        raise ValueError('Admission disk space')
    root.mkdir()
    (root / 'temp').mkdir()
    nonce = secrets.token_hex(32)
    save(root / 'ADMISSION.json', {'task': binding['taskId'], 'nonce': nonce, 'recordedAt': utc(), 'runtimeFiles': binding['runtimeFiles'], 'preflightSha256': digest(binding_path.read_bytes()), 'mode': mode, 'maximum': 1 if mode == 'once' else 3})
    s = GasSession(root, test_transport, test_clock, test_sleep, True) if synthetic else GasSession(root, WorkerTransport(nonce, worker_path=HERE / 'worker.py'))
    incoming = queue.Queue()

    def reader():
        try:
            for line in sys.stdin:
                if len(line) > 32768:
                    raise ValueError('IPC bound')
                incoming.put(strict_json(line))
        finally:
            incoming.put(None)
    if test_exchange is None:
        threading.Thread(target=reader, daemon=True).start()

    def exchange(message, deadline):
        if test_exchange:
            return test_exchange(message, deadline)
        allowance = min(30, deadline - s.clock())
        if allowance <= 0:
            raise Stop('No publication/controller time')
        message['expiresAtUnixSeconds'] = time.time() + allowance
        print(json.dumps(message), flush=True)
        try:
            answer = incoming.get(timeout=allowance)
        except queue.Empty:
            raise Stop('Publication acknowledgement deadline')
        if not isinstance(answer, dict) or answer.get('cycle') != message['cycle'] or answer.get('ok') is not True:
            raise Stop('Controller failure/unknown ' + str(answer))
        return answer
    try:
        result = run_cycles(s, 1 if mode == 'once' else 3, exchange)
    except BaseException as e:
        result = {'status': 'PARTIAL', 'failure': type(e).__name__ + ': ' + str(e), 'integrityClosed': False, 'rounds': len(list(root.glob('ROUND_*_PUBLICATION_ACK.json')))}
    finally:
        s.close(result.get('failure', 'Finite gas session closed'))
        result.update(accounting=s.state, networkSessionCount=0 if synthetic else 1, noAutomaticRestart=True, indexer='PARKED')
        recorded(s, 'RESULT.json', result)
        print(json.dumps({'type': 'closed', 'result': result}), flush=True)
    return 0 if result['status'] == 'COMPLETE_FINITE_TRIAL' else 2

def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('once', 'trial'):
        print('Explicit once|trial OUTPUT PREFLIGHT required. No default requests.')
        return 2
    return execute(*sys.argv[1:])
if __name__ == '__main__':
    sys.exit(main())
