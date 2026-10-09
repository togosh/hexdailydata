"""Finite candidate acquisition. One admitted native owner, no publication/restart."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import os, shutil, subprocess, time, secrets
W = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(W / 'scripts/market-refresh'))
from durable import save, strict_json, digest, utc
from http_framing import verify_framing
CAP = 1048576
HEADER = 65536
RESERVATION = CAP + HEADER

def native(args, env, wait=27, reap=2):
    started = time.monotonic()
    child = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    reaped = False
    interrupted = None
    timed = False
    out = b''
    err = b''
    try:
        out, err = child.communicate(timeout=wait)
        reaped = True
    except BaseException as e:
        timed = isinstance(e, subprocess.TimeoutExpired)
        interrupted = type(e).__name__ + ': ' + str(e)
        try:
            child.kill()
        except BaseException as k:
            err = str(k).encode()
        try:
            out, err = child.communicate(timeout=reap)
            reaped = True
        except BaseException as k:
            err = str(k).encode()
            try:
                reaped = child.poll() is not None
            except BaseException:
                reaped = False
    return {'reaped': reaped, 'timeout': timed, 'interrupted': interrupted, 'exit': child.returncode, 'seconds': time.monotonic() - started, 'stdout': out.decode(errors='replace')[:2048], 'stderr': err.decode(errors='replace')[:2048]}

def retryable(row):
    return row['closed'] and (row['failureKind'] == 'timeout' and (not row.get('integrityFailure')) or (row['complete'] and row.get('status') in (502, 503, 504)))

def run(root):
    root = Path(root).resolve()
    scope = strict_json((root / 'SCOPE.json').read_bytes())
    net = scope['network']
    local = scope['local']
    assert str(root) == local['taskOutputRoot']
    pre = strict_json((root / 'PREFLIGHT.json').read_bytes())
    assert pre['verdict'] == 'PASS'
    for p, h in pre['bindings'].items():
        assert digest(Path(p).read_bytes()) == h, p
    assert shutil.disk_usage(root).free >= local['minimumAdmissionFreeBytes']
    session = root / 'session'
    session.mkdir()
    start = time.monotonic()
    last = None
    nonce = secrets.token_hex(16)
    state = {'status': 'ADMITTED', 'startedAtUtc': utc(), 'attempts': 0, 'logicalRequests': 0, 'extras': 0, 'chargedBytes': 0, 'observedBodyBytes': 0, 'chargedObjects': 0, 'pending': None, 'requests': [], 'acceptedAttempts': [], 'closureKnown': True}
    save(session / 'ADMISSION.json', {'nonce': nonce, 'startedAtUtc': state['startedAtUtc'], 'bindings': pre['bindings'], 'preflightSha256': digest((root / 'PREFLIGHT.json').read_bytes())})
    save(session / 'ACCOUNTING.json', state)
    queue = list(net['normalRequests'])
    conditional = set()
    outcome = 'PARTIAL'
    reason = 'Not completed'
    env = {k: v for k, v in os.environ.items() if k.upper() in ('PATH', 'SYSTEMROOT', 'WINDIR')}
    env.update(TEMP=str(root / 'temp'), TMP=str(root / 'temp'))
    try:
        position = 0
        while position < len(queue):
            q = queue[position]
            position += 1
            state['logicalRequests'] += 1
            if state['logicalRequests'] > net['maximumLogicalRequests']:
                raise ValueError('Logical ceiling')
            for ordinal in (0, 1):
                if last is not None:
                    time.sleep(max(0, last + (2 if ordinal else 1) - time.monotonic()))
                if time.monotonic() - start > 565 or state['attempts'] >= 14 or state['chargedBytes'] + RESERVATION > 16777216 or (state['chargedObjects'] + q['query']['limit'] > 14000) or (ordinal and state['extras'] >= 4):
                    raise ValueError('Deadline/attempt/byte/object/retry ceiling')
                if shutil.disk_usage(root).free < local['minimumOngoingFreeBytes']:
                    raise ValueError('Free space floor')
                directory = session / f"{state['attempts'] + 1:02d}"
                directory.mkdir()
                request = directory / 'request.json'
                save(request, {'logical': q, 'attempt': state['attempts'] + 1, 'nonce': nonce, 'retryOrdinal': ordinal})
                state['attempts'] += 1
                state['extras'] += ordinal
                state['chargedBytes'] += RESERVATION
                state['chargedObjects'] += q['query']['limit']
                state['pending'] = {'attempt': state['attempts'], 'request': str(request), 'reservedBytes': RESERVATION, 'chargedObjects': q['query']['limit'], 'startedAtUtc': utc()}
                save(session / 'ACCOUNTING.json', state)
                if time.monotonic() - start > 565:
                    raise ValueError('Predispatch deadline after durable reservation')
                run = native([sys.executable, '-I', '-S', str(W / 'scripts/benchmark-reference/get_worker.py'), str(request), str(root)], env)
                last = time.monotonic()
                state['closureKnown'] = run['reaped']
                meta = directory / 'response.json'
                r = strict_json(meta.read_bytes()) if meta.exists() else {}
                body = directory / 'response.body'
                raw = body.read_bytes() if body.exists() else b''
                complete = run['reaped'] and run['exit'] == 0 and (run['interrupted'] is None) and (r.get('complete') is True) and (r.get('connectionClosed') is True)
                charge = RESERVATION
                integrity = None
                if complete:
                    try:
                        framing = directory / 'response.framing'
                        if not 0 <= r['headerBytes'] <= HEADER:
                            raise ValueError('Header bound')
                        if (directory / 'response.headers').stat().st_size != r['headerBytes']:
                            raise ValueError('Header capture mismatch')
                        charge = verify_framing(r, raw, CAP, framing.read_bytes() if framing.exists() else None) + HEADER
                    except Exception as e:
                        complete = False
                        integrity = str(e)
                failure = 'timeout' if run['timeout'] and run['reaped'] else r.get('failureKind')
                if run['interrupted'] and (not run['timeout']):
                    failure = 'interrupted'
                row = {**state['pending'], **r, 'logicalId': q['id'], 'url': q['url'], 'retryOrdinal': ordinal, 'complete': complete, 'closed': run['reaped'], 'failureKind': failure, 'integrityFailure': integrity, 'native': run, 'chargedBytes': charge, 'fixedHeaderCharge': HEADER, 'bodyBytes': len(raw), 'bodySha256': digest(raw), 'finishedAtUtc': utc()}
                save(directory / 'CAPTURE.json', row)
                state['chargedBytes'] -= RESERVATION - charge
                state['observedBodyBytes'] += len(raw)
                state['requests'].append(row)
                state['pending'] = None
                save(session / 'ACCOUNTING.json', state)
                if run['seconds'] > 30:
                    raise ValueError('Per-request native deadline exceeded')
                if not run['reaped'] or integrity or failure in ('terminal', 'interrupted') or (run['exit'] not in (0, -9, 1) and (not run['timeout'])):
                    raise ValueError('Terminal transport/closure/integrity failure')
                if r.get('status') in (401, 403, 407, 429) or (isinstance(r.get('status'), int) and 300 <= r['status'] < 400):
                    raise ValueError('Access/rate restriction or redirect')
                if complete and r.get('status') == 200:
                    validation = native(['node', str(W / 'scripts/benchmark-reference.mjs'), 'validate', str(root), str(directory)], env, wait=4, reap=1)
                    save(directory / 'VALIDATOR_PROCESS.json', validation)
                    if not validation['reaped']:
                        state['closureKnown'] = False
                    if not validation['reaped'] or validation['exit'] != 0 or validation['interrupted']:
                        raise ValueError('Saved page validation failed')
                    page = strict_json((directory / 'VALIDATION.json').read_bytes())
                    state['acceptedAttempts'].append(state['attempts'])
                    save(session / 'ACCOUNTING.json', state)
                    if not page['coverage']['continueAcquisition']:
                        raise ValueError('Coverage stop: ' + page['coverage']['reason'])
                    edge = page.get('conditionalEdge')
                    if edge and q['asset'] not in conditional:
                        allowed = next((c for c in net['conditionalRequests'] if c['asset'] == q['asset']))['alternatives']
                        if edge not in allowed:
                            raise ValueError('Conditional query substitution')
                        conditional.add(q['asset'])
                        queue.insert(position, edge)
                    break
                if ordinal == 0 and retryable(row) and (state['extras'] < 4):
                    continue
                raise ValueError('Unusable response or exhausted exact query')
        outcome = 'ACQUISITION_COMPLETE'
        reason = 'All permitted normal and eligible edge requests captured and validated'
    except BaseException as e:
        reason = type(e).__name__ + ': ' + str(e)
    finally:
        elapsed = time.monotonic() - start
        if elapsed > 600:
            outcome = 'PARTIAL'
            reason = 'Whole-session deadline exceeded: ' + reason
        state.update(status='CLOSED' if state['closureKnown'] and state['pending'] is None else 'STOPPED_UNCERTAIN', outcome=outcome, reason=reason, closedAtUtc=utc(), elapsedSeconds=elapsed, noAutomaticRestart=True, conditionalAssets=sorted(conditional))
        save(session / 'ACCOUNTING.json', state)
    print({'status': state['status'], 'outcome': outcome, 'attempts': state['attempts'], 'chargedBytes': state['chargedBytes'], 'reason': reason})
    return 0 if outcome == 'ACQUISITION_COMPLETE' and state['status'] == 'CLOSED' else 2
if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'run':
        sys.exit(run(sys.argv[2]))
    print('Zero-request default. One fresh preflight-bound candidate session; no resume or publication.')
