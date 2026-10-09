"""One bounded exact GET; serial scheduling and retries belong solely to parent."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import http.client, socket, os
W = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(W / 'scripts/market-refresh'))
from durable import save, strict_json, digest
from http_framing import stream_body
CAP = 1048576
HEADER_CAP = 65536

class HeaderReader:

    def __init__(self, fp, sink):
        self.fp = fp
        self.sink = sink
        self.used = 0
        self.enabled = True

    def readline(self, n=-1):
        if not self.enabled:
            return self.fp.readline(n)
        left = HEADER_CAP - self.used
        if left <= 0:
            raise ValueError('Aggregate header bound')
        raw = self.fp.readline(min(4096, left, n if n >= 0 else 4096))
        self.used += len(raw)
        self.sink.write(raw)
        self.sink.flush()
        if not raw.endswith(b'\r\n'):
            raise ValueError('Header line/aggregate bound or invalid CRLF')
        return raw

    def __getattr__(self, name):
        return getattr(self.fp, name)

def perform(url, folder, connection=http.client.HTTPSConnection):
    record = {'status': None, 'complete': False, 'failureKind': None, 'connectionClosed': False}
    meta = folder / 'response.json'
    save(meta, record)
    conn = connection('www.bitstamp.net', port=443, timeout=24)
    try:
        with (folder / 'response.headers').open('xb') as sink:

            class Response(http.client.HTTPResponse):

                def begin(self):
                    if self.headers is not None:
                        return
                    self.fp = HeaderReader(self.fp, sink)
                    reader = self.fp
                    try:
                        super().begin()
                    finally:
                        reader.enabled = False
                        record['headerBytes'] = reader.used
            conn.response_class = Response
            try:
                conn.request('GET', url[len('https://www.bitstamp.net'):], headers={'Accept': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'HDD-Bounded-Historical-Reference/1', 'Connection': 'close'})
                response = conn.getresponse()
                record.update(status=response.status, headers=response.getheaders())
                save(meta, record)
                stream_body(response, folder / 'response.body', record, CAP)
            finally:
                sink.flush()
                os.fsync(sink.fileno())
    except (TimeoutError, socket.timeout) as e:
        record.update(complete=False, failureKind='timeout', error=str(e))
    except BaseException as e:
        record.update(complete=False, failureKind='terminal', error=type(e).__name__ + ': ' + str(e))
    finally:
        try:
            conn.close()
            record['connectionClosed'] = True
        finally:
            save(meta, record)

def main():
    request = Path(sys.argv[1]).resolve()
    root = Path(sys.argv[2]).resolve()
    session = root / 'session'
    assert request.parent.parent == session
    q = strict_json(request.read_bytes())
    a = strict_json((session / 'ADMISSION.json').read_bytes())
    s = strict_json((session / 'ACCOUNTING.json').read_bytes())
    scope = strict_json((root / 'SCOPE.json').read_bytes())
    assert str(root) == scope['local']['taskOutputRoot']
    allowed = scope['network']['normalRequests'] + [q for c in scope['network']['conditionalRequests'] for q in c['alternatives']]
    assert q['logical'] in allowed and q['nonce'] == a['nonce']
    assert s['status'] == 'ADMITTED' and s['pending']['request'] == str(request) and (s['attempts'] == q['attempt'])
    for p, h in a['bindings'].items():
        assert digest(Path(p).read_bytes()) == h, p
    perform(q['logical']['url'], request.parent)
if __name__ == '__main__':
    main()
