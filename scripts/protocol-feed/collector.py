"""One finite protocol observation session; explicit parent publication acknowledgement."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]
sys.path[:0] = [str(HERE), str(HERE.parent / 'market-refresh')]
import time, json, secrets, queue, threading, shutil
from durable import strict_json, encode, digest, save, utc
from capture_client import WorkerTransport, Stop
from session import ProtocolSession
from protocol import job, call, compare_headers, compare_closing_header, BASE_TAIL
from audit import audit_round

def recorded(s, name, value):
    s.storage.json(s.root / name, value)

def run_cycles(s, maximum, exchange):
    for ep in (0, 1):
        s.request(job(ep, 'eth_chainId', []))
    last_start = None
    previous = 27720851
    end = 2498
    tail = BASE_TAIL[:]
    accepted = []
    for cycle in range(1, maximum + 1):
        if last_start is not None:
            s.sleep(max(0, 60 - (s.clock() - last_start)))
        s.cycle_started = s.clock()
        last_start = s.cycle_started
        s.cycle_ordinal = cycle
        s.closing = False

        def controls(number, pin):
            return [job(ep, 'eth_call', call('global', pin), cycle, 'close-global') for ep in (0, 1)] + [job(ep, 'eth_getBlockByNumber', [hex(number), False], cycle, 'close') for ep in (0, 1)]
        s.controls = controls(27720852, '0x' + '0' * 64)
        exchange({'type': 'begin', 'cycle': cycle}, s.started + 1620)
        calls = {}

        def ask(key, ep, m, p, phase):
            cap, v = s.request(job(ep, m, p, cycle, phase))
            calls[key] = cap['attempt']
            return v
        heads = [ask('head' + str(ep), ep, 'eth_getBlockByNumber', ['latest', False], 'head') for ep in (0, 1)]
        number = min((h['number'] for h in heads)) - 2
        if number <= previous:
            raise Stop('Non-increasing chosen pin; no replacement')
        binding = {'number': number, 'latest': [h['number'] for h in heads], 'cycleStartOffsetSeconds': s.cycle_started - s.started, 'end': end}
        recorded(s, f'CYCLE_{cycle}_BINDING.json', binding)
        opening = [ask('open' + str(ep), ep, 'eth_getBlockByNumber', [hex(number), False], 'open') for ep in (0, 1)]
        compare_headers(*opening)
        if not 0 <= time.time() - opening[0]['timestamp'] <= 300:
            raise Stop('Nonfuture timely header required')
        pin = opening[0]['hash']
        binding['hash'] = pin
        recorded(s, f'CYCLE_{cycle}_PIN.json', binding)
        s.controls = controls(number, pin)
        if cycle == 1:
            from protocol import CONTRACT
            for ep in (0, 1):
                ask('code' + str(ep), ep, 'eth_getCode', [CONTRACT, hex(number)], 'code')
        globals_ = [ask('global' + str(ep), ep, 'eth_call', call('global', pin), 'global') for ep in (0, 1)]
        if globals_[0] != globals_[1]:
            raise Stop('Paired global mismatch')
        w = list(map(int, globals_[0]))
        d = w[4]
        if w[10] != opening[0]['timestamp'] or not 0 <= d <= (w[10] - 1575331200) // 86400 <= 65535:
            raise Stop('Global time/day mismatch')
        if d < end or d - end > 32:
            raise Stop('Bounded catch-up: dailyCount outside accepted end plus 32')
        binding['dailyCount'] = d
        recorded(s, f'CYCLE_{cycle}_RANGE.json', binding)
        for ep in (0, 1):
            supply = ask('supply' + str(ep), ep, 'eth_call', call('supply', pin), 'supply')
            if supply != [globals_[0][11]]:
                raise Stop('Supply corroboration mismatch')
        ranges = [ask('range' + str(ep), ep, 'eth_call', call('range', pin, end - 2, d), 'range') for ep in (0, 1)]
        if ranges[0] != ranges[1] or ranges[0][:2] != tail:
            raise Stop('Paired range/immutable overlap mismatch')
        if d > end:
            for phase, day in [('first', end)] if d == end + 1 else [('first', end), ('last', d - 1)]:
                from protocol import unpack
                for ep in (0, 1):
                    getter = ask(phase + str(ep), ep, 'eth_call', call('daily', pin, day), phase)
                    if getter != unpack(int(ranges[0][day - end + 2])):
                        raise Stop('Range/getter mismatch')
        s.closing = True
        while s.controls:
            q = s.controls.pop(0)
            ep = q['endpoint']
            cap, v = s.request(q)
            calls[q['phase'] + str(ep)] = cap['attempt']
            if q['phase'] == 'close-global':
                if v != globals_[ep]:
                    raise Stop('Closing all-word global mismatch')
            else:
                compare_closing_header(opening[ep], v)
        sample = {'cycle': cycle, 'calls': calls, 'selectedBlock': number, 'sealedAt': utc()}
        recorded(s, f'ROUND_{cycle}_SAMPLE.json', sample)
        s.persist()
        proof, update = audit_round(s.root, sample, s.state)
        recorded(s, f'ROUND_{cycle}_AUDIT.json', proof)
        recorded(s, f'ROUND_{cycle}_UPDATE.json', update)
        ack = exchange({'type': 'qualified', 'cycle': cycle, 'update': f'ROUND_{cycle}_UPDATE.json', 'updateSha256': digest(encode(update)), 'auditSha256': digest(encode(proof)), 'pin': opening[0], 'sealedAt': sample['sealedAt']}, s.started + 1770)
        recorded(s, f'ROUND_{cycle}_PUBLICATION_ACK.json', ack)
        accepted.append(ack)
        tail = (tail + update['ledgerAppend']['words'])[-2:]
        end = d
        previous = number
    return {'status': 'COMPLETE_FINITE_TRIAL', 'rounds': len(accepted), 'integrityClosed': True, 'ledgerEnd': end, 'appendedDays': end - 2498}

def execute(mode, output, binding_path, test_transport=None, test_clock=None, test_sleep=None, test_exchange=None):
    root = Path(output).resolve()
    binding_path = Path(binding_path)
    binding = strict_json(binding_path.read_bytes())
    synthetic = test_transport is not None
    if mode not in ('once', 'trial') or binding['verdict'] != 'PASS' or bool(binding.get('synthetic')) != synthetic:
        raise ValueError('Exact protocol preflight/mode')
    if binding['taskId'] != 'HDD-HEX-PROTOCOL-DAILY-REFRESH-R1' or binding['trialRoot'] != str(root):
        raise ValueError('Protocol task/root binding')
    for name, expected in binding['runtimeFiles'].items():
        if digest((REPOSITORY / name).read_bytes()) != expected:
            raise ValueError('Frozen source/runtime changed')
    for name, expected in binding['inputFiles'].items():
        if digest((binding_path.parent / name).read_bytes()) != expected:
            raise ValueError('Plan/scope/real seed binding changed')
    if root.exists():
        raise ValueError('Existing or uncertain protocol admission; no reset/restart')
    if shutil.disk_usage(root.parent).free < 10 * 1024 ** 3:
        raise ValueError('Admission disk space')
    root.mkdir()
    (root / 'temp').mkdir()
    nonce = secrets.token_hex(32)
    save(root / 'ADMISSION.json', {'task': binding['taskId'], 'nonce': nonce, 'recordedAt': utc(), 'runtimeFiles': binding['runtimeFiles'], 'preflightSha256': digest(binding_path.read_bytes()), 'mode': mode, 'maximum': 1 if mode == 'once' else 3})
    s = ProtocolSession(root, test_transport, test_clock, test_sleep, True) if synthetic else ProtocolSession(root, WorkerTransport(nonce, worker_path=HERE / 'worker.py'))
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
        s.close(result.get('failure', 'Finite protocol session closed'))
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
