import type pg from "pg";
import { boundedTransaction } from "./metering.js";
import { databaseTime, periodSummary, selectPeriods } from "./period.js";
import { accountRecipient } from "./account-mail.js";

export const windowReminderKey=(account:string,term:string,window:string,threshold:number)=>
  "window-quota:"+JSON.stringify([account,term,window,threshold]);
const offset=(end:Date,now:Date)=>+end>+now && +end-+now<=7*86400000 ? (+end-+now<=86400000 ? 1 : 7) : null;
function calendarCoverage(s:any) {
  return s.current && (s.current.kind==="calendar-v1" || (s.next?.kind==="calendar-v1" && +s.next.start===+s.current.end));
}
export async function calendarReminderValid(pool:pg.Pool,key:string,clock=databaseTime) {
  let v:any;try {v=JSON.parse(key.slice(key.indexOf(":")+1));} catch {return false;}
  if(!Array.isArray(v)||typeof v[0]!=="string")return false;
  const s=await periodSummary(pool,v[0],clock);
  if(!s.access || !s.current?.window)return false;
  if(key.startsWith("window-quota:")) return v.length===4 && s.current?.id===v[1] &&
    s.current.window?.id===v[2] && s.current.window.threshold===v[3] && s.current.window.used>=v[3];
  return key.startsWith("calendar-expiry:") && v.length===3 && calendarCoverage(s) &&
    s.paidThrough?.toISOString()===v[1] && offset(s.paidThrough!,s.asOf)===v[2];
}
// Explicit finite invocation only. Account IDs are supplied by the trusted owner;
// there is no timer, provider work, or calendar rollover job.
export async function queueCalendarExpiry(pool:pg.Pool,accounts:string[],clock=databaseTime) {
  if(accounts.length>32)throw Error("REMINDER_BATCH_LIMIT");
  let queued=0;
  for(const id of new Set(accounts)) await boundedTransaction(pool,{},async q=>{
    const {rows:[a]}=await q.query("SELECT disabled FROM customer WHERE id=$1 FOR UPDATE",[id]);
    if(!a || a.disabled)return;
    const now=await clock(q),s=await selectPeriods(q,id,now);
    if(!calendarCoverage(s)||!s.paidThrough)return;
    const days=offset(s.paidThrough,now),recipient=await accountRecipient(q,id);
    if(!days||!recipient)return;
    queued+=(await q.query(`INSERT INTO outbox(id,dedup,recipient,subject,body)
      VALUES(gen_random_uuid(),$1,$2,'Lab access expiry reminder',$3) ON CONFLICT(dedup) DO NOTHING`,
      ["calendar-expiry:"+JSON.stringify([id,s.paidThrough.toISOString(),days]),recipient,
       "Your synthetic prepaid access ends "+s.paidThrough.toISOString()+". Renewal is optional."])).rowCount??0;
  });
  return {queued};
}
