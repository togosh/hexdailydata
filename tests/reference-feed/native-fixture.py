"""Native IPC test only: injected transport and virtual waits, networking denied."""
import sys, json
sys.dont_write_bytecode = True
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from client import ReferenceSession, Clock, Transport, run_cycles, strict_json
root=Path(sys.argv[1]); c=Clock(); s=ReferenceSession(root,Transport(),c,c.sleep,True)
def exchange(message,deadline):
    import time
    message['expiresAtUnixSeconds']=time.time()+29
    print(json.dumps(message),flush=True)
    answer=strict_json(sys.stdin.readline())
    if answer.get('ok') is not True or answer.get('cycle')!=message['cycle']: raise ValueError('Synthetic parent acknowledgement')
    return answer
try:result=run_cycles(s,exchange)
except BaseException as e:result={'status':'PARTIAL','failure':str(e)}
finally:
    s.close(result.get('failure','Synthetic native job complete'))
    result.update(accounting=s.state,synthetic=True,networkSessionCount=0)
    s.storage.json(root/'RESULT.json',result)
    print(json.dumps({'type':'closed','result':result}),flush=True)
raise SystemExit(0 if result['status'].startswith('COMPLETE_') else 2)
