// Replay actual locally reaped/no-child receipts through the maintained settlement.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {OperatingOwner} from '../../scripts/unified-refresh/operating.mjs';
import {operatingPolicy,boundedOperatingConfig,RealOperatingClock} from '../../scripts/unified-refresh/operating-authority.mjs';
import {sha} from '../../dist/services/source-update/generation.js';
const T=operatingPolicy.root,source=process.argv[2];
assert(source?.startsWith(join(T,'fixtures','time-checks-')));
const R=await fs.mkdtemp(join(T,'fixtures/settlement-')),cases=[];
for(const delay of [20,31]) {
 const clock=new RealOperatingClock(),c=boundedOperatingConfig(clock.now(),true),o=await OperatingOwner.open(join(R,String(delay)),c,clock,{sourceBinding:'1'.repeat(64)});
 const id=await o.allocate('trade'),root=join(o.root,id,'01');await fs.mkdir(root,{recursive:true});
 const original=join(source,'queue-'+delay,'trade-00000001','01');
 for(const e of await fs.readdir(original,{withFileTypes:true}))if(e.isFile()) await fs.copyFile(join(original,e.name),join(root,e.name));
 const p={id:1,nonce:'fixture',job:id,attempt:1,requestPath:join(root,'request.json'),requestSha256:sha(await fs.readFile(join(root,'request.json'))),bytes:2162688,objects:20000,protocol:'http',closureMode:c.format};
 await o.register('trade','a'.repeat(64),id,clock.now()+600,operatingPolicy.public.childAllowances.trade);
 o.state.pending=p;o.state.totals.http={attempts:1,bytes:2162688,objects:20000,extras:0};
 const m={permitId:1,nonce:'fixture',attempt:1,closed:true,complete:false,bytes:2162688,objects:20000,receiptSha256:sha(await fs.readFile(join(root,'AUDIT.json')))};
 await assert.rejects(()=>o.settle(id,{...m,nonce:'wrong'}),/SETTLEMENT_IDENTITY/);assert(o.state.pending);
 await o.settle(id,m);assert.equal(o.state.pending,null);assert.equal(o.state.totals.http.bytes,2162688);assert.equal(o.state.totals.http.objects,20000);
 assert.equal(o.state.dispatchEvidence.observedHttpResponses,0);assert.equal(o.state.dispatchEvidence.knownNoNetworkDispatch,1);
 cases.push({delay,status:'PASS',chargedAttempts:1,observedHttpResponses:0,knownNoNetworkDispatch:1,noRefund:true});
 o.jobs.clear();o.state.active=[];await o.close();
}
await fs.writeFile(join(R,'RESULT.json'),JSON.stringify({status:'PASS',cases,networkRequests:0,baseAdmissions:0},null,2)+'\n');
console.log(JSON.stringify({status:'PASS',fixture:R,cases:cases.length,networkRequests:0,baseAdmissions:0}));
