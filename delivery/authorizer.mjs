// Dependencies are the accepted account106 exports plus its shared session fence.
// No credential, entitlement, payment or JSON meter is implemented here.
export function accountDownloadAuthorizer({pool, session, origin, checkAccess,
  boundedTransaction, lockAccount, selectPeriods, databaseTime}) {
  const expected = new URL(origin);
  if (expected.origin !== origin || expected.username || expected.password)
    throw Error('Canonical account origin required.');
  const current = async (q, accountId, instant, signal) => {
    signal.throwIfAborted();
    const selected = await selectPeriods(q, accountId, instant);
    signal.throwIfAborted();
    return selected.current ? {accountId} : {status:403};
  };
  return async (request, signal) => {
    try {
      signal.throwIfAborted();
      const raw = request.raw.rawHeaders;
      let supplied = 0;
      for (let i=0;i<raw.length;i+=2) if (raw[i].toLowerCase()==='authorization') supplied++;
      // Raw duplicates matter even when the HTTP implementation normalizes headers.
      if (supplied || request.headers.authorization !== undefined) {
        const header=request.headers.authorization;
        if (supplied !== 1 || typeof header !== 'string' || !/^Bearer lab_[A-Za-z0-9_-]{43}$/.test(header))
          return {status:401};
        return await boundedTransaction(pool,{signal},async q => {
          const {accountId,instant}=await checkAccess(q,header.slice(7),()=>databaseTime(q),false);
          return current(q,accountId,instant,signal);
        });
      }
      if (request.headers.host !== expected.host ||
          Object.keys(request.headers).some(k=>k==='forwarded'||k==='x-real-ip'||k.startsWith('x-forwarded-')) ||
          (request.headers.origin && request.headers.origin !== origin) ||
          ['cross-site','same-site'].includes(request.headers['sec-fetch-site'])) return {status:403};
      return await session(request,async (accountId,_username,q) => {
        signal.throwIfAborted();
        await lockAccount(q,accountId);
        return current(q,accountId,await databaseTime(q),signal);
      });
    } catch (error) {
      // Accepted identity errors have stable statuses; conflicts/storage/abort fail closed.
      return {status:error?.status===401?401:error?.status===403?403:503};
    }
  };
}
