"""R2's explicit reserve-based USD estimator. Raw source tokens stay separate."""
from decimal import Decimal,localcontext,ROUND_HALF_UP
from pathlib import Path
import json,re,hashlib
from datetime import datetime,timezone,timedelta
from schema import HEX
ROOT=Path(__file__).resolve().parent
POLICY=json.loads((ROOT/'MARKET_POLICY.json').read_text())
FOCUS=json.loads((ROOT/'FOCUS_POOLS.json').read_text())
POOLS={p['address']:p for p in FOCUS['pools']}
REVISION=POLICY['revision']
MEASURE='reserve-based source-derived USD estimate'
RELATIVE_TOLERANCE=Decimal('0.000001') # R1 cached-USD diagnostic tolerance remains unchanged.
ABSOLUTE_USD_TOLERANCE=Decimal('0.00000001')
THRESHOLD=Decimal(POLICY['economicEligibility']['maxRelativePriceDisagreement'])

class IntegrityError(ValueError):pass
def dec(v):
    if not isinstance(v,str) or len(v)>160 or not re.fullmatch(r'-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?',v):raise ValueError('Exact source decimal required')
    d=Decimal(v)
    if not d.is_finite() or abs(d.adjusted())>150:raise ValueError('Decimal magnitude')
    return d
def token(v):return format(v,'f')
def rounded(v):return token(v.quantize(Decimal('1e-48'),rounding=ROUND_HALF_UP))
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def cohort_id():return digest({'method':REVISION,'pools':[{'address':a,'venue':p['graphEndpointIndex']} for a,p in sorted(POOLS.items())]})
def close(a,b):
    with localcontext() as ctx:
        ctx.prec=384
        return abs(a-b)<=max(ABSOLUTE_USD_TOLERANCE,abs(b)*RELATIVE_TOLERANCE)

def normalize(row,recipe,bundles,venue,pin):
    """Structural parsing preserves missing/zero USD for local capability decisions."""
    focus=POOLS.get(row.get('id'))
    if focus is None or focus['graphEndpointIndex']!=venue:raise IntegrityError('Foreign focus pool')
    tokens=[row['token0'],row['token1']];expected=[focus['originalPool'][k] for k in ('token0','token1')]
    if [t['id'] for t in tokens]!=[t['id'] for t in expected]:raise IntegrityError('Focus token identity drift')
    decimals=[]
    for t,e in zip(tokens,expected):
        if t['decimals']!=e['decimals']:raise IntegrityError('Focus decimals drift')
        decimals.append(int(t['decimals']))
    reserves=[dec(row['reserve0']),dec(row['reserve1'])]
    if any(v<0 for v in reserves):raise IntegrityError('Negative pool reserve')
    for field,bound in [('block',pin['number']),('timestamp',pin['timestamp'])]:
        if row.get(field) is not None and (not str(row[field]).isdigit() or not 0<=int(row[field])<=bound):raise IntegrityError('Pool activity beyond pin')
    return {'address':row['id'],'venue':venue,'pin':pin,'source':row,'bundles':bundles,'tokenIds':[t['id'] for t in tokens],
            'decimals':decimals,'normalizedReserves':[token(v) for v in reserves],'rpcValidated':False}

def validate_pool_rpc(pool,checks):
    if len(checks)!=2 or checks[0]!=checks[1]:raise IntegrityError('Paired pool RPC disagreement')
    c=checks[0]
    if [c['token0()'],c['token1()']]!=pool['tokenIds']:raise IntegrityError('RPC token identity disagreement')
    with localcontext() as ctx:
        ctx.prec=384
        for i in (0,1):
            unit=Decimal(10)**(-pool['decimals'][i]);normalized=Decimal(c['getReserves()'][i])*unit
            if abs(normalized-dec(pool['normalizedReserves'][i]))>unit:raise IntegrityError('RPC/subgraph reserve disagreement beyond one base unit')
    pool.update(rpcValidated=True,factory=c['factory()'],rpcReserves=c['getReserves()'])

def evaluate(pool,historical_prices=None):
    """Funding eligibility is separate from price suitability. Never remove a funded outlier to pass."""
    with localcontext() as ctx:
        ctx.prec=384
        row=pool['source'];i=pool['tokenIds'].index(HEX);q=1-i
        hr=dec(row['reserve'+str(i)]);qr=dec(row['reserve'+str(q)])
        result={'address':pool['address'],'venue':pool['venue'],'quoteAddress':pool['tokenIds'][q],'hexReserve':token(hr),'quoteReserve':token(qr),'eligible':False,'reasons':[]}
        try:
            usd=[dec(historical_prices[t] if historical_prices is not None else row['token'+str(j)].get('derivedUSD')) for j,t in enumerate(pool['tokenIds'])]
            if min(usd)<=0:raise ValueError('Missing or nonpositive source USD reference')
            hm=hr*usd[i];qm=qr*usd[q];depth=min(hm,qm)
            result.update(hexSourceUsd=token(usd[i]),quoteSourceUsd=token(usd[q]),hexMarkedUsd=token(hm),quoteMarkedUsd=token(qm),depthScore=token(depth))
            if hr<Decimal(POLICY['economicEligibility']['minHexUnits']):result['reasons'].append('HEX inventory below 100000 units')
            if depth<Decimal(POLICY['economicEligibility']['minMarkedUsdEachSide']):result['reasons'].append('Marked USD depth below 1000 on a side')
            if hr<=0 or qr<=0:result['reasons'].append('Nonpositive reserve denominator/inventory')
            if historical_prices is None and not pool['rpcValidated']:result['reasons'].append('Pool not corroborated by both RPCs')
            if hr>0:
                price=qr/hr*usd[q]
                result.update(hexPriceUsd=rounded(price),referencePriceAgreement=abs(price/usd[i]-1)<=THRESHOLD)
            if historical_prices is None:
                try:
                    stored=dec(row['reserveUSD']);computed=hm+qm
                    result['cachedUsdDiagnostic']={'original':row['reserveUSD'],'currentTokenProduct':token(computed),'difference':token(computed-stored),'withinOriginalR1Tolerance':close(stored,computed)}
                except ValueError:result['cachedUsdDiagnostic']={'original':row.get('reserveUSD'),'unavailable':True}
                if result['quoteAddress']=='0xa1077a294dde1b09bb078844df40758a5d0f9a27':
                    result['wplsBundleDiagnostic']={'quoteDerivedUSD':row['token'+str(q)].get('derivedUSD'),'bundles':pool['bundles'],'valuationSwitched':False}
            result['eligible']=not result['reasons']
        except (ValueError,KeyError) as e:result['reasons'].append(str(e))
        return result

def qualify(cohort,observed_time,historical_prices=None):
    if len({p['address'] for p in cohort})!=len(cohort):raise IntegrityError('Duplicate physical pool')
    for p in cohort:
        f=POOLS.get(p['address'])
        if not f or p['venue']!=f['graphEndpointIndex'] or p['tokenIds']!=[f['originalPool'][k]['id'] for k in ('token0','token1')]:raise IntegrityError('Foreign qualification identity')
    if len({json.dumps(p['pin'],sort_keys=True) for p in cohort})>1:raise IntegrityError('Mixed observation pins')
    evaluations=[evaluate(p,None if historical_prices is None else historical_prices[p['venue']]) for p in cohort]
    eligible=sorted([p for p in evaluations if p['eligible']],key=lambda p:(dec(p['depthScore']).copy_negate(),p['address']))
    failures=[]
    if len(eligible)<2 or {p['venue'] for p in eligible}!={0,1} or len({p['quoteAddress'] for p in eligible})<2:failures.append('Need two funded corroborators spanning both venues and distinct quotes')
    if any(not p.get('referencePriceAgreement') for p in eligible):failures.append('Funded pool price differs from its venue HEX reference beyond 5%')
    with localcontext() as ctx:
        ctx.prec=384
        primary=eligible[0] if eligible else None
        if primary and any(abs(dec(p['hexPriceUsd'])/dec(primary['hexPriceUsd'])-1)>THRESHOLD for p in eligible):failures.append('Funded corroborator differs from primary beyond 5%; no outlier removal')
        price=primary['hexPriceUsd'] if primary and not failures else None
        all_four={p['address'] for p in eligible}==set(POOLS)
        values=[]
        if price:
            for p in eligible:
                v=dec(p['hexReserve'])*dec(price)+dec(p['quoteReserve'])*dec(p['quoteSourceUsd'])
                values.append({'address':p['address'],'dex':'PulseX','version':'V1' if p['venue']==0 else 'V2','valueUsd':rounded(v)})
        total=token(sum((dec(p['valueUsd']) for p in values),Decimal(0))) if price and all_four else None
    return {'methodRevision':REVISION,'measure':MEASURE,'cohortId':cohort_id(),'poolCount':4,'hexPriceUsd':price,'trackedLiquidityUsd':total,
            'primaryPool':primary['address'] if price else None,'priceFailures':failures,'liquidityFailure':None if total is not None else 'Requires qualified common price and all four eligible members',
            'observedAtUtc':observed_time,'evaluations':evaluations,'valuedPools':values if total is not None else [],'historicalRpcValidated':False if historical_prices is not None else None,
            'qualification':'Reserve-based source-derived USD estimate; shared inputs, not independent oracle, backing or execution proof'}

