import { ContextForgeStore, stableId, createStoreReadBudget } from './store.ts';
import { analyzeRecallQuery, scoreFacetCoverage } from './retrieval.ts';
import { estimateTokens } from './symbolic-ir.ts';
import { getLanguageGrammar, decomposeCodeSource } from './code-decomposer.ts';
import type { StoreReadBudget } from './store.ts';
import type { RecallQuery } from './retrieval.ts';
type Excerpt={spanId:string;artifactId:string;byteStart:number;byteEnd:number;text:string};
export interface EvidenceCandidate { sourceId:string; text:string; spanIds:string[]; artifactIds:string[]; matchedFacetIds:string[]; supportGroupIds:string[]; reasons:any[]; trace:any; utility:number; derivedNodeIds?:string[]; claimSignatures?:string[]; derivedText?:string; excerpts?:Excerpt[]; supportRequirements?:Record<string,string[]> }
export function renderExcerpts(excerpts:Excerpt[]):string {
 const sorted=[...excerpts].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.byteStart-b.byteStart||b.byteEnd-a.byteEnd);let text='',prev:Excerpt|undefined;
 for(const c of sorted){if(prev&&c.artifactId===prev.artifactId&&c.byteEnd<=prev.byteEnd)continue;const overlap=prev&&c.artifactId===prev.artifactId?Math.max(0,prev.byteEnd-c.byteStart):0;const part=Buffer.from(c.text).subarray(overlap).toString('utf8');text+=(prev&&!(c.artifactId===prev.artifactId&&c.byteStart<=prev.byteEnd)?'\n[noncontiguous excerpt]\n':'')+part;prev=c;}
 return text;
}
function bind(c:EvidenceCandidate,excerpts:Excerpt[]):EvidenceCandidate {c.excerpts=[...new Map(excerpts.map(e=>[e.spanId,e])).values()];c.excerpts.sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.byteStart-b.byteStart||a.byteEnd-b.byteEnd);c.text=renderExcerpts(c.excerpts);c.spanIds=c.excerpts.map(e=>e.spanId);c.artifactIds=[...new Set(c.excerpts.map(e=>e.artifactId))];return c;}
export function buildEvidenceWindow(store:ContextForgeStore,sourceId:string,recall:RecallQuery,spanIds:string[]=[],namespaceId=store.namespaceId,deadlineAt=Infinity,budget?:StoreReadBudget):EvidenceCandidate|null {
 const source=store.getSource(sourceId);if(!source||source.namespaceId!==namespaceId||source.status!=='active')return null;
 const chunks=store.getEvidenceChunks(sourceId,{namespaceId,deadlineAt,budget,maxInspected:8192,maxBytes:2*1024*1024});
 let required:ReturnType<ContextForgeStore['readEvidenceSpan']>[];try{required=spanIds.map(id=>store.readEvidenceSpan(id,{namespaceId,budget,deadlineAt})).filter(p=>p.sourceId===sourceId);}catch{return null;}
 if(!chunks.length&&!required.length)return null;
 const full=chunks.map(c=>c.text).join(''),small=estimateTokens(full)<=2048;
 let chosen=chunks;
 if(!small){
  const indexes=new Set<number>([0,chunks.length-1]);
  const ranked=chunks.map((c,i)=>({
   i,
   s:scoreFacetCoverage(recall,c.text).gain
    +recall.facets.filter(f=>f.origin==='question'&&(f.kind==='identifier'||f.kind==='number')&&f.surface.length>=2&&c.text.includes(f.surface)).length*12
    +(/\b(anomal\w*|exception|reject\w*|unchanged|only|no other|must not|never)\b/i.test(c.text)?3:0)
  })).sort((a,b)=>b.s-a.s||a.i-b.i);
  const grammar=getLanguageGrammar(source.originKey);
  if(grammar){
   const coveredWindowFacets=new Set<string>();
   let totalChars=chunks[0].text.length+(chunks.length>1?chunks[chunks.length-1].text.length:0);
   // 1. Greedily include top-scoring line chunks (plus +/-2 adjacent lines for code/context)
   // and any chunk that covers a previously uncovered query facet, up to ~4,800 chars (~1,350 tokens).
   for(const {i,s} of ranked){
    if(s<=0)break;
    const m=scoreFacetCoverage(recall,chunks[i].text).matchedFacetIds;
    const addsNewFacet=m.some(f=>!coveredWindowFacets.has(f));
    if((indexes.size<36||addsNewFacet)&&totalChars<4800){
     for(let j=Math.max(0,i-2);j<=Math.min(chunks.length-1,i+2);j++){
      if(!indexes.has(j)&&totalChars+chunks[j].text.length<=5200){indexes.add(j);totalChars+=chunks[j].text.length;}
     }
     m.forEach(f=>coveredWindowFacets.add(f));
    }
   }
   // 2. AST-Block Expansion & Hierarchical Symbol-Path Selection:
   // After all high-specificity line/facet hits are secured, use the remaining window budget (up to ~7,500 chars)
   // to (a) expand top matched line chunks to complete enclosing AST blocks (`class`/`def`/`function`), and
   // (b) pull in high-scoring AST blocks whose hierarchical `symbolPath` + body match the query (e.g. `AlterField::reduce`)!
   if(totalChars<7200&&chunks.length>1&&chunks[chunks.length-1].byteEnd===Buffer.byteLength(full)){
    try{
     const tree=decomposeCodeSource(full,{originKey:source.originKey,grammarId:grammar.id,maxBlockBytes:2400});
     const matchedByteOffsets=ranked.slice(0,4).map(r=>chunks[r.i].byteStart);
     for(const offset of matchedByteOffsets){
      const enclosing=tree.flatNodes
       .filter(n=>n.depth>=1&&n.byteStart<=offset&&n.byteEnd>offset&&(n.byteEnd-n.byteStart)<=1600)
       .sort((a,b)=>(a.byteEnd-a.byteStart)-(b.byteEnd-b.byteStart))[0];
      if(enclosing){
       const blockIdxs=chunks.map((c,idx)=>({c,idx})).filter(({c})=>c.byteStart>=enclosing.byteStart&&c.byteEnd<=enclosing.byteEnd).map(x=>x.idx);
       const addedChars=blockIdxs.filter(idx=>!indexes.has(idx)).reduce((n,idx)=>n+chunks[idx].text.length,0);
       if(addedChars>0&&totalChars+addedChars<=7500){
        blockIdxs.forEach(idx=>indexes.add(idx));
        totalChars+=addedChars;
       }
      }
     }
     const candidateNodes=tree.flatNodes
      .filter(n=>n.depth>=1&&(n.byteEnd-n.byteStart)>=32&&(n.byteEnd-n.byteStart)<=3000)
      .map(n=>{
       const nodeText=Buffer.from(full).subarray(n.byteStart,n.byteEnd).toString('utf8');
       const pathBonus=recall.facets.filter(f=>f.origin==='question'&&f.surface.length>=3&&n.symbolPath.toLowerCase().includes(f.surface.toLowerCase())).reduce((acc,f)=>acc+f.weight*4,0);
       const cov=scoreFacetCoverage(recall,`${n.symbolPath}\n${nodeText}`);
       return {n,score:cov.gain+pathBonus};
      })
      .filter(x=>x.score>0)
      .sort((a,b)=>b.score-a.score||(a.n.byteEnd-a.n.byteStart)-(b.n.byteEnd-b.n.byteStart));
     for(const cand of candidateNodes.slice(0,3)){
      const blockIdxs=chunks.map((c,idx)=>({c,idx})).filter(({c})=>c.byteStart>=cand.n.byteStart&&c.byteEnd<=cand.n.byteEnd).map(x=>x.idx);
      const addedChars=blockIdxs.filter(idx=>!indexes.has(idx)).reduce((n,idx)=>n+chunks[idx].text.length,0);
      if(addedChars>0&&totalChars+addedChars<=7500){
       blockIdxs.forEach(idx=>indexes.add(idx));
       totalChars+=addedChars;
      }
     }
    }catch{/* fallback to line-window if custom grammar throws */}
   }
  } else {
   for(const {i,s} of ranked.slice(0,3))if(s>0)for(const j of [i])if(j>=0&&j<chunks.length)indexes.add(j);
  }
  chosen=chunks.filter((_,i)=>indexes.has(i));
 }
 // Oversized legacy chunks receive an exact UTF-8 bounded window, not a fictional whole-line quote.
 const excerpts:Excerpt[]=chosen.map(c=>{if(Buffer.byteLength(c.text)<=8192)return c;const bytes=Buffer.from(c.text),lower=c.text.toLowerCase();const term=recall.facets.flatMap(f=>f.aliases).find(a=>lower.includes(a));const at=term?Buffer.byteLength(c.text.slice(0,lower.indexOf(term))):0;let start=Math.max(0,at-2048),end=Math.min(bytes.length,start+8192);while(start>0&&(bytes[start]&0xc0)===0x80)start--;while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end++;const spanId=store.createSpan(sourceId,c.artifactId,c.byteStart+start,c.byteStart+end);return {...c,spanId,byteStart:c.byteStart+start,byteEnd:c.byteStart+end,text:bytes.subarray(start,end).toString('utf8')};});
 const score=scoreFacetCoverage(recall,full+' '+required.map(p=>p.text).join(' '));
 return bind({sourceId,text:'',spanIds:[],artifactIds:[],matchedFacetIds:score.matchedFacetIds,supportGroupIds:[],reasons:['lexical_match'],trace:{sourceRevision:source.originRevision,sourceStatus:source.status,trustClass:source.trustClass,...(chunks.truncated?{truncated:true}:{})},utility:score.score},[...excerpts,...required]);
}
function claimSignatures(recall:RecallQuery,text:string):string[] {
 return text.split(/(?<=[.!?])\s+|\n/u).filter(t=>{const s=scoreFacetCoverage(recall,t);return s.anchored&&s.score>0||/\b(except|unless|only|not|never|unchanged|reject|contradict|must|cannot|if|without)\b/i.test(t);}).map(t=>{const normalized=t.normalize('NFKC').trim().replace(/\s+/g,' ');const claim=/^(?:Fact|State|Decision|Correction):\s*([^|]+)\|\s*([^=]+)=\s*(.+)$/i.exec(normalized);if(claim)return JSON.stringify(claim.slice(1).map(s=>s.trim()));try{const v=JSON.parse(normalized);if(v.type==='fact')return JSON.stringify([v.entity,v.predicate,v.object,v.polarity??1]);}catch{}return normalized;}).sort();
}
const historical=(q:RecallQuery)=>/\b(history|historical|previous|prior|old|changed?|changes|compare|comparison|diff|versus|vs|before|original|initial|supersed\w*|release\s+1|v1)\b/i.test(q.original);
export function hydrateProvenanceSupport(store:ContextForgeStore,nodeId:string,recall:RecallQuery,namespaceId=store.namespaceId,windowCache?:Map<string,EvidenceCandidate|null>,deadlineAt=Infinity,budget?:StoreReadBudget):EvidenceCandidate[] {
 const spanCache=new Map<string,ReturnType<ContextForgeStore['readEvidenceSpan']>>();const readSupport=(id:string)=>{let p=spanCache.get(id);if(!p){p=store.readEvidenceSpan(id,{namespaceId,budget,deadlineAt});spanCache.set(id,p);}return p;};
 const row=store.db.prepare("SELECT * FROM derived_nodes WHERE node_id=? AND namespace_id=? AND status<>'withdrawn'").get(nodeId,namespaceId);if(!row)return [];
 const canonical=JSON.parse(String(row.canonical_json)),provenance=store.getProvenance(nodeId);
 if(row.status==='superseded'&&!historical(recall))return [];
 const entries=Array.isArray(canonical.entries)?canonical.entries:[];
 const matched=entries.filter((e:any)=>{const s=scoreFacetCoverage(recall,String(e.text));return s.score>0&&s.anchored;}).sort((a:any,b:any)=>scoreFacetCoverage(recall,String(b.text)).gain-scoreFacetCoverage(recall,String(a.text)).gain||String(a.entryId).localeCompare(String(b.entryId)));
 if(entries.length&&!matched.length)return [];
 const allowed=new Set(provenance.map(p=>p.spanId)),result:EvidenceCandidate[]=[];
 const perSource=new Map<string,{count:number;chars:number}>();let truncated=false;
 // Routing entries are alternatives, not one omnibus premise. Each entry's
 // own multi-source support remains indivisible, including table qualifiers.
 const units=entries.length?matched:[{spanIds:provenance.map(p=>p.spanId),text:row.body}];
 for(const entry of units){
  if(Date.now()>=deadlineAt){truncated=true;break;}
  const selectedSpans=[...new Set(entry.spanIds??[])] as string[];if(selectedSpans.some(s=>!allowed.has(s)))continue;
  const bySource=new Map<string,string[]>();let reject=false;
  for(const id of selectedSpans){try{const p=readSupport(id);const spans=bySource.get(p.sourceId)??[];spans.push(id);bySource.set(p.sourceId,spans);}catch{reject=true;truncated=true;break;}}
  if(reject)continue;
  if(entries.length)for(const [id,spans] of bySource){const used=perSource.get(id)??{count:0,chars:0};const chars=spans.reduce((n,s)=>n+readSupport(s).text.length,0);if(used.count>=4||used.chars+chars>8192&&used.count>0){reject=true;truncated=true;break;}}
  if(reject)continue;
  const group=stableId('cf-support-group-v2',nodeId,[...selectedSpans].sort());
  for(const [sourceId,spans] of bySource){
   if(windowCache&&!windowCache.has(sourceId))windowCache.set(sourceId,buildEvidenceWindow(store,sourceId,recall,[],namespaceId,deadlineAt,budget));
   const base=windowCache?.get(sourceId)??buildEvidenceWindow(store,sourceId,recall,[],namespaceId,deadlineAt,budget);if(!base)continue;
   const required=spans.map(id=>readSupport(id));
   // A small alternate representation can include adjacent punctuation/context;
   // retain the exact required subspan binding as well as that real excerpt.
   const alternateContext=required.flatMap(p=>{if(base.artifactIds.includes(p.artifactId))return [];const a=store.db.prepare('SELECT b.byte_length FROM artifacts a JOIN blobs b ON b.sha256=a.blob_sha256 WHERE a.artifact_id=?').get(p.artifactId);if(!a||Number(a.byte_length)>4096)return [];const id=store.createSpan(sourceId,p.artifactId,0,Number(a.byte_length));try{return [readSupport(id)];}catch{truncated=true;return [];}});
   const c=bind({...base,trace:{...base.trace},supportGroupIds:[group],reasons:['provenance_support'],supportRequirements:{[group]:selectedSpans},derivedNodeIds:[nodeId]},[...(base.excerpts??[]),...required,...alternateContext]);
   if(Number(row.layer)===1)c.derivedText=`[${row.status}] revision ${row.revision}: ${row.body}`;
   c.claimSignatures=claimSignatures(recall,String(entry.text));
   c.trace={...c.trace,seedNodeId:nodeId,nodeStatus:row.status,...(entry.entryId?{entryId:entry.entryId}:{})};result.push(c);
   const used=perSource.get(sourceId)??{count:0,chars:0};used.count++;used.chars+=required.reduce((n,p)=>n+p.text.length,0);perSource.set(sourceId,used);
  }
 }
 if(truncated)for(const c of result)c.trace={...c.trace,truncated:true};
 return result;
}
export function expandRelatedPremises(store:ContextForgeStore,seedIds:string[],recall:RecallQuery,namespaceId=store.namespaceId,deadlineAt=Infinity,budget?:StoreReadBudget) {
 const related=store.getRelatedNodes(seedIds,{namespaceId,limit:64,maxInspected:Math.min(256,budget?budget.maxInspected-budget.inspected:256),includeSuperseded:historical(recall),deadlineAt} as any);
 if(budget)budget.inspected+=(related as any).inspected??related.length;
 const entryAllows=(r:any)=>{const seed=store.db.prepare('SELECT canonical_json,layer FROM derived_nodes WHERE node_id=? AND namespace_id=?').get(r.seedNodeId,namespaceId);if(!seed||seed.layer!==2)return true;const entries=JSON.parse(String(seed.canonical_json)).entries;if(!Array.isArray(entries))return scoreFacetCoverage(recall,r.node.title+' '+r.node.body).anchored;return entries.some((e:any)=>scoreFacetCoverage(recall,String(e.text)).anchored&&scoreFacetCoverage(recall,String(e.text)).score>0&&(e.dependencyNodeIds??[]).includes(r.node.nodeId));};
 const result=related.filter(r=>r.relation==='shared_key'||entryAllows(r)).filter(r=>r.direction==='incoming'&&['compiles','depends_on'].includes(r.relation)||r.relation==='contradicts'||r.relation==='supersedes'&&historical(recall)||scoreFacetCoverage(recall,r.node.title+' '+r.node.body).anchored&&scoreFacetCoverage(recall,r.node.title+' '+r.node.body).score>0);
 return Object.assign(result,{inspected:(related as any).inspected??related.length,truncated:(related as any).truncated??false});
}

/**
 * Multi-Clue Triangulation Across Up to `maxHops` (Default `3` Hops):
 * Given `>= 2` distinct query clue anchors (or seed nodes/excerpts), expands up to `maxHops`
 * through the L1/L2 derivation & shared-entity graph (`compiles`, `depends_on`, `contradicts`,
 * `supersedes`, `shared_key`) and scores intermediate/bridge nodes by how many distinct
 * clue frontiers converge on them (`clueCount >= 2` triangulation bonus, decayed by `0.65^hop`).
 * Single-clue fan-out beyond hop 1 is suppressed unless the node bridges `>= 2` distinct clues!
 */
export function triangulateMultiClueGraph(
 store:ContextForgeStore,
 seedNodesByClue:Map<string,string[]>,
 recall:RecallQuery,
 options:{namespaceId?:string;maxHops?:number;deadlineAt?:number;budget?:StoreReadBudget}={}
):Array<{nodeId:string;convergedClues:string[];minHop:number;triangulationScore:number}> {
 const ns=options.namespaceId??store.namespaceId;
 const maxHops=Math.max(1,Math.min(options.maxHops??3,4));
 const deadlineAt=options.deadlineAt??Infinity;
 const budget=options.budget;
 if(seedNodesByClue.size<2||Date.now()>=deadlineAt)return [];

 // Track `nodeId -> Map<clueId, hopDistance>`
 const reached=new Map<string,Map<string,number>>();
 const seedSet=new Set<string>();
 let frontier=new Map<string,Set<string>>(); // nodeId -> Set<clueId>

 for(const [clueId,nodeIds] of seedNodesByClue.entries()){
  for(const nid of nodeIds){
   seedSet.add(nid);
   let m=reached.get(nid);if(!m){m=new Map();reached.set(nid,m);}
   m.set(clueId,0);
   let f=frontier.get(nid);if(!f){f=new Set();frontier.set(nid,f);}
   f.add(clueId);
  }
 }

 for(let hop=1;hop<=maxHops;hop++){
  if(Date.now()>=deadlineAt||frontier.size===0)break;
  const currentIds=[...frontier.keys()].slice(0,24);
  const rel=store.getRelatedNodes(currentIds,{
   namespaceId:ns,
   limit:48,
   maxInspected:Math.min(128,budget?budget.maxInspected-budget.inspected:128),
   includeSuperseded:historical(recall),
   deadlineAt,
  } as any);
  if(budget)budget.inspected+=(rel as any).inspected??rel.length;
  const nextFrontier=new Map<string,Set<string>>();
  for(const edge of rel){
   const targetId=edge.node.nodeId;
   const parentClues=frontier.get(edge.seedNodeId);
   if(!parentClues)continue;
   let m=reached.get(targetId);
   if(!m){m=new Map();reached.set(targetId,m);}
   for(const cId of parentClues){
    if(!m.has(cId)){
     m.set(cId,hop);
     let nf=nextFrontier.get(targetId);if(!nf){nf=new Set();nextFrontier.set(targetId,nf);}
     nf.add(cId);
    }
   }
  }
  frontier=nextFrontier;
 }

 const bridges:Array<{nodeId:string;convergedClues:string[];minHop:number;triangulationScore:number}>=[];
 for(const [nodeId,clueMap] of reached.entries()){
  if(seedSet.has(nodeId)||clueMap.size<2)continue;
  let score=0,minHop=Infinity;
  for(const h of clueMap.values()){
   if(h<minHop)minHop=h;
   score+=Math.pow(0.65,h);
  }
  // Super-linear convergence multiplier when `>= 2` independent clues intersect!
  const triangulationScore=score*clueMap.size;
  bridges.push({nodeId,convergedClues:[...clueMap.keys()],minHop,triangulationScore});
 }
 return bridges.sort((a,b)=>b.triangulationScore-a.triangulationScore||a.minHop-b.minHop||a.nodeId.localeCompare(b.nodeId)).slice(0,12);
}

/**
 * Compile a compact, source-backed Chronological State Evolution Ledger when an entity or
 * logical key undergoes multiple revisions/supersessions (`A -> B -> A -> C`, e.g. court cases
 * or iterative requirement flip-flops).
 */
export function buildTemporalStateLedger(
 store:ContextForgeStore,
 candidateSourceIds:string[],
 recall:RecallQuery,
 namespaceId=store.namespaceId
):Array<{logicalKey:string;entity:string;ledgerText:string;spanIds:string[];sourceIds:string[]}> {
 if(candidateSourceIds.length===0)return [];
 const placeholders=candidateSourceIds.map(()=>'?').join(',');
 const rows=store.db.prepare(`
  SELECT DISTINCT n.logical_key
  FROM derived_nodes n
  JOIN provenance p USING(node_id)
  JOIN spans sp USING(span_id)
  WHERE n.namespace_id=? AND n.layer=1 AND n.status<>'withdrawn'
    AND sp.source_id IN (${placeholders})
 `).all(namespaceId,...candidateSourceIds) as Array<{logical_key:string}>;

 const ledgers:Array<{logicalKey:string;entity:string;ledgerText:string;spanIds:string[];sourceIds:string[]}>=[];
 for(const {logical_key} of rows){
  const chain=store.db.prepare(`
   SELECT node_id,revision,status,observed_at,title,body,canonical_json
   FROM derived_nodes
   WHERE namespace_id=? AND layer=1 AND logical_key=? AND status<>'withdrawn'
   ORDER BY observed_at ASC, revision ASC
  `).all(namespaceId,logical_key) as any[];
  if(chain.length<2)continue;
  // Only emit a full chronological ledger when the query asks about history/evolution
  // OR when there are >=3 flip-flop revisions (e.g. A -> B -> A/C).
  if(!historical(recall)&&chain.length<3)continue;
  const allSpans:string[]=[];
  const allSources=new Set<string>();
  const steps:string[]=[];
  for(const item of chain){
   const prov=store.getProvenance(String(item.node_id));
   const spIds=prov.map(p=>p.spanId);
   prov.forEach(p=>allSources.add(p.sourceId));
   allSpans.push(...spIds);
   const shortTag=spIds[0]?`[span:${store.formatShortSpanId(spIds[0],namespaceId)} / ${spIds[0]}]`:'';
   steps.push(`  ${item.revision}. [t=${item.observed_at}, status=${item.status}] ${String(item.body).trim()} ${shortTag}`.trimEnd());
  }
  const entity= (() => { try { return JSON.parse(String(chain[0].canonical_json)).entity ?? logical_key; } catch { return logical_key; } })();
  ledgers.push({
   logicalKey:logical_key,
   entity:String(entity),
   ledgerText:`Chronological State Evolution Ledger (${entity}, ${chain.length} ordered revisions):\n${steps.join('\n')}`,
   spanIds:[...new Set(allSpans)],
   sourceIds:[...allSources],
  });
 }
 return ledgers;
}
export function discoverEvidenceCandidates(store:ContextForgeStore,query:string,namespaceId=store.namespaceId,deadlineAt=Infinity):{candidates:EvidenceCandidate[];work:Record<string,number>;truncated:boolean;redundantSourceIds?:string[]} {
 const recall=analyzeRecallQuery(query);if(!recall.substantiveTerms.length)return {candidates:[],work:{seeds:0,chunks:0,neighbors:0},truncated:false};
 const budget=createStoreReadBudget({maxInspected:8192,maxBytes:8*1024*1024,deadlineAt});
 const raw=store.search(query,{namespaceId,layers:[0],limit:128,deadlineAt,budget});
 let inspectedChunks=raw.inspected??raw.length,statisticsInspected=raw.statisticsInspected??0,continuationTruncated=false;
 // Continue each uncovered substantive facet independently; repeating the
 // anchor in an OR query would let frequent facets starve the same rare row.
 const covered=new Set(raw.filter(h=>scoreFacetCoverage(recall,h.title+' '+h.body).anchored).flatMap(h=>scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds));
 let facetQueries=0;
 for(const facet of recall.facets){if(facet.origin!=='question'||covered.has(facet.id))continue;if(Date.now()>=deadlineAt||facetQueries>=8){continuationTruncated=true;break;}facetQueries++;
  const extra=store.search(facet.surface,{namespaceId,layers:[0],limit:256,maxInspected:256,deadlineAt,budget});inspectedChunks+=extra.inspected??extra.length;statisticsInspected+=extra.statisticsInspected??0;continuationTruncated ||= extra.truncated??false;
  for(const h of extra)if(scoreFacetCoverage(recall,h.title+' '+h.body).anchored&&!raw.some(r=>r.chunkId===h.chunkId)){raw.push(h);scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds.forEach(f=>covered.add(f));}
 }
 // A bounded first page may be saturated by a prior bulk attachment. Continue
 // the original query by rowid after rare-facet continuation; a
 // shared word in old telemetry does not establish a later causal premise.
 let rawCursor=raw.nextRowid??0,rawPages=0,continuedInspected=0,continuedStatistics=0;
 while(raw.truncated&&rawPages<3&&Date.now()<deadlineAt&&budget.inspected<budget.maxInspected&&budget.bytes<budget.maxBytes){
  const page=store.search(query,{namespaceId,layers:[0],limit:128,afterRowid:rawCursor,deadlineAt,budget,maxInspected:256});rawPages++;continuedInspected+=page.inspected??page.length;continuedStatistics+=page.statisticsInspected??0;
  if((page.nextRowid??rawCursor)<=rawCursor)break;rawCursor=page.nextRowid;
  for(const h of page)if(!raw.some(r=>r.chunkId===h.chunkId))raw.push(h);
  if(!page.truncated)break;
 }
 inspectedChunks += continuedInspected;
 statisticsInspected = statisticsInspected + continuedStatistics;

 const nodes=Date.now()<deadlineAt?store.search(query,{namespaceId,layers:[1,2],limit:64,deadlineAt,budget}):Object.assign([],{truncated:true,inspected:0,statisticsInspected:0});statisticsInspected+=nodes.statisticsInspected??0;
 const out=new Map<string,EvidenceCandidate>(),windowCache=new Map<string,EvidenceCandidate|null>();
 const merge=(c:EvidenceCandidate)=>{const prev=out.get(c.sourceId);if(prev&&c.derivedText===undefined&&c.trace?.seedNodeId){const union=[...new Map([...(prev.excerpts??[]),...(c.excerpts??[])].map(e=>[e.spanId,e])).values()];if(renderExcerpts(union).length>12288){prev.trace={...prev.trace,truncated:true};return;}}if(!prev)out.set(c.sourceId,c);else{prev.derivedNodeIds=[...new Set([...(prev.derivedNodeIds??[]),...(c.derivedNodeIds??[])])];prev.claimSignatures=[...new Set([...(prev.claimSignatures??[]),...(c.claimSignatures??[])])];bind(prev,[...(prev.excerpts??[]),...(c.excerpts??[])]);if(c.derivedText&&!prev.derivedText?.includes(c.derivedText))prev.derivedText=(prev.derivedText?prev.derivedText+'\n':'')+c.derivedText;prev.reasons=[...new Set([...prev.reasons,...c.reasons])];prev.trace={...prev.trace,...c.trace};prev.supportRequirements={...prev.supportRequirements,...c.supportRequirements};prev.supportGroupIds=[...new Set([...prev.supportGroupIds,...c.supportGroupIds])];prev.matchedFacetIds=[...new Set([...prev.matchedFacetIds,...c.matchedFacetIds])];}};
 for(const hit of raw){if(Date.now()>=deadlineAt)break;if(!hit.sourceId||!scoreFacetCoverage(recall,hit.title+' '+hit.body).anchored)continue;if(!windowCache.has(hit.sourceId))windowCache.set(hit.sourceId,buildEvidenceWindow(store,hit.sourceId,recall,hit.spanId?[hit.spanId]:[],namespaceId,deadlineAt,budget));const c=windowCache.get(hit.sourceId);if(c&&scoreFacetCoverage(recall,c.text).anchored&&c.utility>0)merge({...c,trace:{...c.trace}});}
 const eligible=nodes.filter(h=>!h.logicalKey?.startsWith('wiki/timeline/')&&h.title!=='record'&&scoreFacetCoverage(recall,h.title+' '+h.body).anchored&&scoreFacetCoverage(recall,h.title+' '+h.body).score>0);
 const seeds:typeof eligible=[],seedFacets=new Set<string>(),remaining=[...eligible];while(remaining.length&&seeds.length<16){remaining.sort((a,b)=>scoreFacetCoverage(recall,b.title+' '+b.body,seedFacets).gain-scoreFacetCoverage(recall,a.title+' '+a.body,seedFacets).gain||a.score-b.score||a.nodeId!.localeCompare(b.nodeId!));const h=remaining.shift()!;seeds.push(h);scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds.forEach(f=>seedFacets.add(f));}
 for(const h of seeds){if(Date.now()>=deadlineAt)break;for(const c of hydrateProvenanceSupport(store,h.nodeId!,recall,namespaceId,windowCache,deadlineAt,budget))merge(c);}
 const related=expandRelatedPremises(store,seeds.map(h=>h.nodeId!),recall,namespaceId,deadlineAt,budget);
 for(const r of related){if(Date.now()>=deadlineAt)break;for(const c of hydrateProvenanceSupport(store,r.node.nodeId,recall,namespaceId,windowCache,deadlineAt,budget)){c.reasons.push(r.relation==='contradicts'?'contradiction':'dependency');c.trace={...c.trace,relation:r.relation,direction:r.direction};merge(c);}}
 // Multi-Clue Triangulation (up to 3 hops):
 // When a query has >= 2 distinct substantive clues (`question` facets) that are NOT all
 // already covered in a single candidate source, expand up to 3 hops through the L1/L2
 // derivation graph to discover intermediate bridge nodes where >= 2 distinct clues converge!
 const questionFacets=recall.facets.filter(f=>f.origin==='question');
 const singleSourceCoversAll=questionFacets.length>0 && [...out.values()].some(c=>questionFacets.every(f=>c.matchedFacetIds.includes(f.id)));
 const seedNodesByClue=new Map<string,string[]>();
 if(!singleSourceCoversAll && questionFacets.length>=2){
  for(const h of seeds){
   const m=scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds;
   for(const fId of m){const arr=seedNodesByClue.get(fId)??[];if(!arr.includes(h.nodeId!))arr.push(h.nodeId!);seedNodesByClue.set(fId,arr);}
  }
 }
 if(seedNodesByClue.size>=2&&Date.now()<deadlineAt){
  const bridges=triangulateMultiClueGraph(store,seedNodesByClue,recall,{namespaceId,maxHops:3,deadlineAt,budget});
  for(const b of bridges){
   if(Date.now()>=deadlineAt)break;
   const row=store.db.prepare('SELECT title,body FROM derived_nodes WHERE node_id=? AND namespace_id=?').get(b.nodeId,namespaceId) as any;
   if(!row||!scoreFacetCoverage(recall,`${row.title} ${row.body}`).anchored)continue;
   for(const c of hydrateProvenanceSupport(store,b.nodeId,recall,namespaceId,windowCache,deadlineAt,budget)){
    c.reasons.push('triangulated_bridge');
    c.utility+=b.triangulationScore;
    c.trace={...c.trace,triangulatedClues:b.convergedClues,minHop:b.minHop,triangulationScore:b.triangulationScore};
    merge(c);
   }
  }
 }
 // Chronological State Evolution Ledger (for multi-revision flip-flops / court-case style timelines):
 if(out.size>0&&Date.now()<deadlineAt){
  const ledgers=buildTemporalStateLedger(store,[...out.keys()],recall,namespaceId);
  for(const l of ledgers){
   for(const srcId of l.sourceIds){
    const cand=out.get(srcId);
    if(cand&&!cand.derivedText?.includes(l.ledgerText)){
     cand.derivedText=(cand.derivedText?cand.derivedText+'\n':'')+l.ledgerText;
    }
   }
  }
 }
 for(const c of out.values())c.claimSignatures=claimSignatures(recall,c.text);
 const candidates=[...out.values()].sort((a,b)=>b.utility-a.utility||a.sourceId.localeCompare(b.sourceId));
 // Equivalent claims with irrelevant archive boilerplate are alternatives.
 // Never remove one member of a genuinely complementary multi-source group.
 const groupClaims=new Map<string,Set<string>>();for(const c of candidates)for(const g of c.supportGroupIds){const set=groupClaims.get(g)??new Set<string>();set.add(JSON.stringify(claimSignatures(recall,c.text)));groupClaims.set(g,set);}
 const redundantSourceIds:string[]=[];const seen=new Set<string>();const unique=candidates.filter(c=>{const signature=JSON.stringify(claimSignatures(recall,c.text));const key=signature==='[]'?c.text:signature;if(c.supportGroupIds.some(g=>(groupClaims.get(g)?.size??0)>1))return true;if(seen.has(key)){redundantSourceIds.push(c.sourceId);return false;}seen.add(key);return true;});
 const retainedSpans=new Set(unique.flatMap(c=>c.spanIds));for(const c of unique){c.supportGroupIds=c.supportGroupIds.filter(g=>(c.supportRequirements?.[g]??[]).every(s=>retainedSpans.has(s)));}

 return {candidates:unique,redundantSourceIds,work:{seeds:seeds.length,chunks:inspectedChunks,nodes:nodes.inspected??nodes.length,statistics:statisticsInspected,inspectedTotal:budget.inspected,readBytes:budget.bytes,facetQueries,neighbors:related.length,neighborsInspected:related.inspected,hydrated:out.size},truncated:budget.inspected>=budget.maxInspected||budget.bytes>=budget.maxBytes||raw.truncated||nodes.truncated||continuationTruncated||raw.length>=128||nodes.length===64||eligible.length>16||related.truncated||Date.now()>=deadlineAt||recall.truncated||unique.some(c=>c.trace?.truncated)};
}
