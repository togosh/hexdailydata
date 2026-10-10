// All historic clocks in this file are explicit OFFLINE REPLAY clocks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { T,put,admission,fixtureRoot,capture,tinyStore,sampleTrades,qualifyMarkets,freshTradePair,publishTrade,checkTradeService } from './operating-policy.mjs';
const { marketCheckpoints, preserveMarketHistory, applyMarketUpdate }=await import('../../dist/services/product-daily/market.js');
const previous=join(T,'reference/prior/public-session'),root=await fixtureRoot('saved-replay-');
qualifyMarkets(await fs.readFile(join(previous,'01/response.body'),'utf8'));
const store=tinyStore(),retained=[],results=[],realNow=Date.now;
try {
  for(let cycle=1;cycle<=3;cycle++) {
    const audit=JSON.parse(await fs.readFile(join(previous,`ROUND_${cycle}_AUDIT.json`)));
    const now=Date.parse(audit.checkedAtUtc);Date.now=()=>now;
    const m={cycle,expiresAtUnixSeconds:now/1000+30};
    for(const [asset,attempt] of [['btc',cycle*2],['eth',cycle*2+1]])
      m[asset]=await capture(root,attempt,`${asset.toUpperCase()}_${cycle}`,await fs.readFile(join(previous,String(attempt).padStart(2,'0'),'response.body'),'utf8'));
    const before=structuredClone(store.capture());
    const publication=await publishTrade(store,root,m,()=>true,(u,c)=>store.publish(u,c),retained);
    const service=checkTradeService(store.live(now),store.capture(),now,now);
    if(cycle===2){assert(!publication.qualified);assert.deepEqual(store.capture(),before);
      const ages=Object.fromEntries(store.capture().metadata.readings.map(r=>[r.asset,(now-Date.parse(r.observedAtUtc))/1000]));
      assert.deepEqual(ages,{BTC:65.974,ETH:88.974});results.push({cycle,publication,service,derivedReplayAgesSeconds:ages});
    }else {assert(publication.qualified);results.push({cycle,publication,service});}
  }
  const selected=store.capture(),latest=Math.max(...selected.metadata.readings.map(r=>Date.parse(r.observedAtUtc)));
  const first=Math.min(...selected.metadata.readings.map(r=>Date.parse(r.observedAtUtc)));
  for(const [offset,status] of [[300000,'FRESH'],[300001,'STALE'],[600000,'STALE']]) {
    const now=first+offset;assert.equal(checkTradeService(store.live(now),selected,now,now).status,status);
    assert.deepEqual(store.capture(),selected);
  }
  const now=Date.parse('2026-10-11T00:00:10Z');Date.now=()=>now;
  const sample=(asset,time,id,price='1.234500')=>sampleTrades(JSON.stringify([{date:String(time/1000),tid:id,price}]),asset,[],now).selected;
  const old=sample('BTC',now-20000,'900719925474099312344'),newer=sample('BTC',now-20000,'900719925474099312345');
  const both=sampleTrades(JSON.stringify([{date:String((now-20000)/1000),tid:old.tradeId,price:'2'}, {date:String((now-20000)/1000),tid:newer.tradeId,price:'3'}]),'BTC',[],now);
  assert.equal(both.selected.tradeId,newer.tradeId);
  assert.throws(()=>sampleTrades(JSON.stringify([{date:String((now-20000)/1000),tid:old.tradeId,price:'9'}]),'BTC',[old],now),/IDENTITY/);
  const nextPair=[sample('BTC',now-1000,'100'),sample('ETH',now-1000,'100')];
  assert(freshTradePair(nextPair,now));
  const before=store.capture();await store.publish({readings:nextPair},()=>{});
  const changed=store.capture();assert.notEqual(changed.version,before.version);
  assert.equal((await store.publish({readings:nextPair},()=>{})).changed,false);
  assert.equal(marketCheckpoints(store.capture().metadata.observations).filter(r=>r.asset==='BTC').length,2);
  assert.equal(checkTradeService(store.live(now),store.capture(),now,now).status,'FRESH');
  const protectedOld={rows:[{dateUtc:'2026-10-09',btcPriceUsd:'42'}],metadata:before.metadata};
  assert.throws(()=>preserveMarketHistory(protectedOld,{rows:[{dateUtc:'2026-10-09',btcPriceUsd:'43'}],metadata:changed.metadata}),/TRADE_EXISTING_CELL_CHANGED/);
  const early=[sample('BTC',Date.parse('2026-10-08T00:00:00Z'),'8'),sample('ETH',Date.parse('2026-10-08T00:00:00Z'),'8')];
  assert.throws(()=>applyMarketUpdate({...before,metadata:{...before.metadata,benchmarkHistory:{methodRevision:'bitstamp-utc-daily-close-1'}}},{readings:early,liquidityHistory:[],receiptSha256:'0'.repeat(64)}));
  await put(join(T,'evidence/OPERATING_REPLAY.json'),{status:'PASS',synthetic:true,mode:'OFFLINE_SAVED_REPLAY_NOT_HISTORICAL_LIVE_READ',publicRequests:0,baseAdmissions:0,apiListeners:0,
    cases:['actual saved qualified/empty ETH/qualified publication path','empty retains exact pair and timestamps','300-second inclusive boundary and prolonged stale retention','genuinely newer recovery and exact repeat no-op','same-second numeric-ID tie-break and mutation refusal','UTC rollover checkpoints; existing historical cell/timed-close refusal'],results,
    limitation:'Tiny injected selection sink; immutable full paired/data/storage proof reused separately by source hash.'});
} finally {Date.now=realNow;}
console.log('SAVED_REPLAY_AND_FRESHNESS_PASS');
