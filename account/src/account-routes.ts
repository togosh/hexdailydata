import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type pg from "pg";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword, generateRandomString } from "better-auth/crypto";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { Config } from "./config.js";
import { makeAccountAuth, type AccountHooks } from "./account-auth.js";
import { Denied, guard, tx } from "./db.js";
import { createKey, revokeKey } from "./access.js";
import { periodSummary } from "./period.js";
import type { HexPayments } from "./hex-core.js";
import { issueInput, caseInput } from "./hex-types.js";

const username = z.string().regex(/^[A-Za-z0-9_-]{3,32}$/).transform((s) => s.toLowerCase());
const password = z.string().min(15).max(128);
const loginPassword = z.string().min(1).max(128);
const email = z.string().max(254).trim().toLowerCase().regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@example\.test$/);
const token = z.string().regex(/^[A-Za-z0-9]{48}$/);
const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const empty = z.object({}).strict();
const refusal = () => new Denied("CREDENTIALS_OR_PROOF_REFUSED",401);
const digest = (purpose: string, id: string, generation: string | number, value: string) =>
  createHash("sha256").update(JSON.stringify([purpose,id,String(generation),value])).digest("hex");
const same = (a: string | null, b: string) => !!a && a.length===64 && timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));

/** Register into an explicitly scoped Fastify instance. No listener, fixtures or worker. */
export async function registerAccountRoutes(app: FastifyInstance, c: Config, p: pg.Pool,
  hex: HexPayments, options: AccountHooks = {}) {
  await guard(p,c);
  const auth=makeAccountAuth(c,p,options), origin=new URL(c.origin);
  const stats={activeRequests:0, peakRequests:0, activeCredentials:0, peakCredentials:0,
    credentialJobs:0, busyRefusals:0, pendingCredentials:0};
  const owned=new WeakSet<FastifyRequest>(), executing=new WeakSet<FastifyRequest>();
  app.addHook("onRequest",async (req,reply) => {
    reply.header("cache-control","no-store").header("referrer-policy","no-referrer")
      .header("x-content-type-options","nosniff")
      .header("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.headers.host!==origin.host || ["forwarded","x-forwarded-host","x-forwarded-proto","x-forwarded-for","x-real-ip"].some(h=>req.headers[h])) throw new Denied("INVALID_HOST",400);
    if (req.headers.origin && req.headers.origin!==c.origin) throw new Denied("ORIGIN_REQUIRED",403);
    if (req.method!=="GET" && req.method!=="HEAD" && (req.headers.origin!==c.origin || req.headers["sec-fetch-site"]==="cross-site")) throw new Denied("ORIGIN_REQUIRED",403);
    if (req.url.startsWith("/api/") && req.url.includes("?")) throw new Denied("QUERY_REFUSED",400);
    if (stats.activeRequests>=12) throw new Denied("REQUEST_BUSY",429);
    stats.activeRequests++;stats.peakRequests=Math.max(stats.peakRequests,stats.activeRequests);owned.add(req);
  });
  const release=(req: FastifyRequest) => { if(owned.delete(req)) stats.activeRequests--; };
  app.addHook("onResponse",async req=>release(req));
  app.addHook("onRequestAbort",async req=>{if(!executing.has(req))release(req);});
  app.addHook("onRoute",route=>{
    // Only our promise-returning customer handlers own credential work. Preserve
    // callback-based static/plugin handlers and their normal reply lifecycle.
    if(!route.url.startsWith("/api/account")) return;
    const handler=route.handler;
    route.handler=async function(req,reply) {
      executing.add(req);
      try {if(req.raw.aborted)throw new Denied("REQUEST_CANCELLED",400);return await handler.call(this,req,reply);}
      finally {executing.delete(req);release(req);}
    };
  });
  app.setErrorHandler((error,req,reply) => {
    if (error instanceof Denied) return reply.code(error.status).send({error:error.code});
    if (error instanceof z.ZodError || (error as any).statusCode===400 || (error as any).statusCode===413)
      return reply.code((error as any).statusCode===413?413:400).send({error:"INVALID_INPUT"});
    return reply.code(503).send({error:"REQUEST_UNAVAILABLE"});
  });
  // A finite set of SQL buckets shares admission across processes and routes. Only
  // a rotating minute and count persist, never an IP, agent string or username.
  async function admit(req: FastifyRequest, name: string) {
    if(req.raw.aborted) throw new Denied("REQUEST_CANCELLED",400);
    const bucket=(value:string) => createHmac("sha256",c.secret).update(value).digest()[0]! % 128;
    const buckets=[bucket("source:"+req.ip),128+bucket("account:"+name)];
    for (const b of buckets) {
      const {rows:[r]}=await p.query(`INSERT INTO account_admission(bucket,starts_at,attempts) VALUES($1,clock_timestamp(),1)
        ON CONFLICT(bucket) DO UPDATE SET starts_at=CASE WHEN account_admission.starts_at<clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE account_admission.starts_at END,
        attempts=CASE WHEN account_admission.starts_at<clock_timestamp()-interval '1 minute' THEN 1 ELSE account_admission.attempts+1 END
        RETURNING attempts`,[b]);
      if(r.attempts>(b<128?120:24)) throw new Denied("TRY_LATER",429);
    }
  }
  async function credential<T>(req:FastifyRequest,name:string,work:()=>Promise<T>):Promise<T> {
    if(stats.activeCredentials>=2) {stats.busyRefusals++;throw new Denied("CREDENTIAL_BUSY",429);}
    stats.activeCredentials++;stats.peakCredentials=Math.max(stats.peakCredentials,stats.activeCredentials);
    try { await admit(req,name); if(req.raw.aborted) throw new Denied("REQUEST_CANCELLED",400); stats.credentialJobs++; return await work(); }
    finally {stats.activeCredentials--;}
  }
  // Immutable normalized username is only the lock key, never a financial owner.
  // All session creation, reset and authorized operations enter this same fence.
  // Try-lock is bounded and has no application queue; process death releases it.
  async function fence<T>(name:string,work:(q:pg.PoolClient)=>Promise<T>):Promise<T> {
    return tx(p,async q=>{
      const {rows:[r]}=await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,733106)) held",["account-credentials:"+name]);
      if(!r.held) throw new Denied("ACCOUNT_BUSY",409);
      return work(q);
    });
  }
  const session=(req:FastifyRequest) => auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableCookieCache:true,disableRefresh:true}});
  async function initialize(q:pg.PoolClient,id:string) {
    await q.query("INSERT INTO customer(id) VALUES($1) ON CONFLICT DO NOTHING",[id]);
    await q.query("INSERT INTO account_access(account_id) VALUES($1) ON CONFLICT DO NOTHING",[id]);
  }
  async function authenticated<T>(req:FastifyRequest,work:(id:string,name:string,q:pg.PoolClient)=>Promise<T>) {
    const first=await session(req);
    if(!first?.user.username) throw new Denied("LOGIN_REQUIRED",401);
    return fence(first.user.username,async q=>{
      const live=await session(req);
      if(!live || live.user.id!==first.user.id) throw new Denied("LOGIN_REQUIRED",401);
      const {rows:[r]}=await q.query("SELECT disabled FROM customer WHERE id=$1",[live.user.id]);
      if(!r || r.disabled) throw new Denied("ACCOUNT_DISABLED",403);
      return work(live.user.id,first.user.username!,q);
    });
  }
  async function library(req:FastifyRequest,path:string,body:any) {
    const headers=fromNodeHeaders(req.headers);headers.set("content-type","application/json");
    headers.delete("content-length");headers.delete("authorization");
    return auth.handler(new Request(c.origin+"/api/auth"+path,{method:"POST",headers,body:JSON.stringify(body)}));
  }
  const cookies=(reply:FastifyReply,r:Response) => { const values=r.headers.getSetCookie();if(values.length)reply.header("set-cookie",values); };
  async function identity(q:pg.PoolClient,name:string) {
    return (await q.query(`SELECT u.id,a.* FROM "user" u JOIN account_access a ON a.account_id=u.id
      JOIN customer c ON c.id=u.id WHERE u.username=$1 AND NOT c.disabled`,[name])).rows[0];
  }
  async function reauthenticate(q:pg.PoolClient,id:string,secret:string) {
    const {rows:[a]}=await q.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',[id]);
    if(!a?.password || !await verifyPassword({hash:a.password,password:secret})) throw refusal();
  }
  async function cancelChallenges(q:pg.PoolClient,id:string) {
    await q.query("DELETE FROM account_token WHERE account_id=$1",[id]);
    await q.query("UPDATE outbox SET cancelled_at=clock_timestamp(),body='[superseded]' WHERE access_owner=$1 AND delivered_at IS NULL AND cancelled_at IS NULL",[id]);
  }
  async function challenge(q:pg.PoolClient,id:string,purpose:"verify"|"reset",recipient:string) {
    const secret=generateRandomString(48,"a-z","A-Z","0-9");
    const {rows:[a]}=await q.query("SELECT generation,contact_generation FROM account_access WHERE account_id=$1",[id]);
    const proof=digest(purpose,id,a.generation+":"+a.contact_generation,secret);
    await q.query(`UPDATE outbox SET cancelled_at=clock_timestamp(),body='[superseded]' WHERE access_owner=$1 AND access_purpose=$2 AND delivered_at IS NULL AND cancelled_at IS NULL`,[id,purpose]);
    await q.query(`INSERT INTO account_token(account_id,purpose,digest,generation,contact_generation,recipient,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '15 minutes')
      ON CONFLICT(account_id,purpose) DO UPDATE SET digest=excluded.digest,generation=excluded.generation,contact_generation=excluded.contact_generation,recipient=excluded.recipient,expires_at=excluded.expires_at`,
      [id,purpose,proof,a.generation,a.contact_generation,recipient]);
    await q.query(`INSERT INTO outbox(id,dedup,recipient,subject,body,access_owner,access_purpose,access_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),"access:"+purpose+":"+id+":"+proof,recipient,
        purpose==="verify"?"Verify optional account email":"Reset account password",c.origin+"/account/#"+purpose+"="+secret,id,purpose,proof]);
  }
  async function validToken(q:pg.PoolClient,a:any,purpose:"verify"|"reset",secret:string) {
    if(!a) return false;
    const {rows:[t]}=await q.query(`SELECT * FROM account_token WHERE account_id=$1 AND purpose=$2 AND expires_at>clock_timestamp()`,[a.id,purpose]);
    return !!t && t.generation===a.generation && t.contact_generation===a.contact_generation &&
      t.recipient===(purpose==="verify"?a.pending_email:a.current_email) &&
      same(t.digest,digest(purpose,a.id,a.generation+":"+a.contact_generation,secret));
  }
  async function reset(q:pg.PoolClient,a:any,newPassword:string) {
    const hashed=await hashPassword(newPassword), recoveryCode=randomBytes(32).toString("base64url");
    const next=BigInt(a.generation)+1n;
    const changed=await q.query(`UPDATE account SET password=$2,"updatedAt"=clock_timestamp() WHERE "userId"=$1 AND "providerId"='credential'`,[a.id,hashed]);
    if(changed.rowCount!==1) throw Error("CREDENTIAL_ACCOUNT_INVARIANT");
    await q.query(`UPDATE account_access SET generation=$2,recovery_verifier=$3,pending_email=NULL,contact_generation=contact_generation+1 WHERE account_id=$1`,[a.id,next.toString(),digest("recovery",a.id,next.toString(),recoveryCode)]);
    await cancelChallenges(q,a.id);
    // This is the pinned library's database session store; no cookie/secondary cache.
    await q.query('DELETE FROM session WHERE "userId"=$1',[a.id]);
    await options.stage?.("before-recovery-commit");
    return {recoveryCode,loginRequired:true};
  }

  app.post("/api/account/signup",{bodyLimit:4096},async(req,reply)=>{
    const b=z.object({username,password,email:email.optional()}).strict().parse(req.body);
    const result=await credential(req,b.username,()=>fence(b.username,async q=>{
      if((await q.query('SELECT id FROM "user" WHERE username=$1',[b.username])).rowCount) throw new Denied("USERNAME_UNAVAILABLE",409);
      const r=await library(req,"/sign-up/email",{username:b.username,password:b.password,name:"Account member",email:randomBytes(24).toString("hex")+"@account.invalid"});
      if(!r.ok) throw new Denied("SIGNUP_UNAVAILABLE",409);
      const data=await r.json() as any;
      // Use only this newly returned library principal, never attach a conflict caller.
      if(!data.user?.id || data.user.username!==b.username || data.user.emailVerified) throw Error("SIGNUP_INVARIANT");
      await options.stage?.("before-signup-state");
      await initialize(q,data.user.id);
      const recoveryCode=randomBytes(32).toString("base64url");
      await q.query("UPDATE account_access SET recovery_verifier=$2 WHERE account_id=$1",[data.user.id,digest("recovery",data.user.id,1,recoveryCode)]);
      if(b.email) {await q.query("UPDATE account_access SET pending_email=$2 WHERE account_id=$1",[data.user.id,b.email]);await challenge(q,data.user.id,"verify",b.email);}
      return {r,id:data.user.id,recoveryCode};
    }));
    cookies(reply,result.r);return {id:result.id,username:b.username,recoveryCode:result.recoveryCode};
  });
  app.post("/api/account/login",{bodyLimit:4096},async(req,reply)=>{
    const b=z.object({username,password:loginPassword}).strict().parse(req.body);
    const result=await credential(req,b.username,()=>fence(b.username,async q=>{
      const r=await library(req,"/sign-in/username",b);
      if(!r.ok) throw refusal();
      const data=await r.json() as any;await initialize(q,data.user.id);
      if((await q.query("SELECT disabled FROM customer WHERE id=$1",[data.user.id])).rows[0]?.disabled) {
        await q.query('DELETE FROM session WHERE "userId"=$1',[data.user.id]);throw refusal();
      }
      return {r,id:data.user.id};
    }));
    cookies(reply,result.r);return {id:result.id,username:b.username};
  });
  app.post("/api/account/logout",{bodyLimit:512},async(req,reply)=>{
    empty.parse(req.body);
    await authenticated(req,async()=>{const r=await library(req,"/sign-out",{});if(!r.ok)throw refusal();cookies(reply,r);});
    return {loggedOut:true};
  });
  app.get("/api/account",async req=>authenticated(req,async(id,name,q)=>{
    const a=(await q.query("SELECT current_email,pending_email,recovery_verifier IS NOT NULL recovery_configured FROM account_access WHERE account_id=$1",[id])).rows[0];
    return {id,username:name,security:{email:a.current_email,pendingEmail:a.pending_email,recoveryConfigured:a.recovery_configured},
      period:await periodSummary(p,id,hex.time),invoices:await hex.list({accountId:id}),
      keys:(await q.query("SELECT id,label,prefix,revoked,created_at FROM api_key WHERE account_id=$1 ORDER BY created_at DESC LIMIT 64",[id])).rows,
      synthetic:true};
  }));
  app.post("/api/account/recover",{bodyLimit:4096},async req=>{
    const b=z.object({username,recoveryCode:code,newPassword:password}).strict().parse(req.body);
    const result=await credential(req,b.username,()=>fence(b.username,async q=>{
      const a=await identity(q,b.username);
      if(!a || !same(a.recovery_verifier,digest("recovery",a.id,a.generation,b.recoveryCode))) throw refusal();
      return reset(q,a,b.newPassword);
    }));
    await options.stage?.("after-recovery-commit");return result;
  });
  app.post("/api/account/recovery-code",{bodyLimit:4096},async req=>{
    const b=z.object({password:loginPassword}).strict().parse(req.body);
    return credential(req,"reauth",()=>authenticated(req,async(id,name,q)=>{
      await reauthenticate(q,id,b.password);const a=await identity(q,name);
      // Reissuing recovery authority also revokes sessions and stale mail authority.
      const recoveryCode=randomBytes(32).toString("base64url"),next=(BigInt(a.generation)+1n).toString();
      await q.query("UPDATE account_access SET generation=$2,recovery_verifier=$3,pending_email=NULL,contact_generation=contact_generation+1 WHERE account_id=$1",[id,next,digest("recovery",id,next,recoveryCode)]);
      await cancelChallenges(q,id);await q.query('DELETE FROM session WHERE "userId"=$1',[id]);
      return {recoveryCode,loginRequired:true};
    }));
  });
  app.post("/api/account/password",{bodyLimit:4096},async req=>{
    const b=z.object({password:loginPassword,newPassword:password}).strict().parse(req.body);
    return credential(req,"reauth",()=>authenticated(req,async(id,name,q)=>{
      await reauthenticate(q,id,b.password);return reset(q,await identity(q,name),b.newPassword);
    }));
  });
  app.post("/api/account/contact",{bodyLimit:4096},async req=>{
    const b=z.object({password:loginPassword,email:email.nullable()}).strict().parse(req.body);
    return credential(req,"reauth",()=>authenticated(req,async(id,_name,q)=>{
      await reauthenticate(q,id,b.password);await cancelChallenges(q,id);
      await q.query(`UPDATE account_access SET contact_generation=contact_generation+1,pending_email=$2,
        current_email=CASE WHEN $2::text IS NULL THEN NULL ELSE current_email END WHERE account_id=$1`,[id,b.email]);
      if(b.email)await challenge(q,id,"verify",b.email);
      return {pendingEmail:b.email,removed:b.email===null};
    }));
  });
  app.post("/api/account/verify-contact",{bodyLimit:2048},async req=>{
    const b=z.object({username,token}).strict().parse(req.body);
    return credential(req,b.username,()=>fence(b.username,async q=>{
      const a=await identity(q,b.username);if(!await validToken(q,a,"verify",b.token))throw refusal();
      await q.query("UPDATE account_access SET current_email=pending_email,pending_email=NULL,contact_generation=contact_generation+1 WHERE account_id=$1",[a.id]);
      await cancelChallenges(q,a.id);return {verified:true};
    }));
  });
  app.post("/api/account/request-email-reset",{bodyLimit:2048},async req=>{
    const b=z.object({username}).strict().parse(req.body);
    await credential(req,b.username,()=>fence(b.username,async q=>{
      const a=await identity(q,b.username);if(a?.current_email)await challenge(q,a.id,"reset",a.current_email);
    }));
    return {message:"If a verified recovery email is available, a link has been queued."};
  });
  app.post("/api/account/email-reset",{bodyLimit:4096},async req=>{
    const b=z.object({username,token,newPassword:password}).strict().parse(req.body);
    const result=await credential(req,b.username,()=>fence(b.username,async q=>{
      const a=await identity(q,b.username);if(!await validToken(q,a,"reset",b.token))throw refusal();
      return reset(q,a,b.newPassword);
    }));
    await options.stage?.("after-recovery-commit");return result;
  });
  app.post("/api/account/keys",{bodyLimit:1024},async req=>{
    const b=z.object({label:z.string().trim().min(1).max(40),replace:z.uuid().optional()}).strict().parse(req.body);
    return authenticated(req,async(id,_name,q)=>{
      if(!(await periodSummary(p,id,hex.time)).access)throw new Denied("PURCHASED_ACCESS_REQUIRED",403);
      if((await q.query("SELECT count(*)::int n FROM api_key WHERE account_id=$1",[id])).rows[0].n>=64)throw new Denied("KEY_HISTORY_LIMIT",409);
      return createKey(p,id,b.label,b.replace);
    });
  });
  app.post("/api/account/keys/revoke",{bodyLimit:512},async req=>{
    const b=z.object({id:z.uuid()}).strict().parse(req.body);return authenticated(req,id=>revokeKey(p,id,b.id));
  });
  app.post("/api/account/invoices",{bodyLimit:1024},async req=>{
    const b=issueInput.parse(req.body);return authenticated(req,id=>hex.issue({accountId:id},b));
  });
  app.get("/api/account/invoices/:id",async req=>{
    const id=z.uuid().parse((req.params as any).id);return authenticated(req,accountId=>hex.invoice({accountId},id));
  });
  app.post("/api/account/invoices/:id/cancel",{bodyLimit:512},async req=>{
    empty.parse(req.body);const id=z.uuid().parse((req.params as any).id);return authenticated(req,accountId=>hex.cancel({accountId},id));
  });
  app.post("/api/account/invoices/:id/review",{bodyLimit:2048},async req=>{
    const b=caseInput.parse(req.body),id=z.uuid().parse((req.params as any).id);return authenticated(req,accountId=>hex.requestReview({accountId},id,b));
  });
  app.get("/api/account/reviews/:id",async req=>{
    const id=z.uuid().parse((req.params as any).id);return authenticated(req,accountId=>hex.getCase({accountId},id));
  });
  // No wildcard auth proxy, availability, API-key login, sender proof, fixture,
  // owner/admin or payment-progression routes are registered here.
  return { authenticateSession: authenticated, diagnostics:()=>({...stats}) };
}
