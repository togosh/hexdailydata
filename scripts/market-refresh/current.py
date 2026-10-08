"""Current observation functions extracted from reviewed R2; no historical entrypoint."""
import time
from datetime import datetime,timezone
from durable import strict_json,selected_digest,utc
from task_queries import POOLS,TOKENS,SCOPE,graph_job,rpc_job,SELECTORS
from market import normalize,validate_pool_rpc,qualify,IntegrityError
def recorded(s,name,value):s.storage.json(s.root/name,value)

def ask(s,q,optional=False):return s.request(q,optional=optional)[1]

def descriptors():return [{'kind':k,'endpoint':ep,'maxRows':64 if k=='rpc' else 32} for k in ('pools','meta','rpc') for ep in (0,1)]

def pool_query(ep,sc,pin):return graph_job('pools',ep,pin=pin,deployment=sc['deployment'],recipe=sc['recipe'],addresses=sorted(a for a,p in POOLS.items() if p['graphEndpointIndex']==ep))

def common_pin(s,schemas,ordinal,previous=None):
    heads=[ask(s,rpc_job(ep,'eth_blockNumber',[])) for ep in (0,1)]
    gh=[ask(s,graph_job('meta',ep,pin=None,deployment=sc['deployment']))['_meta']['block']['number'] for ep,sc in schemas.items()]
    number=min(heads+gh)-12
    if previous and number<=previous['number']:return None
    p=s.root/'TARGET_NUMBERS.json';numbers=strict_json(p.read_bytes()) if p.exists() else []
    if number<=0 or len(numbers)>=3 or number in numbers:raise IntegrityError('Observation target scope')
    s.storage.json(p,numbers+[number],replace=p.exists())
    headers=[ask(s,rpc_job(ep,'eth_getBlockByNumber',[hex(number),False])) for ep in (0,1)]
    if headers[0]!=headers[1]:raise IntegrityError('Paired header mismatch')
    pin=headers[0]
    if previous and pin['timestamp']<=previous['timestamp']:raise IntegrityError('Nonadvancing observation time')
    p=s.root/'PINS.json';pins=strict_json(p.read_bytes()) if p.exists() else []
    s.storage.json(p,pins+[pin],replace=p.exists())
    recorded(s,f'ROUND_{ordinal}_PIN.json',{'pin':pin,'rpcHeads':heads,'graphHeads':gh,'bufferBlocks':12,'ageSecondsAtCapture':time.time()-pin['timestamp']})
    return pin

def contract_checks(s,cohort,pin,ordinal):
    allow={'pools':sorted(POOLS),'tokens':sorted(TOKENS),'pin':pin}
    p=s.root/'CONTRACT_ALLOWLIST.json'
    if p.exists():recorded(s,f'CONTRACT_ALLOWLIST_BEFORE_{ordinal}.json',strict_json(p.read_bytes()))
    s.storage.json(p,allow,replace=p.exists());allchecks=[]
    for a,f in sorted(POOLS.items()):
        checks=[]
        for ep in (0,1):
            checks.append({m:ask(s,rpc_job(ep,'eth_call',[{'to':a,'data':SELECTORS[m]},{'blockHash':pin['hash'],'requireCanonical':True}])) for m in ('token0()','token1()','factory()','getReserves()')})
        if checks[0]!=checks[1] or [checks[0]['token0()'],checks[0]['token1()']]!=[f['originalPool'][k]['id'] for k in ('token0','token1')]:raise IntegrityError('Fixed paired contract identity disagreement')
        pool=next((p for p in cohort if p['address']==a),None)
        if pool:validate_pool_rpc(pool,checks)
        allchecks.append({'address':a,'providers':checks,'graphPoolPresent':pool is not None})
    if ordinal==1:
        for t in sorted(TOKENS):
            got=[ask(s,rpc_job(ep,'eth_call',[{'to':t,'data':SELECTORS['decimals()']},{'blockHash':pin['hash'],'requireCanonical':True}])) for ep in (0,1)]
            expected={int(f['originalPool'][k]['decimals']) for f in POOLS.values() for k in ('token0','token1') if f['originalPool'][k]['id']==t}
            if got[0]!=got[1] or expected!={got[0]}:raise IntegrityError('Paired token decimals mismatch')
            allchecks.append({'token':t,'decimals':got})
    recorded(s,f'ROUND_{ordinal}_RPC.json',allchecks)

def close_pin(s,schemas,pin,opening):
    receipts=[];s.closing=True
    for kind in ('pools','meta','rpc'):
        for ep in (0,1):
            if kind=='pools' and ep not in opening:continue
            expected=s.controls.pop(0)
            if (expected['kind'],expected['endpoint'])!=(kind,ep):raise IntegrityError('Closing reserve schedule drift')
            q=pool_query(ep,schemas[ep],pin) if kind=='pools' else graph_job('meta',ep,pin=pin,deployment=schemas[ep]['deployment']) if kind=='meta' else rpc_job(ep,'eth_getBlockByNumber',[hex(pin['number']),False])
            cap,data=s.request(q)
            if kind=='pools' and data!=opening[ep]:raise IntegrityError('Exact pinned pool/token/bundle repeat drift')
            if kind=='rpc' and data!=pin:raise IntegrityError('Closing header drift')
            receipts.append({'kind':kind,'endpoint':ep,'attempt':cap['attempt'],'selectedDigest':selected_digest(data)})
    s.closing=False;return receipts

def current_round(s,schemas,pin,ordinal,previous=None):
    opening={};s.opened_round={'ordinal':ordinal,'schemas':schemas,'pin':pin,'opening':opening}
    for ep,sc in schemas.items():opening[ep]=ask(s,pool_query(ep,sc,pin))
    cohort=[normalize(row,schemas[ep]['recipe'],data.get('bundles',[]),ep,pin) for ep,data in opening.items() for row in data['items']]
    contract_checks(s,cohort,pin,ordinal)
    if previous:
        prior={p['address']:p for p in previous['cohort']}
        for p in cohort:
            old=prior.get(p['address'])
            if old and any(old[k]!=p[k] for k in ['tokenIds','decimals','factory']):raise IntegrityError('Cross-round contract identity drift')
    current=qualify(cohort,datetime.fromtimestamp(pin['timestamp'],timezone.utc).isoformat())
    # Local economic refusal is still a successfully captured raw observation;
    # its pre-reserved closing controls must execute before any seal.
    recorded(s,f'ROUND_{ordinal}_PROVISIONAL.json',{'pin':pin,'cohort':cohort,'current':current})
    controls=close_pin(s,schemas,pin,opening)
    result={'status':'SEALED_CURRENT','pin':pin,'cohort':cohort,'current':current,'opening':opening,'controls':controls}
    result['sealedAt']=utc();result['cycleStartOffsetSeconds']=s.cycle_started-s.started;recorded(s,f'ROUND_{ordinal}_SEALED.json',result);s.opened_round=None;return result

