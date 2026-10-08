"""Task-local fsync/atomic receipts, exclusive files and conservative storage charging."""
import hashlib,json,os,shutil
from pathlib import Path
from datetime import datetime,timezone

def utc():return datetime.now(timezone.utc).isoformat()
def digest(data):return hashlib.sha256(data).hexdigest()
def encode(value):return (json.dumps(value,separators=(',',':'),ensure_ascii=True)+'\n').encode()
def selected_digest(value):return digest(json.dumps(value,separators=(',',':'),sort_keys=True,ensure_ascii=True).encode())
def strict_json(raw):
    def unique(pairs):
        obj={}
        for key,value in pairs:
            if key in obj:raise ValueError('Duplicate JSON key')
            obj[key]=value
        return obj
    def invalid(_):raise ValueError('Nonfinite JSON')
    return json.loads(raw,object_pairs_hook=unique,parse_constant=invalid)

def save(path,obj):
    # Retains the accepted census atomic receipt pattern, adding exclusive temp creation.
    path=Path(path);tmp=path.with_name(path.name+'.tmp')
    with tmp.open('xb') as f:
        f.write(encode(obj));f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)

class Storage:
    def __init__(self,root,limit=8*1024**3,free_floor=10*1024**3,used=0):
        self.root=Path(root);self.limit=limit;self.free_floor=free_floor;self.used=used;self.bytes_written=0
    def check(self,n,acquisition=False):
        if n<0 or self.used+n>self.limit:raise ValueError('Storage ceiling')
        if acquisition and 2*(self.used+n)+512*1024**2>self.limit:raise ValueError('Storage reserved for summary and bounded parts')
        if shutil.disk_usage(self.root).free-n<self.free_floor:raise ValueError('Protected free space')
    def reserve(self,n,acquisition=False):
        self.check(n,acquisition);self.used+=n
    def put(self,path,raw,replace=False):
        path=self.target(path);self.check(2*len(raw));self.reserve(len(raw));path.parent.mkdir(parents=True,exist_ok=True)
        if replace:
            tmp=path.with_name(path.name+'.tmp')
            with tmp.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
            os.replace(tmp,path)
        else:
            with path.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        self.bytes_written+=len(raw)
    def json(self,path,obj,replace=False):self.put(path,encode(obj),replace)
    def append(self,path,obj):
        self.append_raw(path,encode(obj))
    def append_raw(self,path,raw):
        path=self.target(path);self.reserve(len(raw));path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('ab') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        self.bytes_written+=len(raw)
    def target(self,path):
        path=Path(path)
        if path.is_symlink() or not path.resolve().is_relative_to(self.root.resolve()):raise ValueError('Write escaped new session root')
        return path

