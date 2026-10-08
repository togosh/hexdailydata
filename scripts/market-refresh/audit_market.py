"""Saved-only original capture, completion and publication auditor; no transport."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import json
from datetime import datetime,timezone
from durable import strict_json,digest,encode,selected_digest
from task_queries import validate_job,validate_data,entity_rows,POOLS,TOKENS,SCOPE,SELECTORS
from header_binding import validate_rpc
from response_caps import response_capacity
from http_framing import verify_framing
from retry_policy import classify_error_only
from market import normalize,validate_pool_rpc,qualify,REVISION,MEASURE

def audit(root,synthetic=False,active=False):
    from collector import source_binding
    root=Path(root);read=lambda n:strict_json((root/n).read_bytes())
    result=read('CHECKPOINT.json' if active else 'RESULT.json');state=read('ACCOUNTING.json');admission=read('ADMISSION.json')
    if admission['sourceFiles']!=source_binding():raise ValueError('Admission/source binding changed')
    if not synthetic:
        if state['mode']!='OWNER_AUTHORIZED_PUBLIC':raise ValueError('Synthetic data cannot publish')
    if result['accounting']!=state or result['networkSessionCount']!=1:raise ValueError('Result/accounting mismatch')
    caps=[strict_json(x) for x in (root/'LEDGER.jsonl').read_bytes().splitlines()];by={};gaps=[]
    sums=dict(attempts=len(caps),chargedBytes=0,observedBytes=0,chargedEntities=0,extraAttempts=0,returnedEntities=0,unknownEntityReservations=0)
    for i,c in enumerate(caps,1):
        d=root/'captures'/f'{i:05d}';q=c['job']
        if c['attempt']!=i or read(f'captures/{i:05d}/capture.json')!=c:raise ValueError('Capture/ledger sequence')
        method,url,body=validate_job(q);request=read(f'captures/{i:05d}/request.json')
        if request['job']!=q or request['method']!=method or request['url']!=url or body!=(d/'request.body').read_bytes() or digest(body)!=c['requestSha256']:raise ValueError('Original request binding')
        raw=(d/'response.body').read_bytes()
        if len(raw)!=c['responseBytes'] or digest(raw)!=c['responseSha256']:raise ValueError('Original response binding')
        framing=(d/'response.framing').read_bytes() if (d/'response.framing').exists() else None
        charged=verify_framing(c,raw,response_capacity(q),framing) if c.get('complete') and c.get('closureKnown') else response_capacity(q)
        if charged!=c['chargedBytes']:raise ValueError('Wire-body charge')
        parsed=None
        if c.get('complete'):
            try:parsed=strict_json(raw)
            except ValueError:pass
        if not isinstance(parsed,dict):parsed=None
        known=parsed is not None and c.get('closureKnown');count=entity_rows(parsed) if known else q['maxRows']
        if count!=c['chargedEntities']:raise ValueError('Object charge')
        data=None
        if c['usable']:
            if not all(c.get(k) is True for k in ('complete','closureKnown','closedWithinDeadline','bodyDurable')) or c['status']!=200:raise ValueError('Unqualified usable capture')
            if q['kind']=='rpc':data=validate_rpc(q,parsed)
            else:
                if set(parsed)-{'data','extensions'}:raise ValueError('Error data cannot be usable')
                data=validate_data(q,parsed['data'])
        by[i]=(q,data,c)
        if i>1:gaps.append(c['startOffsetSeconds']-caps[i-2]['startOffsetSeconds']-caps[i-2]['durationSeconds'])
        if c['durationSeconds']>30 or c['startOffsetSeconds']>=2640 or c['startOffsetSeconds']+c['durationSeconds']>2700:raise ValueError('Request deadline')
        sums['chargedBytes']+=c['chargedBytes'];sums['observedBytes']+=len(raw);sums['chargedEntities']+=count;sums['extraAttempts']+=bool(c['retry'])
        sums['returnedEntities']+=entity_rows(parsed) if parsed is not None else 0;sums['unknownEntityReservations']+=0 if known else q['maxRows']
        if q['kind']!='rpc' and classify_error_only(parsed,c,policy_version='HOLDER_R3')!=c.get('classification'):raise ValueError('Original retry classification')
        if c['retry']:
            prior=by.get(c['retryOf']);origin=by.get(c['originalAttempt'])
            if q['kind']=='rpc' or not prior or not origin or prior[0]!=q or origin[0]!=q or not prior[2]['retryable'] or c['retryIndex']!=prior[2]['retryIndex']+1 or c['retryIndex']>2:raise ValueError('Exact shared retry ordinal')
            if c['startOffsetSeconds']-prior[2]['startOffsetSeconds']-prior[2]['durationSeconds']<[15,60][c['retryIndex']-1]-.001:raise ValueError('Retry wait')
    if any(state[k]!=v for k,v in sums.items()):raise ValueError('Account totals')
    if min(gaps,default=1)<.999:raise ValueError('Closure pacing')
    expected_status=('SYNTHETIC_OFFLINE_TEST' if synthetic else 'ADMITTED') if active else 'CLOSED'
    if state['status']!=expected_status or state['pending'] is not None:raise ValueError('Unknown accounting/physical closure')
    if sums['attempts']>240 or sums['chargedBytes']>25165824 or sums['chargedEntities']>12000 or sums['extraAttempts']>24 or state['elapsedSeconds']>2700:raise ValueError('Session cap')
    for kind,limit,epcap,bytecap in [('rpc',160,80,8388608),('graph',80,40,16777216)]:
        selected=[c for c in caps if ('rpc' if c['job']['kind']=='rpc' else 'graph')==kind]
        charged=sum(c['chargedBytes'] for c in selected)
        if len(selected)!=state[kind+'Attempts'] or len(selected)>limit or charged!=state[kind+'ChargedBytes'] or charged>bytecap:raise ValueError('Protocol accounting')
        for ep in (0,1):
            if sum(c['job']['endpoint']==ep for c in selected)!=state[kind+'EndpointAttempts'][ep] or state[kind+'EndpointAttempts'][ep]>epcap:raise ValueError('Endpoint accounting')
    def matches(predicate):return [(q,d,c) for q,d,c in by.values() if c['usable'] and predicate(q)]
    used_controls=set()
    def controls(receipts,pin,opening,after):
        expected=[(k,ep) for k in ('pools','meta','rpc') for ep in (0,1) if k!='pools' or str(ep) in opening]
        if [(r['kind'],r['endpoint']) for r in receipts]!=expected:raise ValueError('Ordered controls incomplete')
        for r in receipts:
            n=r['attempt'];q,data,c=by[n]
            if n<=after or n in used_controls or not c['usable'] or (q['kind'],q['endpoint'])!=(r['kind'],r['endpoint']) or selected_digest(data)!=r['selectedDigest']:raise ValueError('Control binding/order')
            if q['kind']=='pools' and (q['pin']!=pin or data!=opening[str(q['endpoint'])]):raise ValueError('Pinned repeat drift')
            if q['kind']=='meta' and q['pin']!=pin:raise ValueError('Foreign meta control')
            if q['kind']=='rpc' and (q['method']!='eth_getBlockByNumber' or q['params']!=[hex(pin['number']),False] or data!=pin):raise ValueError('Header repeat drift')
            after=n;used_controls.add(n)
        return after
    rounds=[];last_round_control=0;prior_start=None;prior_factories=None
    for ordinal in (1,2,3):
        path=root/f'ROUND_{ordinal}_SEALED.json'
        if not path.exists():continue
        saved=read(path.name);pin=saved['pin'];cohort=[];opening={};after=last_round_control
        start=saved['cycleStartOffsetSeconds'];cc=[c for c in caps if c['cycle']==ordinal]
        if start>=1500 or (prior_start is not None and start-prior_start<60):raise ValueError('Cycle admission/spacing')
        if not cc or any(c['startOffsetSeconds']<start or c['startOffsetSeconds']>=min(start+1140,2640) or c['startOffsetSeconds']+c['durationSeconds']>min(start+1200,2700) for c in cc):raise ValueError('Cycle request deadline')
        controls_at=saved['controls'][0]['attempt']
        if any(c['startOffsetSeconds']>=start+600 for c in cc if c['attempt']<controls_at):raise ValueError('Cycle data cutoff')
        pin_record=read(f'ROUND_{ordinal}_PIN.json')
        rpc_heads=[d for q,d,c in matches(lambda q:q['kind']=='rpc' and q['method']=='eth_blockNumber') if c['cycle']==ordinal][-2:]
        graph_heads=[d['_meta']['block']['number'] for q,d,c in matches(lambda q:q['kind']=='meta' and q['pin'] is None) if c['cycle']==ordinal][-2:]
        if pin_record['pin']!=pin or pin_record['rpcHeads']!=rpc_heads or pin_record['graphHeads']!=graph_heads or len(rpc_heads)!=2 or len(graph_heads)!=2 or pin['number']!=min(rpc_heads+graph_heads)-12 or pin_record['bufferBlocks']!=12:raise ValueError('Exact buffered head binding')
        prior_start=start;factories={}
        if rounds and (pin['number']<=rounds[-1]['pin']['number'] or pin['timestamp']<=rounds[-1]['pin']['timestamp']):raise ValueError('Nonadvancing rounds')
        for ep in (0,1):
            headers=matches(lambda q:q['kind']=='rpc' and q['endpoint']==ep and q['method']=='eth_getBlockByNumber' and q['params']==[hex(pin['number']),False])
            if len(headers)<2 or headers[0][1]!=pin:raise ValueError('Opening paired pin')
            matched=matches(lambda q:q['kind']=='pools' and q['endpoint']==ep and q['pin']==pin)
            if len(matched)<2:raise ValueError('Unsealed pool inputs')
            q,data,c=matched[0]
            if c['attempt']<=headers[0][2]['attempt'] or c['attempt']<=last_round_control:raise ValueError('Opening order')
            after=max(after,c['attempt']);opening[str(ep)]=data
            cohort.extend(normalize(row,q['recipe'],data.get('bundles',[]),ep,pin) for row in data['items'])
        if opening!=saved['opening']:raise ValueError('Saved opening source drift')
        for address,f in sorted(POOLS.items()):
            checks=[]
            for ep in (0,1):
                check={}
                for method in ('token0()','token1()','factory()','getReserves()'):
                    ms=matches(lambda q:q['kind']=='rpc' and q['method']=='eth_call' and q['endpoint']==ep and q['params']==[{'to':address,'data':SELECTORS[method]},{'blockHash':pin['hash'],'requireCanonical':True}])
                    if len(ms)!=1 or ms[0][2]['attempt']<=max(m[2]['attempt'] for m in matches(lambda q:q['kind']=='pools' and q['pin']==pin)[:2]):raise ValueError('Exact per-round RPC proof missing/order')
                    check[method]=ms[0][1];after=max(after,ms[0][2]['attempt'])
                checks.append(check)
            if checks[0]!=checks[1] or [checks[0]['token0()'],checks[0]['token1()']]!=[f['originalPool'][k]['id'] for k in ('token0','token1')]:raise ValueError('Fixed paired identity')
            pool=next((p for p in cohort if p['address']==address),None)
            if pool:validate_pool_rpc(pool,checks)
            factories[address]=checks[0]['factory()']
        if prior_factories is not None and factories!=prior_factories:raise ValueError('Cross-cycle factory drift')
        prior_factories=factories
        if ordinal==1:
            for token in TOKENS:
                expected={int(f['originalPool'][k]['decimals']) for f in POOLS.values() for k in ('token0','token1') if f['originalPool'][k]['id']==token}
                for ep in (0,1):
                    ms=matches(lambda q:q['kind']=='rpc' and q['method']=='eth_call' and q['endpoint']==ep and q['params']==[{'to':token,'data':SELECTORS['decimals()']},{'blockHash':pin['hash'],'requireCanonical':True}])
                    if len(ms)!=1 or {ms[0][1]}!=expected:raise ValueError('Token decimals proof')
                    after=max(after,ms[0][2]['attempt'])
        observed=datetime.fromtimestamp(pin['timestamp'],timezone.utc).isoformat();current=qualify(cohort,observed)
        if current!=saved['current'] or cohort!=saved['cohort']:raise ValueError('Round arithmetic/time/source differs')
        last_round_control=controls(saved['controls'],pin,opening,after);rounds.append(saved)
    promotable=result.get('integrityClosed') is True;historical=[]
    if promotable and result['rounds']!=len(rounds):raise ValueError('Result seal count')
    updates=[]
    if promotable:
        for r in rounds:
            c=r['current'];readings=[]
            if c['hexPriceUsd'] is not None:readings.append({'kind':'market','chainId':369,'asset':'HEX','quote':'USD','observation':'spot','value':c['hexPriceUsd'],'observedAtUtc':c['observedAtUtc']})
            if c['trackedLiquidityUsd'] is not None:readings.append({'kind':'tracked-liquidity','chainId':369,'quote':'USD','value':c['trackedLiquidityUsd'],'observedAtUtc':c['observedAtUtc'],'set':{'id':c['cohortId'],'measure':MEASURE,'methodRevision':REVISION,'coverage':'bounded contemporary HEX-pool cohort','pools':c['valuedPools']}})
            if not readings:continue
            buckets=[]
            updates.append({'readings':readings,'liquidityHistory':buckets,'methodRevision':REVISION,'receiptSha256':digest(encode(r))})
    return {'status':'PASS','capturePromotable':promotable,'accounting':sums,'minimumPostClosureSeconds':min(gaps,default=None),'sealedRounds':len(rounds),'proposedUpdateCount':len(updates),'qualifiedHistoryDates':sum(d['trackedLiquidityUsd'] is not None for d in historical),'publicRequestsByAuditor':0},updates

