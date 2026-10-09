"""Focused review correction: qualified cycle remains auditable after terminal JSON roots."""
import sys, copy
sys.dont_write_bytecode=True
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from client import Tests,Transport,run_cycles,Stop,strict_json,encode,R
from audit import audit_captures,audit_round
records=[]
for value in ([],None,1,'scalar'):
    class TerminalRoot(Transport):
        def __call__(self,path,deadline,storage):
            q=strict_json(path.read_bytes())['job']
            if q['cycle']==2 and q['phase']=='head':
                return Transport([value])(path,deadline,storage)
            return super().__call__(path,deadline,storage)
    s,c=Tests().session(TerminalRoot())
    try:run_cycles(s,lambda m,d:{'ok':True,'cycle':m['cycle']})
    except Stop:pass
    else:raise AssertionError('Terminal root accepted')
    s.close('synthetic terminal root after qualified cycle')
    assert s.state['attempts']==33 and s.state['extraAttempts']==0
    caps,charges=audit_captures(s.root,s.state)
    cap=caps[33][0]
    assert cap['chargedEntities']==128 and cap['complete'] and cap['closureKnown'] and not cap['usable']
    proof,update=audit_round(s.root,strict_json((s.root/'ROUND_1_SAMPLE.json').read_bytes()),s.state)
    assert proof['status']=='PASS' and len(update['readings'])==2
    for field in ('rpcAttempts','rpcChargedBytes','graphAttempts','graphChargedBytes','docsAttempts','docsChargedBytes'):
        altered=copy.deepcopy(s.state);altered[field]+=1
        try:audit_captures(s.root,altered)
        except ValueError:pass
        else:raise AssertionError('Protocol counter mismatch accepted '+field)
    records.append({'synthetic':True,'root':str(s.root),'terminalRoot':value,'attempts':33,'terminalChargedObjects':128,'priorQualifiedCycleReplay':'PASS','protocolCounterTamper':'rejected','charges':charges})
(R/'evidence/AUDIT_RECHECK.json').write_bytes(encode({'status':'PASS','externalRequests':0,'cases':records}))
print('PASS four terminal JSON roots retain charges and prior qualified cycle; protocol counter mismatches rejected')
