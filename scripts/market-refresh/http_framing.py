"""Bounded HTTP body framing; no network, endpoints, retries or identity policy."""
import hashlib,io,os,re
from pathlib import Path

MAX_LINE=4096
MAX_FRAMING=65536
MAX_CHUNKS=16384
MAX_TRAILER_BYTES=8192
MAX_TRAILER_FIELDS=32
TOKEN=rb"[!#$%&'*+\-.^_`|~0-9A-Za-z]+"
QUOTED=rb'"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"'
EXT=re.compile(rb'(?:[ \t]*;[ \t]*'+TOKEN+rb'(?:[ \t]*=[ \t]*(?:'+TOKEN+rb'|'+QUOTED+rb'))?)*[ \t]*')
FORBIDDEN_TRAILERS={b'content-length',b'transfer-encoding',b'content-encoding',b'host',b'connection',b'trailer',b'authorization',b'proxy-authorization',b'www-authenticate',b'proxy-authenticate',b'cookie',b'set-cookie',b'content-type',b'content-range',b'range',b'location'}

def header_mode(headers):
    values=lambda name:[v.strip() for k,v in headers if k.lower()==name]
    lengths=values('content-length');transfers=values('transfer-encoding');encodings=values('content-encoding')
    if encodings and (len(encodings)!=1 or encodings[0].lower()!='identity'):raise ValueError('Unsupported Content-Encoding')
    if transfers:
        if lengths:raise ValueError('Conflicting Transfer-Encoding and Content-Length')
        if len(transfers)!=1 or transfers[0].lower()!='chunked':raise ValueError('Unsupported/duplicate Transfer-Encoding')
        return 'chunked',None
    if len(lengths)!=1 or not re.fullmatch(r'[0-9]{1,20}',lengths[0]):raise ValueError('Missing/invalid/duplicate Content-Length')
    return 'content-length',int(lengths[0])

def chunk_size(line):
    if not line.endswith(b'\r\n') or len(line)>MAX_LINE:raise ValueError('Incomplete/oversized chunk-size line')
    match=re.fullmatch(rb'([0-9A-Fa-f]{1,16})(.*)',line[:-2])
    if not match or not EXT.fullmatch(match[2]):raise ValueError('Invalid chunk size/extension')
    return int(match[1],16)

def trailer(line):
    if not line.endswith(b'\r\n') or len(line)>MAX_LINE:raise ValueError('Incomplete/oversized trailer line')
    if line==b'\r\n':return
    name,sep,value=line[:-2].partition(b':')
    if not sep or not re.fullmatch(TOKEN,name) or name.lower() in FORBIDDEN_TRAILERS:raise ValueError('Invalid/forbidden trailer field')
    if any(x<32 and x!=9 or x==127 for x in value):raise ValueError('Invalid trailer value')

def write_all(handle,raw):
    view=memoryview(raw)
    while view:
        n=handle.write(view)
        if not isinstance(n,int) or n<=0 or n>len(view):raise OSError('Incomplete local body/framing write')
        view=view[n:]

def read_chunked(fp,on_data,on_framing,capacity):
    wire=decoded=framing=chunks=trailer_bytes=trailer_fields=0
    wire_hash=hashlib.sha256();framing_hash=hashlib.sha256()
    def overhead(raw):
        nonlocal wire,framing
        wire+=len(raw);framing+=len(raw)
        if wire>capacity or framing>MAX_FRAMING:raise ValueError('Chunked wire/framing byte ceiling')
        wire_hash.update(raw);framing_hash.update(raw);on_framing(raw)
    def line():
        remaining=capacity-wire
        if remaining<=0:raise ValueError('Chunked response byte ceiling before termination')
        raw=fp.readline(min(MAX_LINE+1,remaining));overhead(raw)
        if not raw.endswith(b'\r\n') or len(raw)>MAX_LINE:raise ValueError('Incomplete/oversized CRLF framing line')
        return raw
    while True:
        size=chunk_size(line())
        if size==0:break
        chunks+=1
        if chunks>MAX_CHUNKS:raise ValueError('Chunk-count ceiling')
        if size+2>capacity-wire:raise ValueError('Declared chunk exceeds remaining wire-body ceiling')
        left=size
        while left:
            raw=fp.read1(min(65536,left))
            if not raw:raise ValueError('Premature EOF inside chunk')
            if len(raw)>left:raise ValueError('Chunk reader overrun')
            left-=len(raw);decoded+=len(raw);wire+=len(raw);wire_hash.update(raw);on_data(raw)
        terminator=fp.read(2);overhead(terminator)
        if terminator!=b'\r\n':raise ValueError('Invalid/missing chunk payload CRLF')
    while True:
        raw=line();trailer_bytes+=len(raw)
        if trailer_bytes>MAX_TRAILER_BYTES:raise ValueError('Trailer byte ceiling')
        trailer(raw)
        if raw==b'\r\n':break
        trailer_fields+=1
        if trailer_fields>MAX_TRAILER_FIELDS:raise ValueError('Trailer field ceiling')
    return {'framingKind':'chunked','framingVersion':1,'expectedBodyBytes':decoded,
            'expectedBodyBytesBasis':'validated-chunk-termination','wireBodyBytes':wire,
            'framingBytes':framing,'framingSha256':framing_hash.hexdigest(),'wireBodySha256':wire_hash.hexdigest(),
            'chunkCount':chunks,'trailerBytes':trailer_bytes,'trailerFields':trailer_fields,
            'terminalChunkValidated':True,'trailerSectionValidated':True}

def stream_body(response,body_path,record,capacity=4194304):
    """Capture decoded JSON exactly; chunk framing has a separate bounded sidecar."""
    mode,expected=header_mode(response.getheaders());record['framingKind']=mode
    if mode=='content-length':
        record['expectedBodyBytes']=expected;record['expectedBodyBytesBasis']='content-length'
        if expected>capacity:raise ValueError('Declared body exceeds ceiling')
        if response.length!=expected or response.chunked:raise ValueError('HTTP framing state mismatch')
        size=0;wire_hash=hashlib.sha256()
        with Path(body_path).open('xb',buffering=0) as body:
            while size<expected:
                raw=response.read1(min(65536,expected-size))
                if not raw:raise ValueError('Premature EOF before declared Content-Length')
                if len(raw)>expected-size:raise ValueError('Content-Length reader overrun')
                write_all(body,raw);size+=len(raw);wire_hash.update(raw)
            if response.length!=0:raise ValueError('Unconsumed Content-Length')
            os.fsync(body.fileno())
        record.update(wireBodyBytes=size,framingBytes=0,wireBodySha256=wire_hash.hexdigest())
    else:
        if not response.chunked or response.length is not None or response.fp is None:raise ValueError('HTTP chunked framing state mismatch')
        with Path(body_path).open('xb',buffering=0) as body,Path(body_path).with_suffix('.framing').open('xb',buffering=0) as framing:
            fields=read_chunked(response.fp,lambda b:write_all(body,b),lambda b:write_all(framing,b),capacity)
            os.fsync(body.fileno());os.fsync(framing.fileno())
        record.update(fields);response.close()
    record.update(complete=True,framingValidated=True)

class EvidenceReader:
    """Reinterleave retained decoded bytes and framing for independent saved checks."""
    def __init__(self,body,framing):self.body=io.BytesIO(body);self.framing=io.BytesIO(framing)
    def readline(self,n):return self.framing.readline(n)
    def read1(self,n):return self.body.read(n)
    def read(self,n):return self.framing.read(n)

def verify_framing(record,raw,capacity,framing=None):
    """Return conservative complete-body charge. Incomplete requests keep capacity."""
    if record.get('complete') is not True or record.get('framingValidated') is not True:raise ValueError('Incomplete framing receipt')
    mode,declared=header_mode(record.get('headers',[]))
    if record.get('framingKind',mode)!=mode:raise ValueError('Framing receipt/header mismatch')
    if type(record.get('expectedBodyBytes')) is not int or record['expectedBodyBytes']!=len(raw) or len(raw)>capacity:raise ValueError('Decoded body length qualification')
    if mode=='content-length':
        if declared!=len(raw) or record.get('wireBodyBytes',len(raw))!=len(raw) or record.get('framingBytes',0)!=0:raise ValueError('Declared framing length mismatch')
        if 'wireBodySha256' in record and record['wireBodySha256']!=hashlib.sha256(raw).hexdigest():raise ValueError('Content-Length body hash mismatch')
        return len(raw)
    if not isinstance(framing,bytes) or len(framing)>MAX_FRAMING or len(raw)+len(framing)>capacity:raise ValueError('Missing/oversized framing evidence')
    reader=EvidenceReader(raw,framing);decoded=hashlib.sha256()
    fields=read_chunked(reader,decoded.update,lambda _:None,capacity)
    if reader.body.read(1) or reader.framing.read(1):raise ValueError('Unconsumed body/framing evidence')
    if decoded.hexdigest()!=hashlib.sha256(raw).hexdigest():raise ValueError('Reconstructed body differs')
    for k,v in fields.items():
        if type(record.get(k)) is not type(v) or record.get(k)!=v:raise ValueError('Chunk framing evidence/receipt mismatch: '+k)
    return fields['wireBodyBytes']
