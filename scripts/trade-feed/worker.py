"""One exact request; offline prefix mode denies all socket/DNS audit events."""
import sys
sys.dont_write_bytecode = True
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from diagnostics import Phases

RECOVERY = Path(r'C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\transport-recovery-r1')
ISOLATION = RECOVERY.parent/'worker-stdin-isolation-r1'
COOKIES = RECOVERY.parent/'response-cookie-handling-r1'


def perform_request(q, a, folder, perform, clock=time.time, connection=None, phases=None):
    import http.client
    connection = connection or http.client.HTTPSConnection
    deadline = a['startedAtUnixSeconds'] + 535
    if q['dispatchByUnixSeconds'] != deadline:
        raise ValueError('Dispatch deadline binding')

    def gate():
        if clock() >= deadline:
            raise ValueError('Dispatch deadline')

    def phase(name):
        if phases:
            phases.emit(name)

    gate()

    class DeadlineConnection(connection):
        def __init__(self, *args, **kwargs):
            phase('connection_local_preparation')
            super().__init__(*args, **kwargs)
            phase('connection_object_ready')

        def connect(self):
            gate()
            phase('dns_tcp_tls_connection_begin')
            gate()  # Durable diagnostics may stall; do not dispatch after them unchecked.
            super().connect()
            phase('dns_tcp_tls_connection_complete')

        def request(self, *args, **kwargs):
            gate()
            phase('request_begin')
            gate()
            result = super().request(*args, **kwargs)
            phase('request_complete')
            return result

        def getresponse(self):
            result = super().getresponse()
            phase('response_headers_complete')
            return result

        def close(self):
            super().close()
            phase('connection_closed')

    perform(q['url'], folder, DeadlineConnection)


def main():
    args = sys.argv[1:]
    offline = len(args) == 2 and args[0] in ('--offline-prefix', '--offline-stall')
    if not offline and len(args) != 1:
        print('No requests. Explicit bound request or synthetic offline prefix only.')
        return 0
    request = Path(args[-1]).resolve()
    if offline:
        if not any(request.is_relative_to(root/'fixtures') for root in (RECOVERY, ISOLATION)):
            raise ValueError('Exact synthetic fixture root required')

        def deny(event, values):
            if event.startswith('socket.'):
                raise PermissionError('OFFLINE_NETWORK_DENIED')
        sys.addaudithook(deny)
    phases = Phases(request.parent) if any(request.is_relative_to(root) for root in (RECOVERY, ISOLATION, COOKIES)) else None
    try:
        if phases:
            phases.emit('worker_entry', synthetic=offline)
        import importlib.util
        import http.client
        from client import W, TASK, exact_request, strict_json, digest, CAP
        from authority import validate_authority
        if phases:
            phases.emit('imports_complete')
        session = request.parent.parent
        q = strict_json(request.read_bytes())
        a = strict_json((session/'ADMISSION.json').read_bytes())
        s = strict_json((session/'ACCOUNTING.json').read_bytes())
        exact_request(q['method'], q['url'])
        assert a['task'] == TASK and a['family'] == 'trade' and a['synthetic'] is offline
        assert a['jobRoot'] == str(session)
        assert q['nonce'] == a['nonce'] and s['status'] == 'ADMITTED'
        assert s['pending']['request'] == str(request) and s['attempts'] == q['attempt']
        if offline:
            assert a['fixtureIdentity'] == 'SYNTHETIC_OFFLINE_WORKER_PREFIX'
        else:
            validate_authority(a, session)
        if phases:
            phases.emit('admission_shape_validated')
            phases.emit('runtime_binding_begin', count=len(a['runtimeFiles']))
        for index, (p, h) in enumerate(a['runtimeFiles'].items(), 1):
            assert digest((W/p).read_bytes()) == h, p
            if phases and index % 128 == 0:
                phases.emit('runtime_binding_progress', files=index)
        if phases:
            phases.emit('runtime_binding_complete')
        spec = importlib.util.spec_from_file_location('bounded_get', W/'scripts/benchmark-reference/get_worker.py')
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.CAP = CAP
        save = m.save

        def receipt(path, value):
            if phases:
                phases.emit('response_receipt_write_begin', complete=bool(value.get('complete')))
            if offline:
                value['synthetic'] = True
            if value.get('error'):
                value['error'] = str(value['error']).encode()[:1024].decode(errors='ignore')
            save(path, value)
            if phases:
                phases.emit('response_receipt_persisted', complete=bool(value.get('complete')))
        m.save = receipt
        stream_body = m.stream_body

        def body(*args, **kwargs):
            if phases:
                phases.emit('response_body_begin')
            result = stream_body(*args, **kwargs)
            if phases:
                phases.emit('response_body_complete')
            return result
        m.stream_body = body
        if offline:
            import socket
            try:
                socket.getaddrinfo('OFFLINE-DENIAL-WITNESS.invalid', 443)
            except PermissionError:
                phases.emit('hard_network_denial_verified')
            else:
                raise AssertionError('DNS denial failed')
            if args[0] == '--offline-stall':
                phases.emit('synthetic_stall')
                time.sleep(60)
            reached = []

            class FakeConnection(http.client.HTTPSConnection):
                def connect(self):
                    reached.append(True)
                    phases.emit('synthetic_connection_boundary')
                    raise PermissionError('SYNTHETIC_PRECONNECT_STOP')

            perform_request(q, a, request.parent, m.perform, connection=FakeConnection, phases=phases)
            assert reached and strict_json((request.parent/'response.json').read_bytes())['synthetic'] is True
            phases.emit('offline_prefix_complete')
        else:
            perform_request(q, a, request.parent, m.perform, phases=phases)
            if phases:
                phases.emit('worker_complete')
    except BaseException as error:
        if phases:
            phases.emit('worker_error', errorClass=type(error).__name__[:64])
        raise
    finally:
        if phases:
            phases.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
