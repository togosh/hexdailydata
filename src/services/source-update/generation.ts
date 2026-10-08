import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, open, lstat, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { z } from 'zod';
import { SavedSourceHolders } from '../source-holders/store.ts';
import { SavedSourceStakes } from '../source-stakes/store.ts';
import { sourceAddress } from '../source-holders/address.ts';
import { PageCursors } from '../queries/cursor.ts';
import { ApiFailure, restart, unavailable } from '../../api/errors.ts';
import { ACCEPTED, BASE_SNAPSHOT, TARGET_SNAPSHOT, GenerationSelectionSchema, type GenerationSelection } from '../../contracts/saved-generation.ts';
import { UpdateBundleSchema, type HolderUpdate, type StakeUpdate, type UpdatedHolderRecord, type UpdatedStakeRecord } from '../../contracts/source-update.ts';
import { holderAnomaly, SourceHolderTotalsSchema } from '../../contracts/source-holders.ts';
import { sourceUnits } from '../../contracts/source-stakes.ts';

export const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const canonical = (v: unknown): string => JSON.stringify(sort(v));
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]));
  return v;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const immutable = <T>(value:T):T => {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)) {
    for(const child of Object.values(value))immutable(child);
    Object.freeze(value);
  }
  return value;
};
const stateOf = (r: StakeUpdate['after']) => r.stakeEnd ? r.stakeGoodAccounting ? 'end_and_ga_link_present' : 'end_link_present' : r.stakeGoodAccounting ? 'ga_link_present' : 'no_end_or_ga_link';
const totals = SourceHolderTotalsSchema.parse({sourceRows:664405,representedAddresses:664405,sourcePositiveAddressCountExcludingZeroAddress:380242,
  zeroBalanceRows:284162,negativeBalanceRows:1,zeroAddressRows:1,duplicateAddressGroups:0,duplicateNumeralGroups:0,ambiguousAddressGroups:0,
  sourceOnly:true,balancesIndependentlyVerified:false,sumsAreTotalSupply:false,activeStakerCountAvailable:false});
type Route = 'holders'|'stakes'|'stake'|'address'|'addressStakes';
type Query = {source:'subgraph';chain:'pulsechain';generation?:GenerationSelection;datasetVersion?:string;holderDatasetVersion?:string;limit?:number;cursor?:string;address?:string;order?:'source-id-asc'};
type NewRow = {id:string;at:number;ownerAt?:number};
type Overlay = {
  holders:Map<string,UpdatedHolderRecord>; stakes:Map<string,UpdatedStakeRecord>;
  addresses:Map<string,UpdatedHolderRecord>; numeric:Map<string,UpdatedStakeRecord>;
  newHolders:NewRow[]; newStakes:NewRow[]; owners:Map<string,NewRow[]>;
  index: string; files: Record<string,{bytes:number;sha256:string}>;
};
const pointerSchema = z.strictObject({schemaVersion:z.literal(1),generation:GenerationSelectionSchema,
  holderDatasetVersion:z.string(),stakeDatasetVersion:z.string(),bundleRawSha256:z.string().nullable()});
const pointerFor = (generation:GenerationSelection) => ({schemaVersion:1 as const,generation,
  holderDatasetVersion:generation==='base'?ACCEPTED.baseBindings.tokenHolders.datasetVersion:ACCEPTED.familyVersions.tokenHolders,
  stakeDatasetVersion:generation==='base'?ACCEPTED.baseBindings.stakeStarts.datasetVersion:ACCEPTED.familyVersions.stakeStarts,
  bundleRawSha256:generation==='base'?null:ACCEPTED.bundle.rawFileSha256});
const safeRead = async (path:string, maximum:number) => {
  const st=await lstat(path); if(!st.isFile()||st.isSymbolicLink()||st.size>maximum) throw Error('UPDATE_FILE_BOUND');
  const bytes=await readFile(path); if(bytes.length!==st.size) throw Error('UPDATE_FILE_CHANGED'); return bytes;
};

/** One fixed admitted overlay over two immutable B0 readers. No provider or database dependency. */
export class SavedSourceGenerations {
  readonly root:string;
  private overlay:Overlay|undefined;
  private selected:GenerationSelection='base';
  private busy=0;
  private selecting=false;
  private status:'accepted'|'rejected_retained_last_accepted'='accepted';
  private ownsBases=false;
  private closed=false;
  private shared={references:1};
  readonly metrics={admissionMilliseconds:0,beforeComparisons:0,newIdentityChecks:0,requests:0,maximumBaseRecordsPerRequest:0,activationRssBytes:0};
  private constructor(root:string, readonly holders:SavedSourceHolders, readonly stakes:SavedSourceStakes) {
    this.root=resolve(root);
    for(const other of [holders.root,stakes.root]) if(this.root===other||this.root.startsWith(other+sep)||other.startsWith(this.root+sep)) throw Error('OVERLAY_BASE_ROOT_OVERLAP');
  }
  static async activate(config:{root:string;holdersRoot:string;stakesRoot:string}) {
    const holders=new SavedSourceHolders(config.holdersRoot), stakes=new SavedSourceStakes(config.stakesRoot);
    const instance=new SavedSourceGenerations(config.root,holders,stakes);
    try {
      await holders.replace(ACCEPTED.baseBindings.tokenHolders);
      await stakes.replace(ACCEPTED.baseBindings.stakeStarts);
      instance.ownsBases=true; instance.metrics.activationRssBytes=process.memoryUsage().rss; return instance;
    } catch(error) { await holders.close(); await stakes.close(); throw error; }
  }
  /** Reopen a restored overlay using these already admitted, immutable bases. */
  async reopen(root:string) {
    if(this.closed||this.busy||this.selecting) throw Error('GENERATION_BUSY');
    const next=new SavedSourceGenerations(root,this.holders,this.stakes);
    next.shared=this.shared;this.shared.references++;
    try { await next.admit(join(root,ACCEPTED.generation)); await next.loadSelection(); return next; }
    catch(error){this.shared.references--;throw error;}
  }
  get selection() { return this.selected; }
  get descriptor() { return pointerFor(this.selected); }
  private async files(input:string) {
    if(await realpath(input)!==resolve(input)||(await lstat(input)).isSymbolicLink()) throw Error('UPDATE_DIRECTORY');
    const raw=await safeRead(join(input,'BUNDLE.json'),64*1024*1024);
    const manifest=await safeRead(join(input,'MANIFEST.json'),65536);
    if(raw.length!==ACCEPTED.bundle.bytes||sha(raw)!==ACCEPTED.bundle.rawFileSha256) throw Error('UPDATE_RAW_IDENTITY');
    if(manifest.length!==ACCEPTED.manifest.bytes||sha(manifest)!==ACCEPTED.manifest.sha256) throw Error('UPDATE_MANIFEST_IDENTITY');
    const parsed:unknown=JSON.parse(raw.toString('utf8'));
    if(sha(canonical(parsed))!==ACCEPTED.bundle.semanticSortedJsonSha256) throw Error('UPDATE_SEMANTIC_IDENTITY');
    const bundle=UpdateBundleSchema.parse(parsed), m=JSON.parse(manifest.toString('utf8'));
    if(!m.applyAllowed||!m.completeScopedChangeWindow||m.fullB1Inventory||m.deletionsSupported||m.generation!==bundle.generation||
      !same(m.familyVersions,bundle.familyVersions)||!same(m.baseBindings,bundle.baseBindings)||!same(m.base,bundle.base)||!same(m.target,bundle.target)) throw Error('UPDATE_QUALIFICATION');
    const bytes:Record<string,Buffer>={'BUNDLE.json':raw,'MANIFEST.json':manifest};
    for(const [file,family] of [['holders','tokenHolders'],['stakes','stakeStarts']] as const) {
      const b=await safeRead(join(input,file+'.ndjson'),64*1024*1024), expected=m.files[file];
      if(b.length!==expected.bytes||sha(b)!==expected.sha256||!b.toString('utf8').endsWith('\n')) throw Error('UPDATE_NDJSON_IDENTITY');
      const rows=b.toString('utf8').trimEnd().split('\n').map(x=>JSON.parse(x));
      if(!same(rows,bundle.changes[family])) throw Error('UPDATE_FAMILY_MISMATCH');
      bytes[file+'.ndjson']=b;
    }
    return {bundle,bytes};
  }
  async admit(input:string) {
    if(this.closed||this.busy||this.selecting) throw Error('GENERATION_BUSY');
    this.selecting=true; const started=performance.now();
    try {
      const {bundle,bytes}=await this.files(resolve(input));
      const o:Overlay={holders:new Map(),stakes:new Map(),addresses:new Map(),numeric:new Map(),newHolders:[],newStakes:[],owners:new Map(),index:'',files:{}};
      const signal=new AbortController().signal;
      for(const family of ['tokenHolders','stakeStarts'] as const) {
        let previous=''; const seenKeys=new Set<string>();
        for(const entry of bundle.changes[family]) {
          if(entry.id<=previous||entry.after.id!==entry.id||entry.before&&entry.before.id!==entry.id) throw Error('UPDATE_ID_ORDER'); previous=entry.id;
          const base=family==='tokenHolders'?this.holders:this.stakes;
          const bound=await base.lowerBound(entry.id,signal), count=family==='tokenHolders'?664405:954680;
          const candidate=bound<count?await base.rowAt(bound,signal):null;
          const before=candidate?.reported.id===entry.id?candidate:null;
          if(!same(before?.reported??null,entry.before)) throw Error('UPDATE_BEFORE_MISMATCH');
          const fields=entry.before?Object.keys(entry.after).filter(k=>!same((entry.before as Record<string,unknown>)[k],(entry.after as Record<string,unknown>)[k])):Object.keys(entry.after);
          const kind=!before?'new':fields.length?'replacement':'unchanged_overlap';
          if(entry.kind!==kind||!same([...fields].sort(),[...entry.changedFields].sort())||new Set(entry.changedFields).size!==fields.length) throw Error('UPDATE_KIND_FIELDS');
          if(before) {
            const bp=entry.beforeProvenance, ep=base.evidenceAt(bound);
            if(!bp||bp.baseDatasetVersion!==ACCEPTED.baseBindings[family].datasetVersion||bp.ordinal!==bound||
              !same(bp.sourcePage,ep.sourcePage)||bp.rowInPage!==ep.rowInPage||await base.recordHashAt(bound,signal)!==bp.rowSha256) throw Error('UPDATE_BEFORE_PROVENANCE');
            this.metrics.beforeComparisons++;
          } else { if(entry.beforeProvenance!==null) throw Error('UPDATE_NEW_PROVENANCE'); this.metrics.newIdentityChecks++; }
          if(family==='tokenHolders') {
            const e=entry as HolderUpdate, key=e.after.holderAddress.toLowerCase();
            if(seenKeys.has(key)) throw Error('UPDATE_ADDRESS_CONFLICT'); seenKeys.add(key);
            const existing=await this.holders.lookup(key,undefined,signal);
            if(existing.item&&existing.item.reported.id!==e.id||e.before&&e.before.holderAddress.toLowerCase()!==key) throw Error('UPDATE_ADDRESS_CONFLICT');
            const b=before as Awaited<ReturnType<SavedSourceHolders['rowAt']>>|null;
            const row:UpdatedHolderRecord={reported:e.after,anomaly:holderAnomaly(e.after.tokenBalance,e.after.holderAddress),
              provenance:b?.provenance??null,observation:{kind:'observed_update',snapshot:TARGET_SNAPSHOT},update:e};
            immutable(row);o.holders.set(e.id,row);o.addresses.set(key,row);
            if(!before) o.newHolders.push({id:e.id,at:bound+o.newHolders.length});
          } else {
            const e=entry as StakeUpdate, key=e.after.stakeId;
            if(seenKeys.has(key)) throw Error('UPDATE_NUMERIC_CONFLICT'); seenKeys.add(key);
            const existing=await this.stakes.byNumericId(key,signal);
            if(existing&&existing.reported.id!==e.id||e.before&&(e.before.stakeId!==key||e.before.stakerAddr.toLowerCase()!==e.after.stakerAddr.toLowerCase())) throw Error('UPDATE_NUMERIC_OWNER_CONFLICT');
            const b=before as Awaited<ReturnType<SavedSourceStakes['rowAt']>>|null;
            const row:UpdatedStakeRecord={reported:e.after,recordState:stateOf(e.after),provenance:b?.provenance??null,
              observation:{kind:'observed_update',snapshot:TARGET_SNAPSHOT},update:e,
              discrepancies:kind==='unchanged_overlap'?b!.discrepancies:null,
              discrepancyAssessment:kind==='unchanged_overlap'?'base_source_internal':'unassessed_after_update',historicalBaseDiscrepancies:b?.discrepancies??[]};
            immutable(row);o.stakes.set(e.id,row);o.numeric.set(key,row);
            if(!before) {
              const owner=e.after.stakerAddr.toLowerCase(), inserts=o.owners.get(owner)??[];
              let lo=0,hi=this.stakes.ownerCount(owner);
              while(lo<hi){const mid=(lo+hi)>>>1; if((await this.stakes.ownerAt(owner,mid,signal)).reported.id<e.id)lo=mid+1;else hi=mid;}
              const ins={id:e.id,at:bound+o.newStakes.length,ownerAt:lo+inserts.length};
              o.newStakes.push(ins);inserts.push(ins);o.owners.set(owner,inserts);
            }
          }
        }
      }
      if(o.newHolders.length!==30||o.newStakes.length!==35) throw Error('UPDATE_LOCAL_COUNTS');
      o.index=canonical({schemaVersion:1,generation:ACCEPTED.generation,familyVersions:ACCEPTED.familyVersions,
        newHolders:o.newHolders,newStakes:o.newStakes,owners:[...o.owners],
        holderAddresses:[...o.addresses].map(([key,row])=>[key,row.reported.id]),stakeNumeric:[...o.numeric].map(([key,row])=>[key,row.reported.id])})+'\n';
      bytes['INDEX.json']=Buffer.from(o.index);
      for(const [name,b] of Object.entries(bytes))o.files[name]={bytes:b.length,sha256:sha(b)};
      bytes['ADMISSION.json']=Buffer.from(canonical({schemaVersion:1,generation:ACCEPTED.generation,files:o.files,baseBindings:ACCEPTED.baseBindings})+'\n');
      await mkdir(this.root,{recursive:true}); if(await realpath(this.root)!==this.root)throw Error('OVERLAY_ROOT_ALIAS');
      const destination=join(this.root,ACCEPTED.generation);
      let exists=true;try{await lstat(destination);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error;}
      if(exists) {
        for(const [name,b]of Object.entries(bytes))if(!b.equals(await safeRead(join(destination,name),64*1024*1024)))throw Error('DAMAGED_EXISTING_GENERATION');
      } else {
        const staging=join(this.root,'staging-'+randomUUID());await mkdir(staging);
        for(const [name,b]of Object.entries(bytes))await writeFile(join(staging,name),b,{flag:'wx'});
        await rename(staging,destination);
      }
      this.overlay=o;this.status='accepted';this.metrics.admissionMilliseconds=performance.now()-started;
      return {generation:ACCEPTED.generation,holderRows:1541,stakeRows:4278,newHolders:30,newStakes:35,localHolderRows:664435,localStakeRows:954715,indexSha256:sha(o.index)};
    } catch(error) {this.status='rejected_retained_last_accepted';throw error;}finally{this.selecting=false;}
  }
  private async verifySaved() {
    const o=this.overlay;if(!o)throw Error('GENERATION_NOT_ADMITTED');
    const directory=join(this.root,ACCEPTED.generation);
    if(await realpath(directory)!==directory)throw Error('GENERATION_DIRECTORY_ALIAS');
    for(const [name,expected]of Object.entries(o.files)) {
      const b=await safeRead(join(directory,name),64*1024*1024);
      if(b.length!==expected.bytes||sha(b)!==expected.sha256)throw Error('GENERATION_CHANGED');
    }
    const admission=await safeRead(join(directory,'ADMISSION.json'),65536);
    if(admission.toString('utf8')!==canonical({schemaVersion:1,generation:ACCEPTED.generation,files:o.files,baseBindings:ACCEPTED.baseBindings})+'\n')throw Error('GENERATION_BINDING_CHANGED');
  }
  async loadSelection() {
    if(this.closed||this.busy||this.selecting)throw Error('GENERATION_BUSY');this.selecting=true;
    try {
      const p=pointerSchema.parse(JSON.parse((await safeRead(join(this.root,'CURRENT.json'),4096)).toString('utf8')));
      if(!same(p,pointerFor(p.generation)))throw Error('MIXED_GENERATION_POINTER');
      if(p.generation!=='base')await this.verifySaved();this.selected=p.generation;this.status='accepted';
    }catch(error){this.status='rejected_retained_last_accepted';throw error;}
    finally{this.selecting=false;}
  }
  async select(generation:GenerationSelection, options:{beforePublish?:()=>Promise<void>}={}) {
    GenerationSelectionSchema.parse(generation);
    if(this.closed||this.busy||this.selecting)throw Error('GENERATION_BUSY'); this.selecting=true;
    let lock:Awaited<ReturnType<typeof open>>|undefined;
    const lockPath=join(this.root,'SELECTION.lock');
    try {
      lock=await open(lockPath,'wx');if(generation!=='base')await this.verifySaved();
      const exact=canonical(pointerFor(generation))+'\n', pointer=join(this.root,'CURRENT.json');
      let old:string|undefined;try{old=(await safeRead(pointer,4096)).toString('utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(old!==undefined) {const p=pointerSchema.parse(JSON.parse(old));if(!same(p,pointerFor(p.generation)))throw Error('MIXED_GENERATION_POINTER');}
      if(old!==exact){const stage=join(this.root,'selection-'+randomUUID()+'.json');await writeFile(stage,exact,{flag:'wx'});await options.beforePublish?.();await rename(stage,pointer);}
      this.selected=generation;this.status='accepted';return {generation,idempotent:old===exact};
    }catch(error){this.status='rejected_retained_last_accepted';throw error;}
    finally{if(lock){await lock.close();const {unlink}=await import('node:fs/promises');await unlink(lockPath);}this.selecting=false;}
  }
  private choose(route:Route,q:Query):GenerationSelection {
    const baseVersion=route==='holders'?ACCEPTED.baseBindings.tokenHolders.datasetVersion:ACCEPTED.baseBindings.stakeStarts.datasetVersion;
    const updateVersion=route==='holders'?ACCEPTED.familyVersions.tokenHolders:ACCEPTED.familyVersions.stakeStarts;
    const generation=q.generation??(q.datasetVersion===baseVersion||q.holderDatasetVersion===ACCEPTED.baseBindings.tokenHolders.datasetVersion?'base':this.selected);
    if(q.datasetVersion&&q.datasetVersion!==(generation==='base'?baseVersion:updateVersion)||
      q.holderDatasetVersion&&q.holderDatasetVersion!==(generation==='base'?ACCEPTED.baseBindings.tokenHolders.datasetVersion:ACCEPTED.familyVersions.tokenHolders))throw restart();
    if(generation!=='base'&&!this.overlay)throw unavailable();return generation;
  }
  private async holderAt(position:number,signal:AbortSignal):Promise<UpdatedHolderRecord> {
    const o=this.overlay!;let shift=0;
    for(const n of o.newHolders){if(n.at===position)return o.holders.get(n.id)!;if(n.at<position)shift++;else break;}
    const row=await this.holders.rowAt(position-shift,signal);
    return o.holders.get(row.reported.id)??{...row,observation:{kind:'retained_base',snapshot:BASE_SNAPSHOT},update:null};
  }
  private async stakeAt(position:number,address:string|null,signal:AbortSignal):Promise<UpdatedStakeRecord> {
    const o=this.overlay!, news=address?o.owners.get(address)??[]:o.newStakes;let shift=0;
    for(const n of news){const at=address?n.ownerAt!:n.at;if(at===position)return o.stakes.get(n.id)!;if(at<position)shift++;else break;}
    const row=address?await this.stakes.ownerAt(address,position-shift,signal):await this.stakes.rowAt(position-shift,signal);
    return o.stakes.get(row.reported.id)??{...row,observation:{kind:'retained_base',snapshot:BASE_SNAPSHOT},update:null,discrepancyAssessment:'base_source_internal',historicalBaseDiscrepancies:row.discrepancies};
  }
  async holderByAddress(address:string,signal:AbortSignal):Promise<UpdatedHolderRecord|null> {
    signal.throwIfAborted();const o=this.overlay;if(this.closed||!o)throw unavailable();const hit=o.addresses.get(address);if(hit)return hit;
    const base=await this.holders.lookup(address,undefined,signal);
    if(base.state==='unavailable')throw unavailable();
    return base.item?{...base.item,observation:{kind:'retained_base',snapshot:BASE_SNAPSHOT},update:null}:null;
  }
  async stakeByNumeric(id:string,signal:AbortSignal):Promise<UpdatedStakeRecord|null> {
    signal.throwIfAborted();const o=this.overlay;if(this.closed||!o)throw unavailable();const hit=o.numeric.get(id);if(hit)return hit;
    const base=await this.stakes.byNumericId(id,signal);
    return base?{...base,observation:{kind:'retained_base',snapshot:BASE_SNAPSHOT},update:null,discrepancyAssessment:'base_source_internal',historicalBaseDiscrepancies:base.discrepancies}:null;
  }
  async read(route:Route,q:Query,params:{address?:string;id?:string},signal:AbortSignal,cursors:PageCursors,now:number) {
    if(this.closed||this.selecting)throw unavailable();signal.throwIfAborted();
    const generation=this.choose(route,q);this.busy++;this.metrics.requests++;
    const reads=this.holders.metrics.parsedRecords+this.stakes.metrics.parsedRecords;
    try {
      if(generation==='base') {
        if(route==='holders')return await this.holders.read({...q,limit:q.limit??50,order:'source-id-asc'},signal,cursors,now);
        if(route==='address'||route==='addressStakes')return await sourceAddress(this.stakes,this.holders,route,{...q,limit:q.limit??50},params.address!,signal,cursors,now);
        return await this.stakes.read(route,q,params,signal,cursors,now);
      }
      const envelope={chain:'pulsechain' as const,source:'subgraph' as const,generation,familyVersions:ACCEPTED.familyVersions,
        baseSnapshot:BASE_SNAPSHOT,snapshot:TARGET_SNAPSHOT,coverage:'accepted_base_plus_observed_updates' as const,refreshEnabled:false,
        sourceOnly:true,fullB1InventoryProven:false,deletionsSupported:false,reorgSafetyProven:false,method:'inclusive_block_overlap_full_object_upserts',
        bundleRawSha256:ACCEPTED.bundle.rawFileSha256,bundleSemanticSha256:ACCEPTED.bundle.semanticSortedJsonSha256,selectionStatus:this.status};
      if(route==='stake') {
        const item=await this.stakeByNumeric(params.id!,signal);
        if(item&&q.address&&q.address!==item.reported.stakerAddr.toLowerCase())throw new ApiFailure(409,'incompatible_owner','Owner hint conflicts with saved source record.');
        return {...envelope,datasetVersion:ACCEPTED.familyVersions.stakeStarts,reportedStakeId:params.id,presence:item?'present_in_saved_view':'not_present_in_saved_view',item};
      }
      const address=params.address??q.address??null,limit=q.limit??50;
      if(!Number.isInteger(limit)||limit<1||limit>100||address&&!/^0x[0-9a-f]{40}$/.test(address))throw unavailable();
      const count=route==='holders'?664435:address?this.stakes.ownerCount(address)+(this.overlay!.owners.get(address)?.length??0):954715;
      const binding=sha(canonical([generation,ACCEPTED.familyVersions,route,q.source,q.chain,address,limit,'source-id-asc']));
      const cursor=cursors.decode(q.cursor,binding,now);
      if(cursor&&(cursor.identity!==generation||!/^(0|[1-9][0-9]{0,6})$/.test(cursor.key)))throw restart();
      const offset=cursor?Number(cursor.key):0;if(offset>count)throw restart();
      const items: Array<UpdatedHolderRecord|UpdatedStakeRecord>=[];
      for(let i=offset;i<Math.min(offset+limit,count);i++) items.push(route==='holders'?await this.holderAt(i,signal):await this.stakeAt(i,address,signal));
      const next=offset+items.length,nextCursor=next<count?cursors.encode(binding,generation,String(next),now,cursor?.expires):null;
      if(route==='holders')return {...envelope,datasetVersion:ACCEPTED.familyVersions.tokenHolders,baseTotals:totals,localViewRowCount:664435,order:'source-id-asc',items,nextCursor};
      const body={...envelope,datasetVersion:ACCEPTED.familyVersions.stakeStarts,baseInventorySourceStartCount:954680,localViewRowCount:954715,address,sourceStartCount:count,items,nextCursor};
      if(route!=='address'&&route!=='addressStakes')return body;
      const item=await this.holderByAddress(address!,signal);
      const holder=item?{state:item.anomaly?'source_anomaly':'present_in_saved_view',item,reason:item.anomaly}:{state:'not_present_in_saved_view',item:null,reason:null};
      const liquidBalance=item&&!item.anomaly?{sourceToken:item.reported.tokenBalance,sourceReportedHex:sourceUnits(item.reported.tokenBalance,8),attribution:'source_reported_at_saved_pin'}:null;
      return {...body,holder,holderDatasetVersion:ACCEPTED.familyVersions.tokenHolders,liquidBalance,ranks:null};
    }finally{this.busy--;this.metrics.maximumBaseRecordsPerRequest=Math.max(this.metrics.maximumBaseRecordsPerRequest,this.holders.metrics.parsedRecords+this.stakes.metrics.parsedRecords-reads);}
  }
  async close(){
    if(this.closed)return;
    if(this.busy||this.selecting||this.ownsBases&&this.shared.references>1)throw Error('GENERATION_BUSY');
    if(this.ownsBases){await this.holders.close();await this.stakes.close();}
    this.shared.references--;this.overlay=undefined;this.closed=true;
  }
}
