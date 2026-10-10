// No bases/listeners/provider calls. Exercise the unchanged parser on client-accepted bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const deny = () => { throw Error('OFFLINE_NETWORK_DENIED'); };
net.connect = net.createConnection = net.Socket.prototype.connect = net.Server.prototype.listen = deny;
tls.connect = http.request = http.get = https.request = https.get = deny;
for (const o of [dns, dns.promises])
  for (const k of Object.keys(o))
    if (k === 'lookup' || k.startsWith('resolve') || k === 'reverse') o[k] = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
const T = String.raw`C:\Code\HEXDailyData-Subgraph-First-Launch-Proof-R2\btc-eth-current-reference-freshness-r2\response-cookie-handling-r1`;
const hash = (b) => createHash('sha256').update(b).digest('hex');
const { qualifyMarkets, sampleTrades, freshTradePair } = await import('../../dist/services/product-daily/trades.js');
const accepted = JSON.parse(await fs.readFile(join(T, 'evidence/ACCEPTED_MARKET_REPLAY.json')));
assert(accepted.synthetic && accepted.oldOriginalRemainsRejected);
const body = await fs.readFile(join(T, accepted.fixture, '01/response.body'));
assert.equal(hash(body), '9b2db367c10c0784a6fbc3e4a3deb90a4c73bda4e162d3cf1841007655cc445d');
assert.equal(body.length, 99217);
const actual = qualifyMarkets(body.toString());
assert.equal(actual.objects, 272);
assert.deepEqual(actual.selected.map((x) => [x.market_symbol, x.base_currency, x.counter_currency, x.market_type, x.trading]), [
  ['btcusd', 'BTC', 'USD', 'SPOT', 'Enabled'], ['ethusd', 'ETH', 'USD', 'SPOT', 'Enabled'],
]);
const rows = JSON.parse(body);
const btc = rows.find((x) => x.market_symbol === 'btcusd');
for (const bad of [rows.filter((x) => x !== btc), [...rows, btc],
  ...[{ base_currency:'ETH' }, { counter_currency:'EUR' }, { market_type:'FUTURE' }, { trading:'Disabled' }]
    .map((patch) => rows.map((x) => x === btc ? { ...x, ...patch } : x))])
  assert.throws(() => qualifyMarkets(JSON.stringify(bad)), /MARKET_IDENTITY/);
// Focused unchanged transaction invariants, without any product fixture or storage.
const now = Date.parse('2026-10-10T00:01:00Z'), second = Math.floor(now / 1000) - 10;
const tuple = (d, id, p='1.234500') => `{"date":"${d}","tid":${id},"price":"${p}"}`;
const list = [tuple(second - 1, '999999999999999999999'), tuple(second, '900719925474099312344'), tuple(second, '900719925474099312345')];
const first = sampleTrades('['+list.join(',')+']','BTC',[],now).selected;
assert.deepEqual(first,sampleTrades('['+list.reverse().join(',')+']','BTC',[],now).selected);
assert.equal(first.tradeId,'900719925474099312345'); assert.equal(first.value,'1.2345');
assert.equal(first.observedAtUtc,new Date(second*1000).toISOString());
const eth = sampleTrades(tuple(second,'1'),'ETH',[],now).selected;
assert(freshTradePair([first,eth],(second+300)*1000));
assert(!freshTradePair([first,eth],(second+300)*1000+1));
assert.equal(sampleTrades('[]','ETH',[],now).selected,null);
assert.throws(() => sampleTrades(tuple(second+100,'1'),'BTC',[],now),/FUTURE/);
assert.throws(() => sampleTrades(tuple(second,'1','2'),'ETH',[eth],now),/IDENTITY/);
for (const bad of ['[{"date":1,"date":1,"tid":1,"price":1}]','[{"date":1,"d\\u0061te":1,"tid":1,"price":1}]','[{"__proto__":{},"date":1,"tid":1,"price":1}]','{"error":"fixture"}','[{"date":1,"tid":0,"price":1}]','[{"date":1,"tid":1,"price":0}]'])
  assert.throws(() => sampleTrades(bad,'BTC',[],now));
assert.throws(() => fetch('https://OFFLINE-DENIAL-WITNESS.invalid'),/OFFLINE_NETWORK_DENIED/);
const receipt={status:'PASS',synthetic:true,publicRequests:0,baseAdmissions:0,apiListeners:0,hardNetworkDenied:true,
  acceptedClientReceiptSha256:hash(await fs.readFile(join(T,'evidence/ACCEPTED_MARKET_REPLAY.json'))),
  bodyBytes:body.length,bodySha256:hash(body),objectContainers:actual.objects,marketRows:rows.length,
  selected:actual.selected.map((x)=>({market:x.market_symbol,base:x.base_currency,counter:x.counter_currency,type:x.market_type,trading:x.trading})),
  checks:['actual unchanged qualifyMarkets on corrected client bytes','missing/duplicate/swapped/non-USD/non-spot/disabled markets refused','lossless timestamp-first numeric-ID tie-break','exact repeat, identity mutation, future time and malformed tuples','300-second boundary, empty response, duplicate and prototype keys'],
  parserSourceSha256:hash(await fs.readFile('src/services/product-daily/trades.ts')),
  parserBuildSha256:hash(await fs.readFile('dist/services/product-daily/trades.js'))};
await fs.writeFile(join(T,'evidence/MARKET_PARSER_REPLAY.json'),JSON.stringify(receipt,null,2)+'\n');
console.log('REAL_MARKET_AND_TRANSACTION_PARSER_REPLAY_PASS');
