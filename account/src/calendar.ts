import type pg from "pg";
import { Denied } from "./db.js";

export const calendarKind = "calendar-v1";
export function monthBoundary(anchor: Date, offset: number): Date {
  if (!(anchor instanceof Date) || !Number.isFinite(+anchor) || !Number.isInteger(offset) || offset < 0 || offset > 120000)
    throw new Denied("INVALID_CALENDAR_ANCHOR",400);
  const out = new Date(+anchor), day = anchor.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(anchor.getUTCMonth()+offset);
  const last = new Date(+out);last.setUTCMonth(last.getUTCMonth()+1,0);
  out.setUTCDate(Math.min(day,last.getUTCDate()));
  if (out.getUTCFullYear()<1 || out.getUTCFullYear()>9999) throw new Denied("INVALID_CALENDAR_ANCHOR",400);
  return out;
}
export type CalendarTerms = {anchor:Date;index:number;months:1|12};
export function purchaseCalendar(now:Date,current:any,months:1|12):CalendarTerms {
  // The caller already refused an occupied successor slot. An ended term is not
  // current: exact-end fulfillment without a saved successor starts a new anchor.
  if(current?.kind===calendarKind) return {anchor:current.anchor,index:current.monthIndex+current.months,months};
  return {anchor:new Date(current?.end??now),index:0,months};
}
export async function calendarWindows(q:pg.PoolClient,g:any,now:Date) {
  if(g.term_kind!==calendarKind || ![1,12].includes(g.calendar_months) || !Number.isInteger(g.calendar_index) || g.calendar_index<0 ||
    +g.starts_at!==+monthBoundary(g.calendar_anchor,g.calendar_index) || +g.ends_at!==+monthBoundary(g.calendar_anchor,g.calendar_index+g.calendar_months))
    throw new Denied("CALENDAR_UNAVAILABLE",503);
  const {rows}=await q.query(`SELECT w.*,u.used,
    (SELECT count(*)::int FROM meter_receipt r WHERE r.account_id=w.account_id AND r.period_id=w.term_id
      AND r.window_id=w.id AND r.state='pending' AND r.expires_at>$2) held
    FROM allowance_window w LEFT JOIN window_usage u ON (u.account_id,u.term_id,u.window_id)=(w.account_id,w.term_id,w.id)
    WHERE w.term_id=$1 ORDER BY w.ordinal LIMIT 13`,[g.id,now]);
  if(rows.length!==g.calendar_months) throw new Denied("CALENDAR_UNAVAILABLE",503);
  for(let i=0;i<rows.length;i++) {
    const w=rows[i];
    if(w.ordinal!==i || w.account_id!==g.account_id || w.allowance!==g.allowance || w.threshold!==g.reminder_threshold ||
      +w.starts_at!==+monthBoundary(g.calendar_anchor,g.calendar_index+i) || +w.ends_at!==+monthBoundary(g.calendar_anchor,g.calendar_index+i+1) ||
      !Number.isInteger(w.used) || w.used<0 || w.used+w.held>w.allowance) throw new Denied("CALENDAR_UNAVAILABLE",503);
  }
  const found=rows.find(w=>+w.starts_at<=+now && +now<+w.ends_at);
  const view=(w:any)=>({id:w.id,ordinal:w.ordinal,start:w.starts_at,end:w.ends_at,allowance:w.allowance,threshold:w.threshold,used:w.used,held:w.held,remaining:w.allowance-w.used-w.held});
  return {window:found?view(found):null,firstWindow:view(rows[0]),windows:rows.map(view)};
}
