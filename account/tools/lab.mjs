// Starter boundary tools only. No application/DB/provider execution.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const STARTER = 'hexdailydata-paid-api-lab';
export const WORKSPACE = 'HEXDailyData-Paid-API-Lab-20260919';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function ordinary(p, directory) {
  const s = fs.lstatSync(p);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw new Error(`Refused non-ordinary path: ${path.basename(p)}`);
}
export function rootCheck(input) {
  const root = path.resolve(input);
  if (path.basename(root) !== WORKSPACE) throw new Error(`Expected standalone directory named ${WORKSPACE}; no changes made.`);
  for (let p = root;; p = path.dirname(p)) {
    ordinary(p, true);
    if (p !== root && exists(path.join(p, '.git'))) throw new Error('Refused nested Git workspace; no parent repository was opened.');
    if (p === path.dirname(p)) break;
  }
  ordinary(path.join(root, '.lab-starter.json'), false);
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.lab-starter.json'), 'utf8'));
  if (marker.starter !== STARTER || marker.revision !== '2026-09-19' || marker.workspaceName !== WORKSPACE) throw new Error('Wrong lab marker.');
  return root;
}
function inventory(root, folder = '', out = []) {
  if (out.length > 1000 || folder.split('/').length > 16) throw new Error('Unexpected starter tree size/depth.');
  for (const e of fs.readdirSync(path.join(root, folder), {withFileTypes:true})) {
    const rel = folder ? `${folder}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`Symlink refused: ${rel}`);
    if (e.isDirectory()) inventory(root, rel, out);
    else if (e.isFile()) out.push(rel);
    else throw new Error(`Special file refused: ${rel}`);
  }
  return out.sort();
}
export function verifyPristine(root) {
  const manifestName=exists(path.join(root,'SOURCE_FILES.json'))?'SOURCE_FILES.json':'STARTER_FILES.json';
  ordinary(path.join(root, manifestName), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestName), 'utf8'));
  if (!['starter-boundary-only','lab-source'].includes(manifest.kind) || !Array.isArray(manifest.files)) throw new Error('Invalid starter manifest.');
  const expected = [...manifest.files.map(e => e.path), manifestName].sort();
  if (new Set(expected).size !== expected.length || JSON.stringify(expected) !== JSON.stringify(inventory(root))) throw new Error('Not a pristine starter; preserve existing files and inspect before setup.');
  for (const e of manifest.files) {
    if (path.isAbsolute(e.path) || e.path.includes('\\') || e.path.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('Unsafe manifest member.');
    const bytes = fs.readFileSync(path.join(root,e.path));
    if (bytes.length !== e.bytes || digest(bytes) !== e.sha256) throw new Error(`Starter differs: ${e.path}. No overwrite performed.`);
  }
  return expected;
}
export function git(root,args){return gitBytes(root,args).toString("utf8").trim();}
export function gitBytes(root, args) {
  // Do not inherit a main-worktree GIT_DIR, hooks or global signing/configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, {GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':os.devNull,GIT_TERMINAL_PROMPT:'0'});
  const r=spawnSync('git',['-c',`core.hooksPath=${path.join(root,'.local','no-hooks')}`,'-c','commit.gpgsign=false',...args],
    {cwd:root,env,stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:8*1024*1024});
  if (r.error || r.status !== 0) throw new Error(`Local git ${args[0]} failed (${r.error?.code ?? r.status}); inspect the lab, do not reset it.`);
  return r.stdout;
}
export function readState(root) {
  ordinary(path.join(root,'.local'),true);
  ordinary(path.join(root,'.local','lab.json'),false);
  ordinary(path.join(root,'.git'),true);
  const s=JSON.parse(fs.readFileSync(path.join(root,'.local','lab.json'),'utf8'));
  if (s.starter!==STARTER || s.root!==root || s.state!=='READY' || !/^[a-f0-9-]{36}$/.test(s.labId) || !/^hddpaylab-[a-f0-9]{12}$/.test(s.projectPrefix)) throw new Error('Local setup incomplete or identity mismatch; preserve work and inspect.');
  return s;
}
export function setup(input) {
  const root=rootCheck(input);
  const local=exists(path.join(root,'.local'));
  const repo=exists(path.join(root,'.git'));
  if (local || repo) {
    if (!local || !repo) throw new Error('Partial/unrecognized setup; preserve it and inspect rather than reinitialize.');
    const state=readState(root);
    if (path.resolve(git(root,['rev-parse','--show-toplevel']))!==root) throw new Error('Wrong repository root.');
    return {status:'LAB_REPOSITORY_READY',alreadyInitialized:true,labId:state.labId,projectPrefix:state.projectPrefix};
  }
  const [major,minor]=process.versions.node.split('.').map(Number);
  if (major<22 || (major===22 && minor<14)) throw new Error('Starter tools need Node22.14+; application target is Node24. No global upgrade performed.');
  const members=verifyPristine(root);
  git(root,['--version']);
  fs.mkdirSync(path.join(root,'.local','no-hooks'),{recursive:true});
  const id=randomUUID();
  try {
    git(root,['init','--initial-branch=main']);
    git(root,['add','--',...members]);
    git(root,['-c','user.name=HEXDailyData Lab','-c','user.email=lab@example.invalid','commit','-m','Initialize isolated paid API lab starter']);
    const state={starter:STARTER,state:'READY',root,labId:id,projectPrefix:'hddpaylab-'+id.replaceAll('-','').slice(0,12),starterCommit:git(root,['rev-parse','HEAD']),createdAt:new Date().toISOString()};
    fs.writeFileSync(path.join(root,'.local','lab.json'),JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});
    return {status:'LAB_REPOSITORY_READY',alreadyInitialized:false,labId:id,projectPrefix:state.projectPrefix,starterCommit:state.starterCommit,application:exists(path.join(root,'SOURCE_FILES.json'))?'IMPLEMENTED_RUNTIME_NOT_STARTED':'NOT_IMPLEMENTED'};
  } catch (error) {throw new Error(`Setup stopped; preserve partial local files. ${error.message}`);}
}
export function preflight(input) {
  const root=rootCheck(input),state=readState(root);
  return {status:'LAB_BOUNDARY_READY',root,labId:state.labId,projectPrefix:state.projectPrefix,node:process.versions.node,
    applicationRuntimeReady:process.versions.node.split('.')[0]==='24',note:'No DB, Docker, provider or application check performed; boundary metadata only.'};
}
export function packageSource(input) {
  const root=rootCheck(input),state=readState(root);
  if (git(root,['status','--porcelain','--untracked-files=normal'])) throw new Error('Commit reviewed lab source first; uncommitted work is preserved.');
  const tracked=git(root,['ls-files','-z']).split('\0').filter(Boolean);
  for (const name of tracked) {
    if (/^(\.local|work|node_modules|\.lab-cache|dist|playwright-report|test-results)(\/|$)/.test(name) || /(^|\/)\.env($|\.)/.test(name)) throw new Error('Runtime/secret path is tracked; refuse packaging.');
    ordinary(path.join(root,name),false);
  }
  const sha=git(root,['rev-parse','HEAD']);
  const work=path.join(root,'work');
  if (exists(work)) ordinary(work,true); else fs.mkdirSync(work);
  const dir=path.join(work,'delivery-'+sha.slice(0,7)+'-'+randomUUID().slice(0,8)); fs.mkdirSync(dir);
  const zip=path.join(dir,'HEXDailyData-Paid-API-Lab-source.zip');
  git(root,['archive','--format=zip',`--output=${zip}`,'HEAD']);
  const bytes=fs.readFileSync(zip);
  const receipt={labId:state.labId,commit:sha,file:path.basename(zip),bytes:bytes.length,sha256:digest(bytes),kind:'source-only; evidence is a separate allowlisted archive'};
  fs.writeFileSync(path.join(dir,'source-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return {...receipt,path:zip};
}
