import {paidReadLifecycle} from './paid-reads.mjs';
import {accountDownloadAuthorizer} from './authorizer.mjs';
import {sampleRoutes} from './samples.mjs';

// Explicit same-origin composition. Callers inject separately compiled serving/account
// modules and guarded pools. The account plugin is encapsulated by createApp.
export function composePaidApp({serving,account,config,pool,payments,dependencies,
  webRoot,accountWebRoot,accountOptions={},now,meter,publicLimits,readOptions={}}) {
  let shared;
  const authorize=accountDownloadAuthorizer({
    ...account,pool,origin:config.origin,
    session:(request,work)=> {
      if (!shared) throw Error('Account routes not initialized.');
      return shared.authenticateSession(request,work);
    },
  });
  // SuccessMeter defaults to legacy daily mode. Paid REST requires period mode,
  // including old fixed30 terms; bad wiring must leave only public JSON usable.
  const lifecycle = meter?.mode === 'period' ? paidReadLifecycle({...readOptions,meter,
    failure: (status,code,message)=>new serving.ApiFailure(status,code,message),
    uncertainHold: error=>error instanceof account.ReserveUncertain ? error.hold : null,
  }) : null;
  return serving.createApp({dependencies,webRoot,now,publicLimits,
    paidReads: lifecycle ? {
      begin: (request,reply,work)=> {
        if (!shared) throw new serving.ApiFailure(503,'source_unavailable','Account access is unavailable.');
        return lifecycle.begin(request,reply,work);
      },
      close: ()=>lifecycle.close(),
    } : undefined,
    exportRoot:dependencies.downloads.root,
    downloadAuthorizer:(request,signal)=>shared?authorize(request,signal):Promise.resolve({status:503}),
    samples:sampleRoutes,
    account:{webRoot:accountWebRoot,register:async scope=>{
      let registered=false;
      scope.addHook('onRoute',()=>{registered=true;});
      try {
        shared=await account.registerAccountRoutes(scope,config,pool,payments,accountOptions);
      } catch {
        // The accepted registrar guards its database before adding any routes.
        // A failed initial guard disables account access for this app lifetime;
        // public samples/data remain usable. Never retain a partial registration.
        if (registered) throw Error('Incomplete account route registration.');
        const unavailable=(_request,reply)=>reply.code(503).send({error:'ACCOUNT_UNAVAILABLE'});
        scope.get('/api/account',unavailable);
        scope.post('/api/account/login',unavailable);
        scope.post('/api/account/signup',unavailable);
      }
    }},
  });
}
