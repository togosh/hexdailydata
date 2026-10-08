import type pg from "pg";
import type {Config} from "./config.js";
import {readFile} from "node:fs/promises";
import {boundedTransaction} from "./metering.js";
export async function installCalendar(pool:pg.Pool,c:Config) {
  const sql=await readFile(new URL('./calendar.sql',import.meta.url),'utf8');
  await boundedTransaction(pool,{},async q=>{
    const {rows:[r]}=await q.query(`SELECT current_database() db,current_user usr,host(inet_server_addr()) addr,lab_id,run_id FROM boundary.identity`);
    if(r?.db!==c.database || r.usr!=='lab_migrator' || r.addr!==c.dbAddress || r.lab_id!==c.labId || r.run_id!==c.runId)throw Error('WRONG_MIGRATION_TARGET');
    const {rows:[role]}=await q.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    if(role.rolsuper || role.rolcreatedb || role.rolcreaterole)throw Error('UNSAFE_MIGRATION_ROLE');
    await q.query('SELECT pg_advisory_xact_lock(733105,3)');
    await q.query(sql);
  });
}
