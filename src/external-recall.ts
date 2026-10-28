import { ContextForgeStore, sha256, createStoreReadBudget } from './store.ts';
import { planContext, type PlanContextInput, type ContextPlan } from './planner.ts';
import { analyzeRecallQuery, scoreFacetCoverage } from './retrieval.ts';

export const CONTEXTFORGE_SUPPLEMENT_ORIGIN = 'contextforge-native';
export interface ExternalRecallRef { providerId:string; corpus:string; key:string; revision:string }
export interface ExternalRecallRequest {
  query:string; querySha256:string; namespaceId:string; namespaceGeneration:number;
  sessionId:string; limit:number; deadlineAt?:number; signal?:AbortSignal;
  callerContext?:unknown; excludeOrigins:string[];
}
export interface ExternalRecallCandidate {
  ref:ExternalRecallRef; rank:number; score?:number;
  nativeRef?:{namespaceId:string; nodeId?:string; sourceId?:string; spanIds?:string[]; contentSha256:string};
  snippet?:string;
}
export interface ExternalRecallBatch {
  adapterId:string; adapterVersion:string; querySha256:string; namespaceId:string;
  namespaceGeneration:number; complete:boolean; candidates:ExternalRecallCandidate[]; warnings:string[];
}
export interface ExternalRecallDocument {
  ref:ExternalRecallRef; text:string; contentSha256:string; observedAt?:number;
  provenance:Record<string,unknown>; fidelity:'exact'|'extractive'|'lossy';
}
export interface ExternalRecallAdapter {
  id:string; version:string;
  search(request:ExternalRecallRequest):Promise<ExternalRecallBatch>;
  get?(ref:ExternalRecallRef, request:ExternalRecallRequest):Promise<ExternalRecallDocument|null>;
}
/** Only an injected host resolver may mint this binding. No model parameters are consulted. */
export interface TrustedRecallBinding { callerContext:unknown; namespaceId:string; assertCurrent:()=>void }
export interface ExternalRecallOptions {
  adapter?:ExternalRecallAdapter;
  /**
   * fallbackMinCoverage (0..1, e.g. 0.05 for 5%): optional semantic/embedding fallback dial.
   * When set in [0, 1], external/semantic recall is skipped if native deterministic lexical/entity
   * facet coverage is already >= fallbackMinCoverage, and only triggered when native coverage < fallbackMinCoverage.
   */
  policy?:{enabled?:boolean; importSnapshots?:boolean; supplement?:boolean; fallbackMinCoverage?:number; limit?:number; timeoutMs?:number};
  resolveCallerContext?:(hostContext:unknown)=>TrustedRecallBinding|Promise<TrustedRecallBinding>;
  hostContext?:unknown;
}
export interface PreparedRecall {
  querySha256:string; namespaceId:string; namespaceGeneration:number;
  adapterId?:string; adapterVersion?:string;
  status:'disabled'|'unavailable'|'ready'|'degraded'; complete:boolean; warnings:string[];
  nativeCoverageRatio?:number;
  candidates:Array<ExternalRecallCandidate & { sourceIds:string[]; discoveryPrior:number }>;
  suggestions:Array<ExternalRecallCandidate & {discoveryOnly:true}>;
}
/**
 * Measure the weighted question-facet coverage ratio [0, 1] achieved by native deterministic
 * lexical + L1/L2 entity routing before deciding whether to invoke an external/embedding adapter.
 */
export function measureNativeLexicalCoverage(store:ContextForgeStore, query:string, namespaceId=store.namespaceId, deadlineAt=Infinity):number {
  store.assertNamespace(namespaceId);
  const recall=analyzeRecallQuery(query);
  const qFacets=recall.facets.filter(f=>f.origin==='question');
  const totalWeight=qFacets.reduce((n,f)=>n+f.weight,0);
  if(totalWeight<=0)return 1;
  const budget=createStoreReadBudget({maxInspected:256,maxBytes:512*1024,deadlineAt});
  const hits=store.search(query,{namespaceId,layers:[0,1,2],limit:32,maxInspected:128,maxStatisticsInspected:64,deadlineAt,budget});
  const covered=new Set<string>();
  for(const h of hits){
    const sc=scoreFacetCoverage(recall,h.title+' '+h.body);
    if(sc.anchored&&sc.score>0)for(const id of sc.matchedFacetIds)covered.add(id);
  }
  const coveredWeight=qFacets.filter(f=>covered.has(f.id)).reduce((n,f)=>n+f.weight,0);
  return coveredWeight/totalWeight;
}
export function externalRecallStatus(options:ExternalRecallOptions = {}) {
  const enabled=options.policy?.enabled===true;
  return {enabled, available:enabled&&!!options.adapter&&!!options.resolveCallerContext,
    fallbackMinCoverage:options.policy?.fallbackMinCoverage??null,
    reason:!enabled?'disabled':!options.adapter?'adapter_unavailable':!options.resolveCallerContext?'trusted_caller_binding_unavailable':'injected_adapter',
    snapshotLifecycle:'Snapshots are immutable observations; refresh/invalidation requires explicit host lifecycle management.'};
}
function generation(store:ContextForgeStore, ns:string):number {
  store.assertNamespace(ns);
  return Number(store.db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(ns)!.generation);
}
function abort(signal?:AbortSignal):void { if(signal?.aborted) throw signal.reason??new DOMException('Aborted','AbortError'); }
function sameRef(a:ExternalRecallRef,b:ExternalRecallRef):boolean {
  return !!a&&!!b&&['providerId','corpus','key','revision'].every(k=>typeof a[k]==='string'&&a[k]!==''&&a[k]===b[k]);
}
/** Resolve only native authority, never the adapter's display/snippet text. */
export function validateNativeRecallReference(store:ContextForgeStore, ns:string, candidate:ExternalRecallCandidate):string[] {
  const ref=candidate.nativeRef;
  if(!ref||ref.namespaceId!==ns) throw new Error('ExternalNativeScopeMismatch');
  store.assertNamespace(ns);
  const sourceIds=new Set<string>();
  if(ref.nodeId){
    const node=store.db.prepare("SELECT * FROM derived_nodes WHERE namespace_id=? AND node_id=? AND status='active'").get(ns,ref.nodeId);
    if(!node||node.content_sha256!==ref.contentSha256) throw new Error('ExternalNativeNodeUnavailable');
    const provenance=store.getProvenance(ref.nodeId);
    if(!provenance.length) throw new Error('ExternalNativeSupportUnavailable');
    for(const span of provenance) { sourceIds.add(span.sourceId); store.readEvidenceSpan(span.spanId,{namespaceId:ns}); }
    if(ref.spanIds?.some(id=>!provenance.some(p=>p.spanId===id))) throw new Error('ExternalNativeSpanMismatch');
  } else if(ref.sourceId) {
    const source=store.getSource(ref.sourceId);
    if(!source||source.contentSha256!==ref.contentSha256) throw new Error('ExternalNativeRevisionMismatch');
    sourceIds.add(ref.sourceId);
  } else throw new Error('ExternalNativeReferenceMissing');
  if(ref.sourceId&&!sourceIds.has(ref.sourceId)) throw new Error('ExternalNativeSourceMismatch');
  for(const id of sourceIds){
    const source=store.getSource(id);
    if(!source||source.namespaceId!==ns||source.status!=='active'||source.originSystem===CONTEXTFORGE_SUPPLEMENT_ORIGIN) throw new Error('ExternalNativeSourceUnavailable');
    store.readSourceBlob(id);
  }
  for(const id of ref.spanIds??[]) {
    const span=store.db.prepare('SELECT source_id FROM spans WHERE span_id=?').get(id);
    if(!span||!sourceIds.has(String(span.source_id))) throw new Error('ExternalNativeSpanMismatch');
    store.readEvidenceSpan(id,{namespaceId:ns});
  }
  return [...sourceIds].sort();
}

/** Async work is bounded and occurs before the planner's writer transaction. */
export async function prepareExternalRecall(input:Pick<PlanContextInput,'store'|'query'|'sessionId'|'namespaceId'|'abortSignal'|'deadlineAt'|'sourceIds'|'attachments'>, options:ExternalRecallOptions={}):Promise<PreparedRecall> {
  const ns=input.namespaceId??input.store.namespaceId;
  const result:PreparedRecall={querySha256:sha256(input.query),namespaceId:ns,namespaceGeneration:generation(input.store,ns),status:'disabled',complete:false,warnings:[],candidates:[],suggestions:[]};
  abort(input.abortSignal);
  if(options.policy?.enabled!==true) return result;
  const recall=analyzeRecallQuery(input.query);
  if(!recall.substantiveTerms.length&&!input.sourceIds?.length&&!input.attachments?.length) return result;
  const fallbackThreshold=options.policy.fallbackMinCoverage;
  if(fallbackThreshold!==undefined) {
    if(!Number.isFinite(fallbackThreshold)||fallbackThreshold<0||fallbackThreshold>1) throw new Error('Invalid fallbackMinCoverage: must be 0..1');
    const ratio=measureNativeLexicalCoverage(input.store,input.query,ns,input.deadlineAt);
    result.nativeCoverageRatio=ratio;
    if(ratio>=fallbackThreshold) return result;
  }
  result.status='unavailable';
  if(!options.adapter||!options.resolveCallerContext){result.warnings.push('External recall unavailable: injected adapter and trusted caller binding are required.');return result;}
  const adapter=options.adapter;
  result.adapterId=adapter.id; result.adapterVersion=adapter.version;
  const controller=new AbortController();
  const timeout=Math.max(1,Math.min(options.policy.timeoutMs??2000,30000));
  const deadlineAt=Math.min(input.deadlineAt??Infinity,Date.now()+timeout);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let onAbort:()=>void=()=>{};
  const bounded=async <T>(work:Promise<T>):Promise<T> => Promise.race([work,new Promise<never>((_,reject)=>{
    const fail=(reason:unknown)=>{controller.abort(reason);reject(reason);};
    onAbort=()=>fail(input.abortSignal?.reason??new DOMException('Aborted','AbortError'));
    input.abortSignal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>fail(new Error('ExternalRecallDeadline')),Math.max(0,deadlineAt-Date.now()));
  })]).finally(()=>{if(timer)clearTimeout(timer);input.abortSignal?.removeEventListener('abort',onAbort);});
  try {
    const binding=await bounded(Promise.resolve(options.resolveCallerContext(options.hostContext)));
    abort(input.abortSignal); binding.assertCurrent();
    if(binding.namespaceId!==ns||binding.callerContext==null) throw new Error('ExternalCallerScopeMismatch');
    const request:ExternalRecallRequest={query:input.query,querySha256:result.querySha256,namespaceId:ns,namespaceGeneration:result.namespaceGeneration,sessionId:input.sessionId,limit:Math.max(1,Math.min(options.policy.limit??16,128)),deadlineAt,signal:controller.signal,callerContext:binding.callerContext,excludeOrigins:[CONTEXTFORGE_SUPPLEMENT_ORIGIN]};
    if(Date.now()>=deadlineAt) throw new Error('ExternalRecallDeadline');
    const batch=await bounded(adapter.search(request));
    binding.assertCurrent(); abort(input.abortSignal);
    if(batch.adapterId!==adapter.id||batch.adapterVersion!==adapter.version||batch.querySha256!==request.querySha256||batch.namespaceId!==ns||batch.namespaceGeneration!==request.namespaceGeneration) throw new Error('ExternalRecallBindingMismatch');
    if(generation(input.store,ns)!==request.namespaceGeneration) throw new Error('ExternalRecallGenerationChanged');
    const seen=new Set<string>();
    for(const proposal of batch.candidates.slice(0,request.limit)) {
      const candidate={...proposal,nativeRef:proposal.nativeRef?{...proposal.nativeRef}:undefined};
      abort(input.abortSignal); binding.assertCurrent();
      if(!sameRef(candidate.ref,candidate.ref)||candidate.ref.providerId===CONTEXTFORGE_SUPPLEMENT_ORIGIN||candidate.ref.corpus===CONTEXTFORGE_SUPPLEMENT_ORIGIN||!Number.isSafeInteger(candidate.rank)||candidate.rank<1) continue;
      try {
        let sourceIds:string[];
        if(candidate.nativeRef) sourceIds=validateNativeRecallReference(input.store,ns,candidate);
        else {
          if(!options.policy.importSnapshots||!adapter.get){const key=JSON.stringify(candidate.ref);if(!seen.has(key)){seen.add(key);result.suggestions.push({...candidate,discoveryOnly:true});}continue;}
          const doc=await bounded(adapter.get(candidate.ref,request));
          binding.assertCurrent(); abort(input.abortSignal);
          if(generation(input.store,ns)!==result.namespaceGeneration) throw new Error('ExternalRecallGenerationChanged');
          if(!doc||!sameRef(doc.ref,candidate.ref)||sha256(doc.text)!==doc.contentSha256||!['exact','extractive','lossy'].includes(doc.fidelity)) throw new Error('ExternalDocumentBindingMismatch');
          const key=JSON.stringify([doc.ref.providerId,doc.ref.corpus,doc.ref.key,doc.ref.revision,doc.contentSha256]);
          if(seen.has(key))continue;seen.add(key);
          const source=input.store.ingestSource({namespaceId:ns,kind:'external_snapshot',originSystem:'external-recall',originKey:sha256(key),originRevision:doc.ref.revision,trustClass:'external_untrusted',text:doc.text,observedAt:doc.observedAt,metadata:{externalRef:doc.ref,contentSha256:doc.contentSha256,fidelity:doc.fidelity,provenance:JSON.parse(JSON.stringify(doc.provenance)),snapshotSemantics:true}});
          if(source.status!=='active')throw new Error('ExternalSnapshotRevoked');
          result.namespaceGeneration=generation(input.store,ns);
          sourceIds=[source.sourceId];
          candidate.nativeRef={namespaceId:ns,sourceId:source.sourceId,contentSha256:source.contentSha256};
          result.warnings.push('Imported external snapshot is untrusted note evidence, not proof of underlying originals; refresh/invalidation is explicit.');
        }
        const key=JSON.stringify(candidate.nativeRef);
        if(seen.has(key))continue;seen.add(key);
        result.candidates.push({...candidate,sourceIds,discoveryPrior:1/(60+candidate.rank)});
      } catch(error) {
        abort(input.abortSignal);
        if(controller.signal.aborted||(error instanceof Error&&error.message==='ExternalRecallGenerationChanged'))throw error;
        result.warnings.push('External candidate rejected: invalid or unavailable native/document binding.');
      }
    }
    if(generation(input.store,ns)!==result.namespaceGeneration) throw new Error('ExternalRecallGenerationChanged');
    if(batch.warnings?.length)result.warnings.push('External provider reported incomplete or snapshot coverage.');
    result.complete=batch.complete&&batch.candidates.length<=request.limit&&!result.warnings.length;
    result.status=result.warnings.length?'degraded':'ready';
  } catch(error) {
    abort(input.abortSignal);
    result.status='degraded';result.complete=false;result.candidates=[];result.suggestions=[];
    result.warnings.push(error instanceof Error&&error.message==='ExternalRecallGenerationChanged'?'External recall generation changed; native fallback.':'External recall unavailable, timed out, or failed binding validation; native fallback.');
  } finally {controller.abort();}
  return result;
}

/** Called again by the synchronous planner inside its writer transaction. */
export function revalidatePreparedRecall(store:ContextForgeStore, query:string, namespaceId:string, prepared:PreparedRecall):PreparedRecall {
  const rejected=(warning:string):PreparedRecall=>({...prepared,status:'degraded',complete:false,candidates:[],suggestions:[],warnings:[...prepared.warnings,warning]});
  if(prepared.status==='disabled'||prepared.status==='unavailable') return prepared;
  if(prepared.querySha256!==sha256(query)||prepared.namespaceId!==namespaceId||prepared.namespaceGeneration!==generation(store,namespaceId))
    return rejected('External prepared recall snapshot mismatch; native fallback.');
  const candidates:PreparedRecall['candidates']=[];
  for(const candidate of prepared.candidates) {
    try { candidates.push({...candidate,sourceIds:validateNativeRecallReference(store,namespaceId,candidate)}); }
    catch { return rejected('External prepared native reference is no longer available; native fallback.'); }
  }
  return {...prepared,candidates};
}

// Keep native bindings separately from the rendered-content hash in the receipt.
// This also catches direct lifecycle/revision edits that do not bump generation.
const planBindings = new WeakMap<ContextPlan, Array<{
  namespaceId:string; sourceId:string; sourceSha256:string; sourceStatus:string;
  nodes:Array<{nodeId:string; nodeSha256:string; nodeStatus:string}>;
}>>();
const planRecallBindings = new WeakMap<ContextPlan, PreparedRecall>();
function bindContextPlan(store:ContextForgeStore, plan:ContextPlan, prepared:PreparedRecall):ContextPlan {
  planRecallBindings.set(plan,prepared);
  planBindings.set(plan,plan.receipt.selections.map(item=>{
    const source=store.getSource(item.sourceId);
    if(!source||source.namespaceId!==item.namespaceId)throw new Error('ContextPlanNativeReferenceUnavailable');
    // A quoted L0 selection can also render several routed interpretations. Display
    // traces are lossy on merge; only the explicit complete contributor set is authority.
    const nodeIds=new Set([...(item.nodeId?[item.nodeId]:[]),...(item.derivedNodeIds??[])]);
    const nodes=[...nodeIds].sort().map(nodeId=>{
      const node=store.db.prepare('SELECT content_sha256,status FROM derived_nodes WHERE namespace_id=? AND node_id=?').get(item.namespaceId,nodeId);
      if(!node||node.status==='withdrawn')throw new Error('ContextPlanNativeReferenceUnavailable');
      return {nodeId,nodeSha256:String(node.content_sha256),nodeStatus:String(node.status)};
    });
    return {namespaceId:item.namespaceId,sourceId:item.sourceId,sourceSha256:source.contentSha256,sourceStatus:source.status,nodes};
  }));
  return plan;
}
/** Synchronous final-dispatch guard. Call after every await and before returning messages.
 * Fails closed: callers must start a fresh admission rather than dispatch stale evidence.
 */
export function assertContextPlanCurrent(store:ContextForgeStore, plan:ContextPlan, signal?:AbortSignal):void {
  abort(signal);
  for(const [ns,expected] of Object.entries(plan.receipt.namespaceGeneration)) {
    if(generation(store,ns)!==expected)throw new Error('ContextPlanGenerationChanged');
  }
  const prepared=planRecallBindings.get(plan);
  if(prepared)for(const candidate of prepared.candidates) {
    try { validateNativeRecallReference(store,prepared.namespaceId,candidate); }
    catch { throw new Error('ContextPlanNativeReferenceUnavailable'); }
  }
  const bindings=planBindings.get(plan);
  if(!bindings)throw new Error('ContextPlanNativeBindingsMissing');
  for(const binding of bindings) {
    const source=store.getSource(binding.sourceId);
    if(!source||source.namespaceId!==binding.namespaceId||source.status==='withdrawn'||source.status!==binding.sourceStatus||source.contentSha256!==binding.sourceSha256)
      throw new Error('ContextPlanNativeReferenceUnavailable');
    store.readSourceBlob(binding.sourceId);
    for(const boundNode of binding.nodes) {
      const node=store.db.prepare('SELECT content_sha256,status FROM derived_nodes WHERE namespace_id=? AND node_id=?').get(binding.namespaceId,boundNode.nodeId);
      if(!node||node.status==='withdrawn'||node.status!==boundNode.nodeStatus||node.content_sha256!==boundNode.nodeSha256)
        throw new Error('ContextPlanNativeReferenceUnavailable');
    }
  }
  for(const item of plan.receipt.selections)for(const spanId of item.provenanceSpanIds)
    store.readEvidenceSpan(spanId,{namespaceId:item.namespaceId,allowSupersededSource:true});
}

export async function planContextWithRecall(input:PlanContextInput, options:ExternalRecallOptions={}):Promise<ContextPlan> {
  let prepared=await prepareExternalRecall(input,options);
  if(prepared.warnings.some(w=>w.includes('generation changed'))) prepared=await prepareExternalRecall(input,options);
  abort(input.abortSignal);
  // No async gap between final validation and the planner's writer transaction.
  prepared=revalidatePreparedRecall(input.store,input.query,input.namespaceId??input.store.namespaceId,prepared);
  const plan=bindContextPlan(input.store,planContext({...input,preparedRecall:prepared} as PlanContextInput),prepared);
  assertContextPlanCurrent(input.store,plan,input.abortSignal);
  return plan;
}
