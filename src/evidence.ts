import { ContextForgeStore, stableId, createStoreReadBudget } from './store.ts';
import { analyzeRecallQuery, scoreFacetCoverage } from './retrieval.ts';
import { estimateTokens } from './symbolic-ir.ts';
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
 const chunks=store.getEvidenceChunks(sourceId,{namespaceId,deadlineAt,budget,maxInspected:512,maxBytes:1024*1024});
 let required:ReturnType<ContextForgeStore['readEvidenceSpan']>[];try{required=spanIds.map(id=>store.readEvidenceSpan(id,{namespaceId,budget,deadlineAt})).filter(p=>p.sourceId===sourceId);}catch{return null;}
 if(!chunks.length&&!required.length)return null;
 const full=chunks.map(c=>c.text).join(''),small=estimateTokens(full)<=2048;
 let chosen=chunks;
 if(!small){const indexes=new Set<number>([0,chunks.length-1]);const ranked=chunks.map((c,i)=>({i,s:scoreFacetCoverage(recall,c.text).gain+(/\b(anomal\w*|exception|reject\w*|unchanged|only|no other|must not|never)\b/i.test(c.text)?3:0)})).sort((a,b)=>b.s-a.s||a.i-b.i);for(const {i,s} of ranked.slice(0,3))if(s>0)for(const j of [i])if(j>=0&&j<chunks.length)indexes.add(j);chosen=chunks.filter((_,i)=>indexes.has(i));}
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
 const nodes=Date.now()<deadlineAt?store.search(query,{namespaceId,layers:[1,2],limit:64,deadlineAt,budget}):Object.assign([],{truncated:true,inspected:0,statisticsInspected:0});statisticsInspected+=nodes.statisticsInspected??0;
 const out=new Map<string,EvidenceCandidate>(),windowCache=new Map<string,EvidenceCandidate|null>();
 const merge=(c:EvidenceCandidate)=>{const prev=out.get(c.sourceId);if(prev&&c.derivedText===undefined&&c.trace?.seedNodeId){const union=[...new Map([...(prev.excerpts??[]),...(c.excerpts??[])].map(e=>[e.spanId,e])).values()];if(renderExcerpts(union).length>12288){prev.trace={...prev.trace,truncated:true};return;}}if(!prev)out.set(c.sourceId,c);else{prev.derivedNodeIds=[...new Set([...(prev.derivedNodeIds??[]),...(c.derivedNodeIds??[])])];prev.claimSignatures=[...new Set([...(prev.claimSignatures??[]),...(c.claimSignatures??[])])];bind(prev,[...(prev.excerpts??[]),...(c.excerpts??[])]);if(c.derivedText&&!prev.derivedText?.includes(c.derivedText))prev.derivedText=(prev.derivedText?prev.derivedText+'\n':'')+c.derivedText;prev.reasons=[...new Set([...prev.reasons,...c.reasons])];prev.trace={...prev.trace,...c.trace};prev.supportRequirements={...prev.supportRequirements,...c.supportRequirements};prev.supportGroupIds=[...new Set([...prev.supportGroupIds,...c.supportGroupIds])];prev.matchedFacetIds=[...new Set([...prev.matchedFacetIds,...c.matchedFacetIds])];}};
 for(const hit of raw){if(Date.now()>=deadlineAt)break;if(!hit.sourceId||!scoreFacetCoverage(recall,hit.title+' '+hit.body).anchored)continue;if(!windowCache.has(hit.sourceId))windowCache.set(hit.sourceId,buildEvidenceWindow(store,hit.sourceId,recall,hit.spanId?[hit.spanId]:[],namespaceId,deadlineAt,budget));const c=windowCache.get(hit.sourceId);if(c&&scoreFacetCoverage(recall,c.text).anchored&&c.utility>0)merge({...c,trace:{...c.trace}});}
 const eligible=nodes.filter(h=>!h.logicalKey?.startsWith('wiki/timeline/')&&h.title!=='record'&&scoreFacetCoverage(recall,h.title+' '+h.body).anchored&&scoreFacetCoverage(recall,h.title+' '+h.body).score>0);
 const seeds:typeof eligible=[],seedFacets=new Set<string>(),remaining=[...eligible];while(remaining.length&&seeds.length<16){remaining.sort((a,b)=>scoreFacetCoverage(recall,b.title+' '+b.body,seedFacets).gain-scoreFacetCoverage(recall,a.title+' '+a.body,seedFacets).gain||a.score-b.score||a.nodeId!.localeCompare(b.nodeId!));const h=remaining.shift()!;seeds.push(h);scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds.forEach(f=>seedFacets.add(f));}
 for(const h of seeds){if(Date.now()>=deadlineAt)break;for(const c of hydrateProvenanceSupport(store,h.nodeId!,recall,namespaceId,windowCache,deadlineAt,budget))merge(c);}
 const related=expandRelatedPremises(store,seeds.map(h=>h.nodeId!),recall,namespaceId,deadlineAt,budget);
 for(const r of related){if(Date.now()>=deadlineAt)break;for(const c of hydrateProvenanceSupport(store,r.node.nodeId,recall,namespaceId,windowCache,deadlineAt,budget)){c.reasons.push(r.relation==='contradicts'?'contradiction':'dependency');c.trace={...c.trace,relation:r.relation,direction:r.direction};merge(c);}}
 for(const c of out.values())c.claimSignatures=claimSignatures(recall,c.text);
 const candidates=[...out.values()].sort((a,b)=>b.utility-a.utility||a.sourceId.localeCompare(b.sourceId));
 // Equivalent claims with irrelevant archive boilerplate are alternatives.
 // Never remove one member of a genuinely complementary multi-source group.
 const groupClaims=new Map<string,Set<string>>();for(const c of candidates)for(const g of c.supportGroupIds){const set=groupClaims.get(g)??new Set<string>();set.add(JSON.stringify(claimSignatures(recall,c.text)));groupClaims.set(g,set);}
 const redundantSourceIds:string[]=[];const seen=new Set<string>();const unique=candidates.filter(c=>{const signature=JSON.stringify(claimSignatures(recall,c.text));const key=signature==='[]'?c.text:signature;if(c.supportGroupIds.some(g=>(groupClaims.get(g)?.size??0)>1))return true;if(seen.has(key)){redundantSourceIds.push(c.sourceId);return false;}seen.add(key);return true;});
 const retainedSpans=new Set(unique.flatMap(c=>c.spanIds));for(const c of unique){c.supportGroupIds=c.supportGroupIds.filter(g=>(c.supportRequirements?.[g]??[]).every(s=>retainedSpans.has(s)));}

 return {candidates:unique,redundantSourceIds,work:{seeds:seeds.length,chunks:inspectedChunks,nodes:nodes.inspected??nodes.length,statistics:statisticsInspected,inspectedTotal:budget.inspected,readBytes:budget.bytes,facetQueries,neighbors:related.length,neighborsInspected:related.inspected,hydrated:out.size},truncated:budget.inspected>=budget.maxInspected||budget.bytes>=budget.maxBytes||raw.truncated||nodes.truncated||continuationTruncated||raw.length>=128||nodes.length===64||eligible.length>16||related.truncated||Date.now()>=deadlineAt||recall.truncated||unique.some(c=>c.trace?.truncated)};
}
