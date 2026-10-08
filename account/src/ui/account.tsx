import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
type Field={name:string;label:string;type?:string;optional?:boolean;min?:number;max?:number;value?:string;auto?:string};
function Form({fields,label,run,busy}:{fields:Field[];label:string;run:(b:any)=>Promise<void>;busy:boolean}) {
  return <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const body=Object.fromEntries(new FormData(form));for(const f of fields)if(f.optional&&!body[f.name])delete body[f.name];void run(body).finally(()=>{for(const input of form.querySelectorAll<HTMLInputElement>('input[type=password]:not([name=token]):not([name=recoveryCode])'))input.value='';});}}>
    {fields.map(f=><label key={f.name}>{f.label}<input name={f.name} type={f.type??'text'} required={!f.optional} minLength={f.min} maxLength={f.max??254} defaultValue={f.value} autoComplete={f.auto??'off'} autoCapitalize="none" spellCheck={false}/></label>)}<button type="submit" disabled={busy}>{label}</button></form>;
}
async function api(path:string,body?:unknown){const r=await fetch('/api/account'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error??'REQUEST_UNAVAILABLE'),{status:r.status});return v;}
const date=(s:string)=>new Date(s).toISOString().replace('T',' ').replace('.000Z',' UTC');
const user:Field={name:'username',label:'Username',min:3,max:32,auto:'username'};
const pw:Field={name:'password',label:'Password',type:'password',max:128,auto:'current-password'};
const newpw:Field={name:'newPassword',label:'New password',type:'password',min:15,max:128,auto:'new-password'};
const mail:Field={name:'email',label:'Recovery email (optional)',type:'email',optional:true,auto:'email'};
function App(){
  const [account,setAccount]=useState<any>(null),[mode,setMode]=useState('login'),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [secret,setSecret]=useState<{label:string;value:string}|null>(null),[invoice,setInvoice]=useState<any>(null),[linkToken,setLinkToken]=useState(''),[plan,setPlan]=useState('synthetic-month');
  const generation=useRef(0), refreshVersion=useRef(0), actionVersion=useRef(0);
  const identity=useRef<{id:string;username:string}|null>(null);
  const selected=useRef<{id:string;version:number}|null>(null), selectionVersion=useRef(0);
  const secretOwner=useRef<string|null>(null);
  class StaleResult extends Error {}
  const clearPrivate=()=>{
    generation.current++; refreshVersion.current++; actionVersion.current++;
    selectionVersion.current++; selected.current=null; identity.current=null; secretOwner.current=null;
    setAccount(null); setInvoice(null); setSecret(null); setLinkToken(''); setMode('login'); setBusy(false);
  };
  const request=async(path:string,body?:unknown)=>{
    const epoch=generation.current;
    try {
      const value=await api(path,body);
      if(epoch!==generation.current)throw new StaleResult();
      return value;
    } catch(error) {
      if(epoch!==generation.current)throw new StaleResult();
      const publicAction=['/signup','/login','/recover','/verify-contact','/request-email-reset','/email-reset'].includes(path);
      if((error as any).status===401 && identity.current && path!=='' && !publicAction){
        clearPrivate(); setNotice('Session ended. Sign in again.');
      }
      throw error;
    }
  };
  const selectInvoice=async(id:string)=>{
    const choice={id,version:++selectionVersion.current};selected.current=choice;setInvoice(null);
    const value=await request('/invoices/'+id);
    if(selected.current===choice)setInvoice(value);
  };
  const refresh=async()=>{
    const epoch=generation.current,version=++refreshVersion.current,choice=selected.current;
    if(choice)setInvoice(null);
    let value;
    try {value=await request('');}
    catch(error){
      if(epoch!==generation.current || version!==refreshVersion.current)throw new StaleResult();
      if((error as any).status===401){
        if(identity.current){clearPrivate();setNotice('Session ended. Sign in again.');}
        return;
      }
      throw error;
    }
    if(epoch!==generation.current || version!==refreshVersion.current)throw new StaleResult();
    if(identity.current && identity.current.id!==value.id){
      clearPrivate();identity.current={id:value.id,username:value.username};setAccount(value);
      throw new StaleResult();
    }
    if(secretOwner.current && secretOwner.current!==value.username.toLowerCase()){setSecret(null);secretOwner.current=null;}
    identity.current={id:value.id,username:value.username};setAccount(value);
    // The selected history may be outside the latest 30. Its owned detail is authoritative.
    if(choice && selected.current===choice){
      try {
        const detail=await request('/invoices/'+choice.id);
        if(version===refreshVersion.current && selected.current===choice)setInvoice(detail);
      } catch(error){
        if(version!==refreshVersion.current || selected.current!==choice)throw new StaleResult();
        if((error as any).status===404){selected.current=null;setNotice('Selected invoice is unavailable.');}
        else throw error;
      }
    }
  };
  const act=async(work:()=>Promise<void>)=>{
    const epoch=generation.current,version=++actionVersion.current;
    refreshVersion.current++;setBusy(true);setNotice('');
    try {await work();}
    catch(error){if(!(error instanceof StaleResult) && epoch===generation.current && version===actionVersion.current)setNotice((error as Error).message.replaceAll('_',' ').toLowerCase());}
    finally{if(epoch===generation.current && version===actionVersion.current)setBusy(false);}
  };
  useEffect(()=>{
    const readLink=()=>{
      const hash=new URLSearchParams(location.hash.slice(1));
      const purpose=['verify','reset'].find(k=>hash.has(k));
      if(purpose){
        generation.current++;refreshVersion.current++;actionVersion.current++;
        selected.current=null;selectionVersion.current++;setInvoice(null);setSecret(null);secretOwner.current=null;
        setBusy(false);setNotice('');setMode(purpose);setLinkToken(hash.get(purpose)!);
        history.replaceState(null,'',location.pathname+location.search);
      }
      void act(refresh);
    };
    readLink();window.addEventListener('hashchange',readLink);
    return()=>{generation.current++;window.removeEventListener('hashchange',readLink);};
  },[]);
  const showSecret=(label:string,value:string,owner=identity.current?.username)=>{
    secretOwner.current=owner?.toLowerCase()??null;setSecret({label,value});
  };
  const recovered=(r:any,owner=identity.current?.username)=>{
    if(r.loginRequired)clearPrivate();
    showSecret('Recovery code',r.recoveryCode,owner);setLinkToken('');
  };
  const fieldProof:Field={name:mode==='recover'?'recoveryCode':'token',label:mode==='recover'?'Recovery code':'Email link token',max:64,value:linkToken,type:'password'};
  return <><div className="banner">SYNTHETIC ACCOUNT LAB · NO REAL PAYMENTS OR MAIL</div><main><header><div className="mark">H</div><div><span className="eyebrow">HEXDAILYDATA / ACCOUNT ACCESS</span><h1>Your account</h1></div>{account&&<button onClick={()=>{clearPrivate();void act(async()=>{await request('/logout',{});});}}>Sign out</button>}</header>
    <p className="intro">Choose a private username and password. Save a recovery code. Email is optional; your purchases and API keys stay with the same account when you return.</p><p role="status" className="notice">{busy?'Working…':notice}</p>
    {secret&&<article className="save-code"><span className="eyebrow">SHOWING ONCE</span><h2>Save your {secret.label.toLowerCase()}</h2><p>{secret.label==='Recovery code'?'Store this safely. It can reset your password. A replacement invalidates the old code.':'Copy this synthetic API key now. You can replace it later, but cannot retrieve it.'}</p><code data-testid="one-time-secret">{secret.value}</code><button onClick={()=>setSecret(null)}>I have saved it</button></article>}
    {(!account||(linkToken&&['verify','reset'].includes(mode)))&&<div className="auth-grid"><article>{account&&<p className="help">Signed in as {account.username}. Enter the username for this email link. Nothing happens until you submit.</p>}<nav aria-label="Account access">{[['login','Sign in'],['signup','Create account'],['recover','Recover account']].map(([key,title])=><button key={key} onClick={()=>{setMode(key);setLinkToken('');setNotice('');}}>{title}</button>)}</nav><h2>{({login:'Welcome back',signup:'Choose your login',recover:'Use your recovery code',verify:'Verify optional email',reset:'Reset with your email link',request:'Request an email reset'} as any)[mode]}</h2>
      <Form key={mode+linkToken} busy={busy} label={({login:'Sign in',signup:'Create account',recover:'Recover with code',verify:'Verify email',reset:'Reset password',request:'Send reset link'} as any)[mode]}
        fields={[user,...(['signup','login'].includes(mode)?[{...pw,min:mode==='signup'?15:1,auto:mode==='signup'?'new-password':'current-password'}]:[]),...(mode==='signup'?[mail]:[]),...(['recover','verify','reset'].includes(mode)?[fieldProof]:[]),...(['recover','reset'].includes(mode)?[newpw]:[])]}
        run={b=>act(async()=>{if(mode==='signup'){recovered(await request('/signup',b),b.username);await refresh();}if(mode==='login'){await request('/login',b);await refresh();}if(mode==='recover')recovered(await request('/recover',b),b.username);if(mode==='reset')recovered(await request('/email-reset',b),b.username);if(mode==='verify'){await request('/verify-contact',b);setMode('login');setLinkToken('');if(identity.current)await refresh();setNotice('Email verified. Sign in with your username.');}if(mode==='request')setNotice((await request('/request-email-reset',b)).message);})}/>
      {mode==='signup'&&<p className="help">Username: 3–32 letters, digits, underscores or hyphens; case-insensitive and immutable. New password: 15–128 characters. Optional email is limited to example.test in this lab and must be verified.</p>}
      {mode==='recover'&&<button onClick={()=>setMode('request')}>Use a verified recovery email</button>}</article><aside><span className="eyebrow">KEEP YOUR ACCESS</span><h2>Save the recovery code.</h2><p>Without a verified recovery email, losing both your password and code makes this account unrecoverable.</p><p>A typed account ID, payment hash or wallet signature cannot restore website access.</p><p className="help">Signup creates no invoice or trial access. Sessions use HttpOnly cookies.</p></aside></div>}
    {account&&<React.Fragment key={account.id}><div className="identity"><strong>Signed in as {account.username}</strong><span className="muted">Account {account.id}</span><button onClick={()=>void act(refresh)}>Refresh account</button></div><div className="grid"><article><span className="eyebrow">ACCESS / USAGE</span><h2>{account.period.access?'Purchased access active':'No current purchased access'}</h2><p className="help">$30 / month or $300 / year. Token amounts and request allowances shown here are explicit lab fixtures.</p>
      <p><strong>Paid through</strong><br/>{account.period.paidThrough?date(account.period.paidThrough):'No active coverage'}</p>
      <section className="period"><h3>Current monthly allowance</h3>{account.period.current?.window?<><p>{date(account.period.current.window.start)}<br/>to {date(account.period.current.window.end)}</p><strong>{account.period.current.window.remaining} of {account.period.current.window.allowance} requests remaining</strong><p className="help">{account.period.current.window.used} successful · {account.period.current.window.held} pending</p><p>{account.period.nextRefresh?'Next refresh: '+date(account.period.nextRefresh):'Access expires at the end of this window unless renewed.'}</p>{account.period.current.kind==='fixed30'&&<p className="help">Legacy fixed 30-day allowance.</p>}</>:<p>None</p>}</section>
      <section className="period"><h3>Next purchased term</h3>{account.period.next?<p>{date(account.period.next.start)} to {date(account.period.next.end)}<br/>{account.period.next.months??1} monthly allowance window(s), {account.period.next.allowance} fixture requests each</p>:<p>None</p>}</section><p className="help">Unused requests expire at each window boundary. Future windows cannot be borrowed.</p><p className="help">Expired access does not prevent account login or renewal.</p></article>
      <article><span className="eyebrow">API KEYS</span><h2>Your client keys</h2><p className="help">Secrets appear once. The lab_ key format is synthetic. Keys survive renewals and credential recovery.</p>{account.period.access&&<Form busy={busy} fields={[{name:'label',label:'Key label',max:40,value:'My synthetic client'}]} label="Create key" run={b=>act(async()=>{const r=await request('/keys',b);showSecret('API key',r.secret);await refresh();})}/>}<ul className="keys">{account.keys.map((k:any)=><li key={k.id}><strong>{k.label}</strong><code>{k.prefix}…</code><small>{k.revoked?'Revoked':date(k.created_at)}</small>{!k.revoked&&<div className="actions"><button disabled={busy||!account.period.access} onClick={()=>void act(async()=>{const r=await request('/keys',{label:k.label,replace:k.id});showSecret('API key',r.secret);await refresh();})}>Replace</button><button disabled={busy} onClick={()=>void act(async()=>{await request('/keys/revoke',{id:k.id});await refresh();})}>Revoke</button></div>}</li>)}</ul></article></div>
      <div className="grid"><article><span className="eyebrow">PURCHASES</span><h2>Invoices</h2><p className="warning">Before purchasing, save your recovery code or verify an email. Payment evidence cannot recover your login.</p><label>Purchase term<select aria-label="Purchase term" value={plan} onChange={e=>setPlan(e.target.value)}><option value="synthetic-month">Monthly · $30 price position · 1 allowance window</option><option value="synthetic-year">Annual · $300 price position · 12 monthly windows</option></select></label><button disabled={busy} onClick={()=>void act(async()=>{const version=++selectionVersion.current;selected.current=null;setInvoice(null);const value=await request('/invoices',{requestId:crypto.randomUUID(),plan});if(version!==selectionVersion.current)return;selected.current={id:value.id,version};setInvoice(value);await refresh();})}>Create synthetic invoice</button><ul className="invoices">{account.invoices.map((i:any)=><li key={i.id}><button onClick={()=>void act(async()=>selectInvoice(i.id))}>{i.status} · {i.amountHEX} HEX</button><small>{date(i.issuedAt)}</small></li>)}</ul>{invoice&&<section className="invoice"><h3>Invoice · {invoice.status}</h3><p className="help">{invoice.status==='paid'?'Payment received. Keep this receipt; do not pay this invoice again.':'Synthetic fixture only. Do not send funds.'} {invoice.price?.calendarMonths??1} window(s), each with {invoice.price?.allowance} fixture requests.</p><dl>{[['Invoice',invoice.id],['Exact HEX amount',invoice.amountHEX],['Network',invoice.network],['Recipient',invoice.recipient],['Token contract',invoice.token],['Expires',date(invoice.expiresAt)]].map(([k,v])=><React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl><button onClick={()=>void act(async()=>{const r=await request('/invoices/'+invoice.id+'/review',{reason:'Please review this synthetic invoice.'});setNotice('Review recorded: '+r.status);})}>Request invoice review</button></section>}</article>
      <article><span className="eyebrow">SECURITY</span><h2>Recovery and optional email</h2><p data-testid="email-state">{account.security.email?'Verified: '+account.security.email:'No verified recovery email'}</p>{account.security.pendingEmail&&<p>Awaiting verification: {account.security.pendingEmail}</p>}<p className="help">{account.security.recoveryConfigured?'Your code cannot be shown again. Replace it using your password if you lost the one-time display.':'Recovery setup was interrupted. Create a recovery code using your password below.'}</p><p className="help">Recovery revokes sessions and older links. Purchases, usage and keys stay unchanged. Revoke or replace any compromised API key separately.</p>
        <Form busy={busy} fields={[{...pw,label:'Current password'},{...mail,label:'New optional email',optional:false}]} label="Send verification" run={b=>act(async()=>{await request('/contact',b);await refresh();setNotice('Verification queued to local capture. Previous verified email remains active until replacement is verified.');})}/>
        <details><summary>Remove email or replace recovery code</summary><Form busy={busy} fields={[{...pw,label:'Current password'}]} label="Remove email" run={b=>act(async()=>{await request('/contact',{...b,email:null});await refresh();setNotice('Email removed; queued messages will be suppressed.');})}/><Form busy={busy} fields={[{...pw,label:'Current password'}]} label="Replace recovery code" run={b=>act(async()=>recovered(await request('/recovery-code',b)))}/><p className="help">Replacing the code signs out all sessions.</p></details>
        <details><summary>Verify captured email link</summary><Form busy={busy} fields={[user,{name:'token',label:'Email link token',type:'password',max:48,value:linkToken}]} label="Verify email" run={b=>act(async()=>{await request('/verify-contact',b);setLinkToken('');await refresh();setNotice('Recovery email verified.');})}/></details>
      </article></div></React.Fragment>}
    <footer>Offline candidate · fictional contacts and purchase fixtures · no wallet connection</footer></main></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
