// Tiny injected coordinator tests. No serving bases, listener, or provider access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
const deny = () => { throw Error('OFFLINE_NETWORK_DENIED'); };
net.connect = net.createConnection = net.Socket.prototype.connect = net.Server.prototype.listen = deny;
tls.connect = http.request = http.get = https.request = https.get = deny;
for (const o of [dns, dns.promises]) for (const k of Object.keys(o))
  if (k === 'lookup' || k.startsWith('resolve') || k === 'reverse') o[k] = deny;
globalThis.fetch = deny; syncBuiltinESMExports();
export const T = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\operating-refresh-r1`;
export const put = (p,v) => fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
const { sha } = await import('../../dist/services/source-update/generation.js');
export const { sampleTrades, qualifyMarkets, freshTradePair } = await import('../../dist/services/product-daily/trades.js');
const { ProductDailyStore } = await import('../../dist/services/product-daily/store.js');
const { mergeObservations, latestReadings } = await import('../../dist/services/product-daily/market.js');
export const { checkTradeService, tradeProfile, validateOperatingScope, capturedBody, publishTrade,
  operatingTaskId, operatingProfileId } = await import('../../scripts/trade-publication.mjs');
export const admission = { task:'HDD-BTC-ETH-CURRENT-REFERENCE-FRESHNESS-R2', family:'trade',
  authorityTaskId:operatingTaskId, tradeProfileId:operatingProfileId, job:'trade-operating-16-slots',
  responseCookiePolicyId:'ignore-response-cookies-no-replay-v1', nonce:'synthetic-fixture' };
export function tinyStore(readings=[]) {
  let selected={version:sha(JSON.stringify(readings)), rows:[], metadata:{readings,observations:readings,
    pair:{observedAtUtc:'2026-10-09T00:00:00Z',baseObservedAtUtc:'2026-10-05T00:00:00Z',coverage:'synthetic',holderRecordCount:1,stakeStartRecordCount:1}, ledgerObservedAtUtc:null}};
  return { capture:()=>selected, live:now=>ProductDailyStore.prototype.live(selected,now),
    async publish(update,check) { check();
      const observations=mergeObservations(selected.metadata.observations,update.readings);
      const readings=latestReadings(observations), version=sha(JSON.stringify(observations));
      const changed=version!==selected.version;
      selected={...selected,version,metadata:{...selected.metadata,readings,observations}};
      return {changed,selected:{version},storage:{synthetic:true}};
    } };
}
export async function capture(root,attempt,label,body) {
  const dir=join(root,String(attempt).padStart(2,'0'));await fs.mkdir(dir);
  const raw=Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  const containers=v=>v&&typeof v==='object'?1+Object.values(v).reduce((n,v)=>n+containers(v),0):0;
  const binding={attempt,bodySha256:sha(raw),bodyBytes:raw.length,objects:containers(JSON.parse(raw))};
  await fs.writeFile(join(dir,'response.body'),raw);
  await put(join(dir,'AUDIT.json'),{...binding,method:'GET',nonce:admission.nonce,tradeProfileId:operatingProfileId,
    url:label==='markets'?'https://www.bitstamp.net/api/v2/markets/':`https://www.bitstamp.net/api/v2/transactions/${label.slice(0,3).toLowerCase()}usd/?time=minute`,
    label,closed:true,complete:true,status:200,integrityFailure:null,chargedObjects:binding.objects});
  return binding;
}
export async function fixtureRoot(prefix) {
  await fs.mkdir(join(T,'fixtures'),{recursive:true});
  const root=await fs.mkdtemp(join(T,'fixtures',prefix));
  await put(join(root,'ADMISSION.json'),{...admission,jobRoot:root});return root;
}
async function main() {
  const {runJob}=await import('../../scripts/refresh-data.mjs');
  const scope=JSON.parse(await fs.readFile(join(T,'packet/SCOPE.json')));
  assert.equal(validateOperatingScope(scope).attempts,66);
  assert.equal(tradeProfile({}).attempts,14);
  for(const patch of [{authorityTaskId:'old'},{tradeProfileId:'other'},{job:'trade-three-slots'}])assert.throws(()=>tradeProfile({...admission,...patch}));
  for(const key of ['maximumPhysicalAttempts','maximumLogicalRequests','maximumChargedBytes','maximumParsedObjectsAcrossResponses']) {
    const bad=structuredClone(scope);bad.network[key]++;assert.throws(()=>validateOperatingScope(bad));
  }
  const late=await fixtureRoot('late-capture-');
  const b=await capture(late,66,'ETH_16','[]');assert.equal(await capturedBody(late,b,'ETH_16'),'[]');
  await assert.rejects(capturedBody(late,{...b,attempt:67},'ETH_16'));
  await assert.rejects(capturedBody(late,b,'ETH_17'));
  await put(join(late,'ADMISSION.json'),{task:admission.task,family:'trade',jobRoot:late,nonce:admission.nonce});
  await assert.rejects(capturedBody(late,b,'ETH_16'));
  const cases=[];
  for(const mode of ['all','mixed','terminal','service-error']) {
    const root=await fixtureRoot('coordinator-'+mode+'-'),store=tinyStore();
    let count=0,hookCount=0;
    const registry={productDaily:store,status:()=>({productVersion:store.capture().version}),refresh:async()=>{},root,
      publishProduct:async(u,o)=>{const r=await store.publish(u,o.beforeCommit);await put(join(root,'CURRENT.json'),{product:r.selected});return r;}};
    const sample=(asset,c)=>[{date:String(Math.floor(Date.now()/1000)-5),tid:String(c),price:asset==='BTC'?'80000.01':'2500.02'}];
    function spawnChild() {
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;
      let answer;child.stdin=new Writable({write(b,_,done){answer(JSON.parse(b));done();}});
      const exchange=(type,cycle,extra={})=>new Promise(r=>{answer=r;child.stdout.write(JSON.stringify({type,cycle,expiresAtUnixSeconds:Date.now()/1000+30,...extra})+'\n');});
      setImmediate(async()=>{
        const cycles=[];let failure;
        try {
          const markets=await fs.readFile(join(T,'reference/prior/public-session/01/response.body'),'utf8');
          assert((await exchange('markets',0,{markets:await capture(root,++count,'markets',markets)})).ok);
          for(let c=1;c<=16;c++) {
            if(mode==='terminal'&&c===4){assert((await exchange('begin',c)).ok);throw Error('SYNTHETIC_SOURCE_TERMINAL');}
            if(mode==='mixed'&&c===8){assert((await exchange('skipped',c,{reason:'synthetic overrun'})).ok);cycles.push({cycle:c,status:'SKIPPED'});continue;}
            assert((await exchange('begin',c)).ok);
            const btc=await capture(root,++count,`BTC_${c}`,sample('BTC',c));
            const eth=await capture(root,++count,`ETH_${c}`,mode==='mixed'&&c===2?[]:sample('ETH',c));
            const a=await exchange('qualified',c,{btc,eth});if(!a.ok)throw Error(a.reason);
            cycles.push({cycle:c,status:a.outcome});
          }
        } catch(e){failure=String(e);}
        const accounting={status:'CLOSED',pending:null,attempts:count,synthetic:true};
        const result={status:failure?'PARTIAL':'COMPLETE_FRESH_CYCLES',cycles,accounting,failure};
        await put(join(root,'ACCOUNTING.json'),accounting);await put(join(root,'RESULT.json'),result);
        child.stdout.write(JSON.stringify({type:'closed',result})+'\n');child.exitCode=failure?2:0;
        child.emit('exit',child.exitCode,null);child.stdout.end();child.stderr.end();child.emit('close',child.exitCode,null);
      });return child;
    }
    const result=await runJob({jobRoot:root,admission,registry,spawnChild,deadline:performance.now()+30000,
      onSlot:async({cycle,selected})=>{hookCount++;if(mode==='service-error'&&cycle===2)throw Error('SYNTHETIC_SERVICE_FAILURE');
        const now=Date.now();return checkTradeService(store.live(now),selected,now,now);}});
    assert.equal(result.serviceChecks.length,16);
    assert.equal(result.status,'PARTIAL','accelerated synthetic publications are not 300 seconds apart');
    assert.equal(hookCount,mode==='terminal'?4:mode==='service-error'?2:16);
    if(mode==='mixed'){assert.equal(result.serviceChecks[1].publicationResult,'retained');assert.equal(result.serviceChecks[7].sourceResult,'SKIPPED');}
    if(mode==='terminal')assert.equal(result.serviceChecks.filter(s=>s.service.status==='NOT_MEASURED').length,12);
    if(mode==='service-error')assert.equal(result.serviceChecks[1].service.status,'ERROR');
    cases.push({mode,hookCount,result});
  }
  const {runOperatingTrades,runCookieTrades}=await import('../../scripts/trade-refresh.mjs');
  await assert.rejects(runCookieTrades({}),/EXISTING_OR_UNCERTAIN_TRADE_SESSION/);
  await assert.rejects(runOperatingTrades({}),/ENOENT/);
  await put(join(T,'evidence/OPERATING_POLICY.json'),{status:'PASS',synthetic:true,publicRequests:0,baseAdmissions:0,apiListeners:0,hardNetworkDenied:true,
    limitation:'Tiny synthetic selection facade; actual coordinator, captured parser, publication and Live formatter used. Not the real paired readiness gate.',cases});
  console.log('OPERATING_POLICY_PASS');
}
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url))await main();
