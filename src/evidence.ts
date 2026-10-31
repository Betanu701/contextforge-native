import { getLanguageGrammar } from './code-decomposer.ts';
import { ContextForgeStore, stableId, createStoreReadBudget } from './store.ts';
import { analyzeRecallQuery, scoreFacetCoverage, resolveRetrievalWorkPolicy } from './retrieval.ts';
import { estimateTokens } from './symbolic-ir.ts';
import { structuralUnits, STRUCTURAL_BLOCK_BYTES, isOrientationDocument, boundedHeaderEnd } from './structure.ts';
import type { StoreReadBudget } from './store.ts';
import type { RecallQuery } from './retrieval.ts';
type Excerpt={spanId:string;artifactId:string;byteStart:number;byteEnd:number;text:string};
export interface EvidenceCandidate { sourceId:string; text:string; spanIds:string[]; artifactIds:string[]; matchedFacetIds:string[]; supportGroupIds:string[]; reasons:any[]; trace:any; utility:number; derivedNodeIds?:string[]; claimSignatures?:string[]; derivedText?:string; excerpts?:Excerpt[]; supportRequirements?:Record<string,string[]> }
export interface EvidenceWindowPolicy {maxAnchors:number;maxWindowBytes:number;maxSourceBytes:number;preferIndexedSeeds?:boolean}
const DEFAULT_WINDOW_POLICY:EvidenceWindowPolicy={maxAnchors:4,maxWindowBytes:8192,maxSourceBytes:12288};
/** Budget share, not a corpus-specific constant. Leave framing/metadata slack. */
export function resolveEvidenceWindowPolicy(historyTokens:number,sourceCount:number,maxReadBytes=64*1024*1024):EvidenceWindowPolicy {
 if(!Number.isFinite(historyTokens)||historyTokens<0||!Number.isSafeInteger(sourceCount)||sourceCount<0||!Number.isFinite(maxReadBytes)||maxReadBytes<0)throw new RangeError('Invalid evidence window resources');
 const sources=Math.max(1,sourceCount),tokens=Math.max(512,historyTokens);
 const share=Math.floor(tokens*3.6*0.85/Math.sqrt(sources));
 const maxSourceBytes=Math.min(Math.floor(maxReadBytes/2),Math.max(2048,Math.min(32768,share)));
 return {maxSourceBytes,maxWindowBytes:Math.min(maxSourceBytes,Math.max(2048,Math.floor(maxSourceBytes*0.85))),maxAnchors:Math.max(2,Math.min(12,Math.floor(maxSourceBytes/2048)))};
}
/** Greedy facet diversity prevents twelve lexical duplicates replacing twelve clues. */
export function selectEvidenceAnchors<T extends {spanId?:string;body?:string;text?:string;title?:string}>(hits:T[],recall:RecallQuery,limit:number):T[]{
 const pool=[...hits],selected:T[]=[],covered=new Set<string>();
 while(pool.length&&selected.length<limit){
  pool.sort((a,b)=>scoreFacetCoverage(recall,(b.title??'')+' '+(b.body??b.text??''),covered).gain-scoreFacetCoverage(recall,(a.title??'')+' '+(a.body??a.text??''),covered).gain||scoreFacetCoverage(recall,(b.title??'')+' '+(b.body??b.text??'')).score-scoreFacetCoverage(recall,(a.title??'')+' '+(a.body??a.text??'')).score);
  const hit=pool.shift()!;selected.push(hit);const text=(hit.title??'')+' '+(hit.body??hit.text??'');
  // Shared subtokens are partial support, not full satisfaction of distinct clues.
  for(const facet of recall.facets)if(scoreFacetCoverage({...recall,facets:[facet]},text).score>=0.9)covered.add(facet.id);
 }
 return selected;
}
/** Conservative rendering charge for optional windows: exact bytes plus local
 * attribution/citation framing. Byte-only packing can otherwise create a source
 * bundle larger than the physical history budget and admit nothing. */
function evidenceWindowCharge(excerpts:Excerpt[],policy:EvidenceWindowPolicy):number {
 const raw=Buffer.byteLength(renderExcerpts(excerpts));if(policy===DEFAULT_WINDOW_POLICY)return raw;
 let groups=0,lastEnd=-1,lastArtifact='';for(const e of [...excerpts].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.byteStart-b.byteStart||b.byteEnd-a.byteEnd)){if(e.artifactId!==lastArtifact||e.byteStart>lastEnd){groups++;lastEnd=e.byteEnd;lastArtifact=e.artifactId;}else lastEnd=Math.max(lastEnd,e.byteEnd);}
 return raw+groups*384+512;
}
function rangesCover(excerpts:Excerpt[],start:number,end:number,artifactId:string):boolean {
 let cursor=start;for(const e of [...excerpts].filter(e=>e.artifactId===artifactId).sort((a,b)=>a.byteStart-b.byteStart)){if(e.byteStart>cursor)break;if(e.byteEnd>cursor)cursor=e.byteEnd;if(cursor>=end)return true;}return cursor>=end;
}
function mergeEvidenceMetadata(target:EvidenceCandidate,extra:EvidenceCandidate):void {
 // Byte containment suppresses repeated display, never the immutable support
 // identities needed by group validation and companion-source obligations.
 bind(target,[...(target.excerpts??[]),...(extra.excerpts??[])]);
 target.supportGroupIds=[...new Set([...target.supportGroupIds,...extra.supportGroupIds])];
 target.supportRequirements={...target.supportRequirements,...extra.supportRequirements};
 target.reasons=[...new Set([...target.reasons,...extra.reasons])];target.matchedFacetIds=[...new Set([...target.matchedFacetIds,...extra.matchedFacetIds])];
 target.derivedNodeIds=[...new Set([...(target.derivedNodeIds??[]),...(extra.derivedNodeIds??[])])];target.claimSignatures=[...new Set([...(target.claimSignatures??[]),...(extra.claimSignatures??[])])];
 if(extra.derivedText&&!target.derivedText?.includes(extra.derivedText))target.derivedText=[target.derivedText,extra.derivedText].filter(Boolean).join('\n');
 target.trace={...target.trace,...extra.trace,documentStructuralRoute:!!(target.trace.documentStructuralRoute||extra.trace.documentStructuralRoute),semanticInterpretation:!!(target.trace.semanticInterpretation||extra.trace.semanticInterpretation),structuralUnits:uniqueStructuralTrace([...(target.trace.structuralUnits??[]),...(extra.trace.structuralUnits??[])])};target.utility=Math.max(target.utility,extra.utility);
}
export function renderExcerpts(excerpts:Excerpt[]):string {
 const sorted=[...excerpts].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.byteStart-b.byteStart||b.byteEnd-a.byteEnd);let text='',prev:Excerpt|undefined;
 for(const c of sorted){if(prev&&c.artifactId===prev.artifactId&&c.byteEnd<=prev.byteEnd)continue;const overlap=prev&&c.artifactId===prev.artifactId?Math.max(0,prev.byteEnd-c.byteStart):0;const part=Buffer.from(c.text).subarray(overlap).toString('utf8');text+=(prev&&!(c.artifactId===prev.artifactId&&c.byteStart<=prev.byteEnd)?'\n[noncontiguous excerpt]\n':'')+part;prev=c;}
 return text;
}
/** Render exact connected ranges with their attribution immediately adjacent.
 * Selection metadata stays outside quotation delimiters; c.text remains raw.
 */
export function renderAttributedEvidence(store:ContextForgeStore,c:EvidenceCandidate,recall:RecallQuery,namespaceId=store.namespaceId):string {
 const units=c.trace?.structuralUnits??[];
 if(!units.length||!c.excerpts?.length)return c.text;
 const groups:Excerpt[][]=[];
 for(const e of [...c.excerpts].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.byteStart-b.byteStart||b.byteEnd-a.byteEnd)){
  const last=groups.at(-1),end=last?Math.max(...last.map(x=>x.byteEnd)):-1;
  if(last&&last[0].artifactId===e.artifactId&&e.byteStart<=end)last.push(e);else groups.push([e]);
 }
 const rendered=groups.map(group=>{
  const start=Math.min(...group.map(e=>e.byteStart)),end=Math.max(...group.map(e=>e.byteEnd)),text=renderExcerpts(group);
  const overlapping=units.filter((u:any)=>(!u.artifactId||u.artifactId===group[0].artifactId)&&((u.byteStart<end&&u.byteEnd>start)||(u.headerByteStart<=start&&u.headerByteEnd>=end)));
  const unit=overlapping.filter((u:any)=>(u.byteStart<=start&&u.byteEnd>=end)||(u.headerByteStart<=start&&u.headerByteEnd>=end)).sort((a:any,b:any)=>(a.byteEnd-a.byteStart)-(b.byteEnd-b.byteStart))[0];
  // An overlapping unit is a local routing anchor, not the owner of bytes
  // outside its interval. List all verified paths when a group crosses units.
  const paths=[...new Set(overlapping.filter((u:any)=>u.pathVerified).map((u:any)=>String(u.originKey)))];
  const symbol=unit?.symbolPath;
  const name=[...(symbol?[symbol]:[]),...paths.filter(path=>!symbol?.includes(path))].join(' | ')||store.getSource(c.sourceId)?.originKey||c.sourceId;
  const label=`Evidence ${String(name).slice(0,240)}; bytes ${start}-${end}${unit?.kind==='part'?`; part-${unit.partIndex} of ${unit.totalParts}`:''}${unit?.headerComplete===false?'; header incomplete':''}`;
  // One exact connected-union citation covers every displayed byte. Keep
  // original support spans in the receipt as well as this rendering span.
  const citation=store.createEvidenceSpan(c.sourceId,group[0].artifactId,start,end,{namespaceId,maxBytes:end-start});
  if(!c.spanIds.includes(citation.spanId))c.spanIds.push(citation.spanId);
  const spans=`[span:${store.formatShortSpanId(citation.spanId,namespaceId)}]`;
  return {start,text:`${label} ${spans}\n<source_quote>\n${text}\n</source_quote>`,quality:scoreFacetCoverage(recall,text+' '+(unit?.symbolPath??'')).score};
 });
 // Keep temporal/source-order semantics when chronology is requested.
 if(!/\b(history|historical|previous|prior|changed?|compare|comparison|before|timeline|chronolog\w*)\b/i.test(recall.original))rendered.sort((a,b)=>a.quality-b.quality||a.start-b.start);
 return rendered.map(g=>g.text).join('\n\n');
}
/** Retain routing anchors not already expressed locally; never silently erase
 * a verified path just because a quote spans several structural units. */
export function remainingStructuralNavigation(c:EvidenceCandidate,quote:string):string|undefined {
 if(c.trace?.semanticInterpretation)return c.derivedText;
 const lines=(c.derivedText??'').split('\n').filter(line=>{
  const path=/^(?:Verified source path|Inferred source region): ([^;]+)/.exec(line)?.[1];
  const symbol=/; symbol ([^;]+)/.exec(line)?.[1];
  if(path||symbol)return !!(path&&!quote.includes(path)||symbol&&!quote.includes(symbol)||line.includes('partial structural evidence')&&!quote.includes('partial structural evidence')||line.includes('header incomplete')&&!quote.includes('header incomplete'));
  return /part-\d+ of \d+|header incomplete/.test(line)&&!quote.includes(line);
 });
 return [...new Set(lines)].join('\n').slice(0,STRUCTURAL_NAVIGATION_CHARS)||undefined;
}
function bind(c:EvidenceCandidate,excerpts:Excerpt[]):EvidenceCandidate {c.excerpts=[...new Map(excerpts.map(e=>[e.spanId,e])).values()];c.excerpts.sort((a,b)=>a.artifactId.localeCompare(b.artifactId)||a.byteStart-b.byteStart||a.byteEnd-b.byteEnd);c.text=renderExcerpts(c.excerpts);c.spanIds=c.excerpts.map(e=>e.spanId);c.artifactIds=[...new Set(c.excerpts.map(e=>e.artifactId))];return c;}
// Navigation is derived routing metadata, not evidence. Its independent bound
// prevents repeated anchors or long symbol names from consuming the quote budget.
export const STRUCTURAL_NAVIGATION_CHARS = 2048;
export function uniqueStructuralTrace(units:any[]):any[] {
 return [...new Map(units.map(u=>[`${u.artifactId??''}:${u.byteStart}:${u.byteEnd}:${u.partIndex??'whole'}`,u])).values()];
}
export function renderStructuralNavigation(units:any[],excerpts:Array<{byteStart:number;byteEnd:number}>=[]):string {
 const unique=uniqueStructuralTrace(units),lines:string[]=[],signatures=new Set<string>();let chars=0;
 const covers=(start:number,end:number)=>{let cursor=start;for(const e of [...excerpts].sort((a,b)=>a.byteStart-b.byteStart)){if(e.byteStart>cursor)break;if(e.byteEnd>cursor)cursor=e.byteEnd;if(cursor>=end)return true;}return cursor>=end;};
 for(const u of unique){
  if(!u.partIndex||u.parentByteStart!==undefined&&covers(u.parentByteStart,u.parentByteEnd))continue;
  const signatureKey=`${u.headerByteStart}:${u.headerByteEnd}`;
  const signature=signatures.has(signatureKey)?'':`; enclosing signature bytes ${signatureKey.replace(':','-')}${u.headerComplete===false?' (header incomplete; continues to byte '+u.fullHeaderByteEnd+')':''}`;
  const label=String(u.symbolPath??u.unitId).slice(0,256);
  const line=`${label}: part-${u.partIndex} of ${u.totalParts}; lines ${u.startLine}-${u.endLine}; previous=${u.previousPartId??'none'}; next=${u.nextPartId??'none'}${signature}`;
  if(chars+line.length+1>STRUCTURAL_NAVIGATION_CHARS)break;
  lines.push(line);chars+=line.length+1;signatures.add(signatureKey);
 }
 return lines.join('\n');
}
export function buildEvidenceWindow(store:ContextForgeStore,sourceId:string,recall:RecallQuery,spanIds:string[]=[],namespaceId=store.namespaceId,deadlineAt=Infinity,budget?:StoreReadBudget,windowPolicy:EvidenceWindowPolicy=DEFAULT_WINDOW_POLICY):EvidenceCandidate|null {
 const source=store.getSource(sourceId);if(!source||source.namespaceId!==namespaceId||source.status!=='active')return null;
 // Exact indexed search hits are hydrated BEFORE any optional source scan.
 let required:ReturnType<ContextForgeStore['readEvidenceSpan']>[];try{required=spanIds.map(id=>store.readEvidenceSpan(id,{namespaceId,budget,deadlineAt})).filter(p=>p.sourceId===sourceId);}catch{return null;}
 const sourceBytes=Number(store.db.prepare('SELECT byte_length FROM blobs WHERE sha256=?').get(source.contentSha256)?.byte_length??0);
 const cursorCode=!!recall.cursorContext&&!!getLanguageGrammar(source.originKey)&&getLanguageGrammar(source.originKey)?.id!=='markdown';
 if((sourceBytes>64*1024||cursorCode||windowPolicy.preferIndexedSeeds)&&required.length){
  const excerpts:Excerpt[]=[...required],trace:any[]=[];let incomplete=false;
  // Source-key prefix is indexed by the existing active logical-key index.
  // Range predicates operate in SQLite over persisted structural coordinates.
  let fallbackUnits:ReturnType<typeof structuralUnits>|undefined;
  let fallbackBytes:Buffer|undefined;
  for(const anchor of required.slice(0,windowPolicy.maxAnchors)){
   const prefix=`wiki/structure/${sourceId}/`;
   const rows=store.db.prepare(`SELECT canonical_json FROM derived_nodes WHERE namespace_id=? AND status='active' AND logical_key>=? AND logical_key<? AND json_extract(canonical_json,'$.entries[0].structural.kind') IN ('block','part','section','file') AND json_extract(canonical_json,'$.entries[0].structural.byteStart')<=? AND json_extract(canonical_json,'$.entries[0].structural.byteEnd')>=? ORDER BY json_extract(canonical_json,'$.entries[0].structural.byteEnd')-json_extract(canonical_json,'$.entries[0].structural.byteStart') LIMIT 4`).all(namespaceId,prefix,prefix+'~',anchor.byteStart,anchor.byteEnd);
   if(!rows.length&&getLanguageGrammar(source.originKey)&&sourceBytes<=256*1024&&Date.now()<deadlineAt){
    // Pre-compile fallback is deliberately bounded. Large compiled sources use
    // persisted indexes; unsupported huge raw files retain exact seed evidence.
    if(!fallbackUnits){try{const full=store.createEvidenceSpan(sourceId,anchor.artifactId,0,sourceBytes,{namespaceId,budget,deadlineAt});fallbackBytes=Buffer.from(full.text);fallbackUnits=structuralUnits(full.text,source.originKey);}catch{fallbackUnits=[];incomplete=true;}}
    const local=fallbackUnits.filter(u=>['block','part'].includes(u.kind)&&u.byteStart<=anchor.byteStart&&u.byteEnd>=anchor.byteEnd).sort((a,b)=>(a.byteEnd-a.byteStart)-(b.byteEnd-b.byteStart))[0];
    if(local&&fallbackBytes){
     const end=local.byteEnd-local.byteStart<=windowPolicy.maxWindowBytes?local.byteEnd:Math.min(local.byteEnd,anchor.byteEnd);
     const ranges:Array<[number,number]>=[[local.byteStart,end]];if(local.kind==='part'&&local.headerByteStart<local.byteStart)ranges.unshift([local.headerByteStart,boundedHeaderEnd(fallbackBytes,local.headerByteStart,local.headerByteEnd)]);
     const support:Excerpt[]=[];try{for(const [a,b] of ranges)support.push(store.createEvidenceSpan(sourceId,anchor.artifactId,a,b,{namespaceId,budget,deadlineAt}));const union=[...excerpts,...support];if(Buffer.byteLength(renderExcerpts(union))<=Math.max(windowPolicy.maxWindowBytes,Buffer.byteLength(renderExcerpts(required)))){excerpts.push(...support);trace.push({...local,artifactId:anchor.artifactId,whole:end===local.byteEnd,headerComplete:rangesCover(union,local.headerByteStart,local.headerByteEnd,anchor.artifactId)});}else incomplete=true;}catch{incomplete=true;}
    }
   }
   for(const row of rows){const entry=JSON.parse(String(row.canonical_json)).entries?.[0],u=entry?.structural;if(!u)continue;
    if(excerpts.reduce((n,e)=>n+e.byteEnd-e.byteStart,0)>=windowPolicy.maxWindowBytes){incomplete=true;break;}
    try{const support=(entry.spanIds??[]).map((id:string)=>store.readEvidenceSpan(id,{namespaceId,budget,deadlineAt}));
     const union=[...new Map([...excerpts,...support].map(e=>[e.spanId,e])).values()];
     const bound=Math.max(windowPolicy.maxWindowBytes,Buffer.byteLength(renderExcerpts(required)));
     if(evidenceWindowCharge(union,windowPolicy)>bound){incomplete=true;continue;}
     const covered=(start:number,end:number)=>{let cursor=start;for(const e of [...union].sort((a,b)=>a.byteStart-b.byteStart)){if(e.artifactId!==anchor.artifactId)continue;if(e.byteStart>cursor)break;if(e.byteEnd>cursor)cursor=e.byteEnd;if(cursor>=end)return true;}return cursor>=end;};
     const whole=covered(u.byteStart,u.byteEnd),headerComplete=covered(u.headerByteStart,u.headerByteEnd);
     excerpts.push(...support);trace.push({...u,whole,headerComplete,fullHeaderByteEnd:u.headerByteEnd});incomplete ||= !whole||u.kind==='part'||!headerComplete;break;
    }catch{incomplete=true;break;}
   }
  }
  const exact=[...new Map(excerpts.map(e=>[e.spanId,e])).values()];const text=renderExcerpts(exact),score=scoreFacetCoverage(recall,text);
  return bind({sourceId,text:'',spanIds:[],artifactIds:[],matchedFacetIds:score.matchedFacetIds,supportGroupIds:[],reasons:['lexical_match'],trace:{sourceRevision:source.originRevision,sourceStatus:source.status,trustClass:source.trustClass,structuralUnits:uniqueStructuralTrace(trace),indexedSeedHydration:true,...(incomplete?{truncated:true,structuralIncomplete:true}:{})},utility:score.score,...(trace.length?{derivedText:[renderStructuralNavigation(trace,exact),...uniqueStructuralTrace(trace).map(u=>`${u.pathVerified?'Verified source path':'Inferred source region'}: ${u.originKey}; symbol ${u.symbolPath}; original lines ${u.startLine}-${u.endLine}${!u.whole?'; partial structural evidence':''}`)].filter(Boolean).join('\n').slice(0,STRUCTURAL_NAVIGATION_CHARS)}:{})},exact);
 }
 const chunks=store.getEvidenceChunks(sourceId,{namespaceId,deadlineAt,budget,maxInspected:Math.min(4096,budget?budget.maxInspected-budget.inspected:4096),maxBytes:64*1024});
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
  if(isOrientationDocument(source.originKey)||/\.(?:py|pyw|ts|tsx|js|jsx|mjs|cjs|java|cs|go|rs|c|cc|cpp|h|hpp|sql|f90|cob|cbl|html|ejs)$/i.test(source.originKey)){
   // Structural expansion below is authoritative; do not pre-fill +/-2 cropped lines.
   indexes.clear();
   for(const {i,s} of ranked.slice(0,4))if(s>0)indexes.add(i);
  } else {
   for(const {i,s} of ranked.slice(0,3))if(s>0)for(const j of [i])if(j>=0&&j<chunks.length)indexes.add(j);
  }
  chosen=chunks.filter((_,i)=>indexes.has(i));
 }
 // Oversized legacy chunks receive an exact UTF-8 bounded window, not a fictional whole-line quote.
 const excerpts:Excerpt[]=chosen.map(c=>{if(Buffer.byteLength(c.text)<=8192)return c;const bytes=Buffer.from(c.text),lower=c.text.toLowerCase();const term=recall.facets.flatMap(f=>f.aliases).find(a=>lower.includes(a));const at=term?Buffer.byteLength(c.text.slice(0,lower.indexOf(term))):0;let start=Math.max(0,at-2048),end=Math.min(bytes.length,start+8192);while(start>0&&(bytes[start]&0xc0)===0x80)start--;while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end++;return store.createEvidenceSpan(sourceId,c.artifactId,c.byteStart+start,c.byteStart+end,{namespaceId,budget,deadlineAt});});
 // Hydrate exact whole units or linked parts using the same decomposition as compilation.
 const structuralTrace:any[]=[];let structuralIncomplete=false;
 const complete=!chunks.truncated&&chunks.length>0&&chunks[0].byteStart===0&&chunks.every((c,i)=>!i||c.artifactId===chunks[i-1].artifactId&&c.byteStart===chunks[i-1].byteEnd);
 let selectedExcerpts=excerpts;
 if(complete&&Date.now()<deadlineAt){
  const fullBytes=Buffer.from(full),units=structuralUnits(full,source.originKey),byId=new Map(units.map(u=>[u.unitId,u]));
  const artifactId=chunks[0].artifactId;
  const anchors=[...required.filter(p=>p.artifactId===artifactId),...chunks.map(c=>({...c,score:scoreFacetCoverage(recall,c.text).gain})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score).slice(0,8)];
  const expanded:Excerpt[]=[];let used=0;
  const addRanges=(ranges:Array<[number,number]>):'admitted'|'covered'|'rejected'=>{
   const pending=ranges.filter(([start,end],i)=>end>start&&!expanded.some(e=>e.byteStart<=start&&e.byteEnd>=end)&&!ranges.some(([a,b],j)=>j!==i&&a<=start&&b>=end&&(a<start||b>end||j<i)));
   if(!pending.length)return 'covered';
   const size=pending.reduce((n,[a,b])=>n+b-a,0);
   if(used+size>windowPolicy.maxWindowBytes||budget&&(size>budget.maxBytes-budget.bytes||pending.length>budget.maxInspected-budget.inspected)||Date.now()>=deadlineAt){structuralIncomplete=true;return 'rejected';}
   const staged:Excerpt[]=[];
   try{for(const [start,end] of pending)staged.push(store.createEvidenceSpan(sourceId,artifactId,start,end,{namespaceId,budget,deadlineAt}));}catch{structuralIncomplete=true;return 'rejected';}
   expanded.push(...staged);used+=size;return 'admitted';
  };
  for(const anchor of anchors){
   const enclosing=units.filter(u=>u.byteStart<=anchor.byteStart&&u.byteEnd>=anchor.byteEnd&&u.kind!=='part'&&u.kind!=='statement').sort((a,b)=>(a.byteEnd-a.byteStart)-(b.byteEnd-b.byteStart));
   // Anonymous control blocks are not enclosing function authority. Prefer named definitions.
   const symbols=enclosing.filter(u=>u.kind==='block'&&!/^(?:if|else|for|while|switch|try|catch|finally|do|block|body|statement)(?:$|[-#\s])/.test(u.symbolName));
   const authority=symbols[0]??enclosing[0];
   const whole=authority&&authority.byteEnd-authority.byteStart<=STRUCTURAL_BLOCK_BYTES?authority:undefined;
   if(whole){if(addRanges([[whole.byteStart,whole.byteEnd]])==='admitted')structuralTrace.push({artifactId,unitId:whole.unitId,symbolPath:whole.symbolPath,whole:true,byteStart:whole.byteStart,byteEnd:whole.byteEnd,startLine:whole.startLine,endLine:whole.endLine});continue;}
   const part=units.filter(u=>u.kind==='part'&&(!authority||u.parentId===authority.unitId)&&u.byteStart<=anchor.byteStart&&u.byteEnd>anchor.byteStart).sort((a,b)=>(a.byteEnd-a.byteStart)-(b.byteEnd-b.byteStart))[0];
   if(part){const parent=byId.get(part.parentId!);const headerStart=parent?.headerByteStart??part.headerByteStart,originalHeaderEnd=parent?.headerByteEnd??part.headerByteEnd;
    const headerEnd=boundedHeaderEnd(fullBytes,headerStart,originalHeaderEnd);
    if(addRanges([[part.byteStart,part.byteEnd],[headerStart,headerEnd]])==='admitted')structuralTrace.push({artifactId,unitId:part.unitId,symbolPath:parent?.symbolPath??part.symbolPath,parentByteStart:parent?.byteStart,parentByteEnd:parent?.byteEnd,partIndex:part.partIndex,totalParts:part.totalParts,previousPartId:part.previousPartId??null,nextPartId:part.nextPartId??null,headerByteStart:headerStart,headerByteEnd:headerEnd,headerComplete:headerEnd===originalHeaderEnd,fullHeaderByteEnd:originalHeaderEnd,byteStart:part.byteStart,byteEnd:part.byteEnd,startLine:part.startLine,endLine:part.endLine});
   }
  }
  if(expanded.length)selectedExcerpts=expanded;
 }
 const score=scoreFacetCoverage(recall,full+' '+required.map(p=>p.text).join(' '));
 const delivered=[...selectedExcerpts,...required];
 const uniqueTrace=uniqueStructuralTrace(structuralTrace);
 const navigation=renderStructuralNavigation(uniqueTrace,delivered);
 return bind({sourceId,text:'',spanIds:[],artifactIds:[],matchedFacetIds:score.matchedFacetIds,supportGroupIds:[],reasons:['lexical_match'],trace:{sourceRevision:source.originRevision,sourceStatus:source.status,trustClass:source.trustClass,...(uniqueTrace.length?{structuralUnits:uniqueTrace}:{}),...(chunks.truncated||structuralIncomplete?{truncated:true,structuralIncomplete}:{})},utility:score.score,...(navigation?{derivedText:navigation}: {})},delivered);
}
function claimSignatures(recall:RecallQuery,text:string):string[] {
 return text.split(/(?<=[.!?])\s+|\n/u).filter(t=>{const s=scoreFacetCoverage(recall,t);return s.anchored&&s.score>0||/\b(except|unless|only|not|never|unchanged|reject|contradict|must|cannot|if|without)\b/i.test(t);}).map(t=>{const normalized=t.normalize('NFKC').trim().replace(/\s+/g,' ');const claim=/^(?:Fact|State|Decision|Correction):\s*([^|]+)\|\s*([^=]+)=\s*(.+)$/i.exec(normalized);if(claim)return JSON.stringify(claim.slice(1).map(s=>s.trim()));try{const v=JSON.parse(normalized);if(v.type==='fact')return JSON.stringify([v.entity,v.predicate,v.object,v.polarity??1]);}catch{}return normalized;}).sort();
}
const historical=(q:RecallQuery)=>/\b(history|historical|previous|prior|old|changed?|changes|compare|comparison|diff|versus|vs|before|original|initial|supersed\w*|release\s+1|v1)\b/i.test(q.original);
export function hydrateProvenanceSupport(store:ContextForgeStore,nodeId:string,recall:RecallQuery,namespaceId=store.namespaceId,windowCache?:Map<string,EvidenceCandidate|null>,deadlineAt=Infinity,budget?:StoreReadBudget,windowPolicy:EvidenceWindowPolicy=DEFAULT_WINDOW_POLICY):EvidenceCandidate[] {
 const spanCache=new Map<string,ReturnType<ContextForgeStore['readEvidenceSpan']>>();const readSupport=(id:string)=>{let p=spanCache.get(id);if(!p){p=store.readEvidenceSpan(id,{namespaceId,budget,deadlineAt});spanCache.set(id,p);}return p;};
 const row=store.db.prepare("SELECT * FROM derived_nodes WHERE node_id=? AND namespace_id=? AND status<>'withdrawn'").get(nodeId,namespaceId);if(!row)return [];
 const canonical=JSON.parse(String(row.canonical_json)),provenance=store.getProvenance(nodeId);
 if(row.status==='superseded'&&!historical(recall))return [];
 const entries=Array.isArray(canonical.entries)?canonical.entries:[];
 const matched=entries.filter((e:any)=>{const s=scoreFacetCoverage(recall,String(e.text)+' '+(e.structural?.symbolPath??'')+' '+(e.structural?.subTokens??[]).join(' '));return s.score>0&&s.anchored;}).sort((a:any,b:any)=>scoreFacetCoverage(recall,String(b.text)).gain-scoreFacetCoverage(recall,String(a.text)).gain||String(a.entryId).localeCompare(String(b.entryId)));
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
  if(entries.length)for(const [id,spans] of bySource){const used=perSource.get(id)??{count:0,chars:0};const chars=spans.reduce((n,s)=>n+readSupport(s).text.length,0);if(used.count>=windowPolicy.maxAnchors||used.chars+chars>windowPolicy.maxWindowBytes&&used.count>0){reject=true;truncated=true;break;}}
  if(reject)continue;
  const group=stableId('cf-support-group-v2',nodeId,[...selectedSpans].sort());
  for(const [sourceId,spans] of bySource){
   // Persisted symbol/sub-token routes may match only a title, not the body. Seed
   // their exact support span so whole-unit hydration does not depend on lexical coincidence.
   const structuralSeed=entry.structural?spans:[];
   let base:EvidenceCandidate|null;
   const sourceGrammar=getLanguageGrammar(store.getSource(sourceId)?.originKey??'');
   const standaloneCode=!!sourceGrammar&&sourceGrammar.id!=='markdown';
   if(entry.structural&&isDiscreteCodeUnit(entry.structural)&&standaloneCode){
    // A structural route owns one coherent quote group. Never import an
    // unrelated source-level cached seed window into every routed definition.
    const required=spans.map(id=>readSupport(id));const u=entry.structural;
    if(u.parentId){
     const parent=store.db.prepare("SELECT canonical_json FROM derived_nodes WHERE namespace_id=? AND status='active' AND logical_key=?").get(namespaceId,`wiki/structure/${sourceId}/${u.parentId}`);
     const enclosing=parent?JSON.parse(String(parent.canonical_json)).entries?.[0]?.structural:undefined;
     if(enclosing?.kind==='block'&&enclosing.headerByteEnd>enclosing.headerByteStart&&enclosing.headerByteEnd-enclosing.headerByteStart<=4096&&!required.some(e=>e.byteStart<=enclosing.headerByteStart&&e.byteEnd>=enclosing.headerByteEnd)){
      try{required.push(store.createEvidenceSpan(sourceId,required[0].artifactId,enclosing.headerByteStart,enclosing.headerByteEnd,{namespaceId,budget,deadlineAt}) as any);}catch{truncated=true;}
     }
    }
    const score=scoreFacetCoverage(recall,String(entry.text)+' '+u.symbolPath);
    base=bind({sourceId,text:'',spanIds:[],artifactIds:[],matchedFacetIds:score.matchedFacetIds,supportGroupIds:[],reasons:['provenance_support'],trace:{sourceStatus:'active',structuralUnits:[{...u,whole:rangesCover(required,u.byteStart,u.byteEnd,required[0].artifactId),headerComplete:rangesCover(required,u.headerByteStart,u.headerByteEnd,required[0].artifactId)}],coherentStructuralRoute:true},utility:score.score},required);
    if(base.trace.structuralUnits.some((unit:any)=>!unit.whole||!unit.headerComplete))base.trace={...base.trace,truncated:true,structuralIncomplete:true};
   }else{
    if(windowCache&&!windowCache.has(sourceId))windowCache.set(sourceId,buildEvidenceWindow(store,sourceId,recall,structuralSeed,namespaceId,deadlineAt,budget,windowPolicy));
    base=windowCache?.get(sourceId)??buildEvidenceWindow(store,sourceId,recall,structuralSeed,namespaceId,deadlineAt,budget,windowPolicy);
    if(base&&entry.structural&&(!standaloneCode||isDocumentStructuralUnit(entry.structural))){
     // Prose routes preserve the richer bounded source window and its bridges.
     // Surface-word saturation is not proof that adjacent sections are redundant.
     base={...base,trace:{...base.trace,documentStructuralRoute:true,structuralUnits:uniqueStructuralTrace([...(base.trace.structuralUnits??[]),entry.structural])}};
    }
   }
   if(!base)continue;
   const required=spans.map(id=>readSupport(id));
   // A small alternate representation can include adjacent punctuation/context;
   // retain the exact required subspan binding as well as that real excerpt.
   const alternateContext=required.flatMap(p=>{if(base.artifactIds.includes(p.artifactId))return [];const a=store.db.prepare('SELECT b.byte_length FROM artifacts a JOIN blobs b ON b.sha256=a.blob_sha256 WHERE a.artifact_id=?').get(p.artifactId);if(!a||Number(a.byte_length)>4096)return [];try{return [store.createEvidenceSpan(sourceId,p.artifactId,0,Number(a.byte_length),{namespaceId,budget,deadlineAt})];}catch{truncated=true;return [];}});
   const c=bind({...base,trace:{...base.trace},supportGroupIds:[group],reasons:['provenance_support'],supportRequirements:{[group]:selectedSpans},derivedNodeIds:[nodeId]},[...(base.excerpts??[]),...required,...alternateContext]);
   if(Number(row.layer)===1){c.derivedText=`[${row.status}] revision ${row.revision}: ${row.body}`;c.trace.semanticInterpretation=true;}
   c.claimSignatures=claimSignatures(recall,String(entry.text));
   c.trace={...c.trace,extractiveRouting:Number(row.layer)===2&&entry.textKind!=='derived'&&bySource.size===1,seedNodeId:nodeId,nodeStatus:row.status,...(entry.entryId?{entryId:entry.entryId}:{})};result.push(c);
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

 // Track `nodeId -> Map<clueId, hopDistance>` AND `nodeId -> Map<clueId, Set<originSeedNodeId>>`
 // A true triangulation requires >= 2 clues arriving from at least 2 distinct origin seed nodes
 // (not a single seed node carrying both clue labels along a 1-path walk).
 const reached=new Map<string,Map<string,number>>();
 const originsByTarget=new Map<string,Map<string,Set<string>>>();
 const seedSet=new Set<string>();
 let frontier=new Map<string,Set<string>>(); // nodeId -> Set<clueId>

 for(const [clueId,nodeIds] of seedNodesByClue.entries()){
  for(const nid of nodeIds){
   seedSet.add(nid);
   let m=reached.get(nid);if(!m){m=new Map();reached.set(nid,m);}
   m.set(clueId,0);
   let o=originsByTarget.get(nid);if(!o){o=new Map();originsByTarget.set(nid,o);}
   let cSet=o.get(clueId);if(!cSet){cSet=new Set();o.set(clueId,cSet);}
   cSet.add(nid);
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
   const parentOrigins=originsByTarget.get(edge.seedNodeId);
   if(!parentClues||!parentOrigins)continue;
   let m=reached.get(targetId);
   if(!m){m=new Map();reached.set(targetId,m);}
   let o=originsByTarget.get(targetId);
   if(!o){o=new Map();originsByTarget.set(targetId,o);}
   for(const cId of parentClues){
    let cSet=o.get(cId);if(!cSet){cSet=new Set();o.set(cId,cSet);}
    for(const sId of parentOrigins.get(cId)??[])cSet.add(sId);
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
  // Verify true multi-point triangulation: exist at least two clues (c1 != c2) that originated from
  // at least two distinct seed nodes (s1 != s2). If a single seed node already had both clues and walked
  // a single path, that's a 1-point walk, not multi-point triangulation!
  const originMap=originsByTarget.get(nodeId);
  let hasDistinctOriginPair=false;
  const clueEntries=originMap?[...originMap.entries()]:[];
  for(let i=0;i<clueEntries.length&&!hasDistinctOriginPair;i++){
   for(let j=i+1;j<clueEntries.length&&!hasDistinctOriginPair;j++){
    for(const s1 of clueEntries[i][1]){
     for(const s2 of clueEntries[j][1]){
      if(s1!==s2){hasDistinctOriginPair=true;break;}
     }
     if(hasDistinctOriginPair)break;
    }
   }
  }
  if(!hasDistinctOriginPair)continue;
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
export function isDocumentStructuralUnit(unit:any):boolean {
 if(unit?.kind==='section')return true;
 const grammar=getLanguageGrammar(String(unit?.originKey??''));
 return !isDiscreteCodeUnit(unit)&&(!grammar||grammar.id==='markdown')&&!/^code: .+ \((?:python|typescript)\)$/.test(String(unit?.inferredLabel??''));
}
/** Declaration siblings are alternatives; prose sections often form a chain.
 * A part inherits the grammar of its verified file or inferred code region. */
export function isDiscreteCodeUnit(unit:any):boolean {
 if(unit?.kind==='block')return true;
 if(unit?.kind!=='part'||unit.symbolPath===unit.originKey)return false;
 const grammar=getLanguageGrammar(String(unit.originKey??''));
 return !!grammar&&grammar.id!=='markdown'||/^code: .+ \((?:python|typescript)\)$/.test(String(unit.inferredLabel??''));
}
/** Query-relative unit selection; no model names, task tags or corpus words. */
export function selectCoherentEvidence(candidates:EvidenceCandidate[],recall:RecallQuery,windowPolicy:EvidenceWindowPolicy=DEFAULT_WINDOW_POLICY):EvidenceCandidate[] {
 const byRange=new Map<string,EvidenceCandidate>();
 for(const c of candidates){const key=c.excerpts?.map(e=>`${e.artifactId}:${e.byteStart}:${e.byteEnd}`).sort().join('|')??c.spanIds.join('|');const old=byRange.get(key);if(old)mergeEvidenceMetadata(old,c);else byRange.set(key,{...c});}
 const unique=[...byRange.values()];
 const quality=(c:EvidenceCandidate)=>scoreFacetCoverage(recall,c.text+' '+(c.trace?.structuralUnits??[]).map((u:any)=>u.symbolPath).join(' ')).score;
 unique.sort((a,b)=>quality(b)-quality(a)||a.text.length-b.text.length||a.spanIds.join().localeCompare(b.spanIds.join()));
 if(!unique.length)return [];
 const selected:EvidenceCandidate[]=[],covered=new Set<string>();let bytes=0;
 const top=quality(unique[0]);
 const comparative=/\b(compare|contrast|difference|differences|history|historical)\b/i.test(recall.original);
 for(const c of unique){
  const coverage=scoreFacetCoverage(recall,c.text+' '+(c.trace?.structuralUnits??[]).map((u:any)=>u.symbolPath).join(' '),covered);
  const exactNew=recall.facets.some(f=>f.origin==='question'&&(f.kind==='identifier'||f.kind==='entity')&&!covered.has(f.id)&&coverage.matchedFacetIds.includes(f.id)&&c.text.includes(f.surface));
  const essential=c.reasons.includes('contradiction')||c.reasons.includes('dependency');
  const discrete=(c.trace?.structuralUnits??[]).some(isDiscreteCodeUnit)&&!(c.trace?.structuralUnits??[]).some((u:any)=>u.kind==='section')&&!c.trace?.documentStructuralRoute;
  const ranges=selected.flatMap(x=>x.excerpts??[]);
  const covering=selected.find(x=>(c.excerpts??[]).every(e=>(x.excerpts??[]).some(r=>r.artifactId===e.artifactId&&r.byteStart<=e.byteStart&&r.byteEnd>=e.byteEnd)));
  if(covering){mergeEvidenceMetadata(covering,c);continue;}
  if(discrete&&selected.length&&!comparative&&!essential&&quality(c)<top/2&&!exactNew)continue;
  // Later alternatives need either a distinct clue or a comparably strong
  // independent unit. Source-byte length is a ceiling, not a fill target.
  if(discrete&&selected.length>=2&&!comparative&&!essential&&coverage.gain<=0)continue;
  const next=evidenceWindowCharge([...(selected.flatMap(x=>x.excerpts??[])),...(c.excerpts??[])],windowPolicy);
  if(next>windowPolicy.maxSourceBytes&&selected.length)continue;
  selected.push(c);bytes=next;coverage.matchedFacetIds.forEach(id=>covered.add(id));
 }
 return selected;
}
/** Focus completion context on actual primary-symbol definitions and uses.
 * Metadata routes are not a blanket exemption; explicit obligations are owned
 * by the planner and never enter this optional-only filter. */
export function focusCursorEvidence(candidates:EvidenceCandidate[],recall:RecallQuery):EvidenceCandidate[]{
 const primary=recall.cursorContext?.primaryIdentifiers??[];if(!primary.length)return candidates;
 const exact=(text:string,id:string)=>new RegExp('(?:^|[^A-Za-z0-9_$])'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^A-Za-z0-9_$])').test(text);
 const definition=(c:EvidenceCandidate)=>primary.some(id=>(c.trace.structuralUnits??[]).some((u:any)=>u.symbolName===id||String(u.symbolPath).endsWith('::'+id)));
 if(!candidates.some(definition))return candidates;
 const strongest=Math.max(...candidates.filter(definition).map(c=>c.utility));
 return candidates.filter(c=>{
  const linked=c.reasons.some(r=>r==='dependency'||r==='contradiction')||c.trace.semanticInterpretation||Object.values(c.supportRequirements??{}).some(ids=>ids.some(id=>!c.spanIds.includes(id)));
  const hit=primary.some(id=>exact(c.text,id));
  if(linked||definition(c)||hit||c.utility>=strongest/2)return true;
  return false;
 });
}
export function discoverEvidenceCandidates(store:ContextForgeStore,query:string,namespaceId=store.namespaceId,deadlineAt=Infinity,resources:{historyTokens?:number;availableMemoryBytes?:number}={}):{candidates:EvidenceCandidate[];work:Record<string,number>;truncated:boolean;redundantSourceIds?:string[]} {
 const recall=analyzeRecallQuery(query);if(!recall.substantiveTerms.length)return {candidates:[],work:{seeds:0,chunks:0,neighbors:0},truncated:false};
 const corpusBytes=Number(store.db.prepare("SELECT coalesce(sum(b.byte_length),0) bytes FROM sources s JOIN source_lifecycle l USING(source_id) JOIN blobs b ON b.sha256=s.content_sha256 WHERE s.namespace_id=? AND l.status='active'").get(namespaceId)!.bytes);
 const policy=resolveRetrievalWorkPolicy({...resources,corpusBytes});
 const activeSourceCount=Number(store.db.prepare("SELECT count(*) n FROM sources s JOIN source_lifecycle l USING(source_id) WHERE s.namespace_id=? AND l.status='active'").get(namespaceId)!.n);
 const windowPolicy=resolveEvidenceWindowPolicy(resources.historyTokens??9500,activeSourceCount,policy.maxBytes);
 const budget=createStoreReadBudget({maxInspected:policy.hydrationRows,maxBytes:Math.floor(policy.maxBytes/2),deadlineAt});
 const lane=()=>createStoreReadBudget({maxInspected:policy.discoveryRows,maxBytes:Math.floor(policy.maxBytes/8),deadlineAt});
 const rawBudget=lane(),factBudget=lane(),wikiBudget=lane(),facetBudget=lane();
 const raw=store.search(query,{namespaceId,layers:[0],limit:128,deadlineAt,budget:rawBudget});
 let inspectedChunks=raw.inspected??raw.length,statisticsInspected=raw.statisticsInspected??0,continuationTruncated=false;
 // Continue each uncovered substantive facet independently; repeating the
 // anchor in an OR query would let frequent facets starve the same rare row.
 const covered=new Set(raw.filter(h=>scoreFacetCoverage(recall,h.title+' '+h.body).anchored).flatMap(h=>scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds));
 let facetQueries=0;
 for(const facet of recall.facets){if(facet.origin!=='question'||covered.has(facet.id))continue;if(Date.now()>=deadlineAt||facetQueries>=8){continuationTruncated=true;break;}facetQueries++;
  const anchor=recall.facets.find(f=>f.origin==='question'&&(f.kind==='identifier'||f.kind==='entity')&&f.id!==facet.id);
  const extra=store.search(facet.surface,{namespaceId,layers:[0],limit:128,maxInspected:128,deadlineAt,budget:facetBudget,...(anchor?{requiredTerms:[anchor.aliases[0]]}:{})});inspectedChunks+=extra.inspected??extra.length;statisticsInspected+=extra.statisticsInspected??0;continuationTruncated ||= extra.truncated??false;
  for(const h of extra)if(scoreFacetCoverage(recall,h.title+' '+h.body).anchored&&!raw.some(r=>r.chunkId===h.chunkId)){raw.push(h);scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds.forEach(f=>covered.add(f));}
 }
 // A bounded first page may be saturated by a prior bulk attachment. Continue
 // the original query by rowid after rare-facet continuation; a
 // shared word in old telemetry does not establish a later causal premise.
 // SQL BM25 narrowing replaces insertion-order continuation. Independent L1
 // and L2 lanes protect facts and canonical/structural routes from raw volume.
 const facts=store.search(query,{namespaceId,layers:[1],limit:32,deadlineAt,budget:factBudget});
 const wiki=store.search(query,{namespaceId,layers:[2],limit:64,deadlineAt,budget:wikiBudget});
 const nodes=Object.assign([...facts,...wiki],{inspected:facts.inspected+wiki.inspected,truncated:facts.truncated||wiki.truncated});
 const out=new Map<string,EvidenceCandidate>(),windowCache=new Map<string,EvidenceCandidate|null>();
 const structuralPool:EvidenceCandidate[]=[],extractivePool:EvidenceCandidate[]=[];
 const collect=(c:EvidenceCandidate)=>{if(c.trace?.coherentStructuralRoute)structuralPool.push(c);else if(c.trace?.extractiveRouting)extractivePool.push(c);else merge(c);};
 const merge=(c:EvidenceCandidate)=>{const prev=out.get(c.sourceId);if(prev&&c.trace?.seedNodeId){const union=[...new Map([...(prev.excerpts??[]),...(c.excerpts??[])].map(e=>[e.spanId,e])).values()];if(evidenceWindowCharge(union,windowPolicy)>windowPolicy.maxSourceBytes){prev.trace={...prev.trace,truncated:true};return;}}if(!prev)out.set(c.sourceId,c);else{prev.derivedNodeIds=[...new Set([...(prev.derivedNodeIds??[]),...(c.derivedNodeIds??[])])];prev.claimSignatures=[...new Set([...(prev.claimSignatures??[]),...(c.claimSignatures??[])])];bind(prev,[...(prev.excerpts??[]),...(c.excerpts??[])]);if(c.derivedText&&!prev.derivedText?.includes(c.derivedText)){const combined=(prev.derivedText?prev.derivedText+'\n':'')+c.derivedText;if(c.trace?.indexedSeedHydration){if(combined.length<=STRUCTURAL_NAVIGATION_CHARS)prev.derivedText=combined;}else prev.derivedText=combined;}prev.reasons=[...new Set([...prev.reasons,...c.reasons])];prev.utility=Math.max(prev.utility,c.utility);prev.trace={...prev.trace,...c.trace,documentStructuralRoute:!!(prev.trace.documentStructuralRoute||c.trace.documentStructuralRoute),semanticInterpretation:!!(prev.trace.semanticInterpretation||c.trace.semanticInterpretation),structuralUnits:uniqueStructuralTrace([...(prev.trace.structuralUnits??[]),...(c.trace.structuralUnits??[])])};prev.supportRequirements={...prev.supportRequirements,...c.supportRequirements};prev.supportGroupIds=[...new Set([...prev.supportGroupIds,...c.supportGroupIds])];prev.matchedFacetIds=[...new Set([...prev.matchedFacetIds,...c.matchedFacetIds])];}};
 for(const hit of raw){if(Date.now()>=deadlineAt)break;if(!hit.sourceId||!scoreFacetCoverage(recall,hit.title+' '+hit.body).anchored)continue;if(!windowCache.has(hit.sourceId))windowCache.set(hit.sourceId,buildEvidenceWindow(store,hit.sourceId,recall,selectEvidenceAnchors(raw.filter(h=>h.sourceId===hit.sourceId&&h.spanId),recall,windowPolicy.maxAnchors).map(h=>h.spanId!),namespaceId,deadlineAt,budget,windowPolicy));const c=windowCache.get(hit.sourceId);if(c&&scoreFacetCoverage(recall,c.text).anchored&&c.utility>0)merge({...c,trace:{...c.trace}});}
 const eligible=nodes.filter(h=>!h.logicalKey?.startsWith('wiki/timeline/')&&h.title!=='record'&&scoreFacetCoverage(recall,h.title+' '+h.body).anchored&&scoreFacetCoverage(recall,h.title+' '+h.body).score>0);
 const seeds:typeof eligible=[],seedFacets=new Set<string>(),remaining=[...eligible];while(remaining.length&&seeds.length<16){remaining.sort((a,b)=>scoreFacetCoverage(recall,b.title+' '+b.body,seedFacets).gain-scoreFacetCoverage(recall,a.title+' '+a.body,seedFacets).gain||a.score-b.score||a.nodeId!.localeCompare(b.nodeId!));const h=remaining.shift()!;seeds.push(h);scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds.forEach(f=>seedFacets.add(f));}
 for(const h of seeds){if(Date.now()>=deadlineAt)break;for(const c of hydrateProvenanceSupport(store,h.nodeId!,recall,namespaceId,windowCache,deadlineAt,budget,windowPolicy))collect(c);}
 const related=expandRelatedPremises(store,seeds.map(h=>h.nodeId!),recall,namespaceId,deadlineAt,budget);
 for(const r of related){if(Date.now()>=deadlineAt)break;for(const c of hydrateProvenanceSupport(store,r.node.nodeId,recall,namespaceId,windowCache,deadlineAt,budget,windowPolicy)){c.reasons.push(r.relation==='contradicts'?'contradiction':'dependency');c.trace={...c.trace,relation:r.relation,direction:r.direction};collect(c);}}
 // Multi-Clue Triangulation (up to 3 hops):
 // Even if one candidate document already mentions all clues, a 2nd/3rd bridge document where
 // >= 2 distinct clue seed nodes converge can hold the hidden root cause ("looking for the least
 // because it sheds light on the most"). Triangulate across all substantive question clues
 // whenever >= 2 distinct origin seed nodes exist!
 const questionFacetIds=new Set(recall.facets.filter(f=>f.origin==='question').map(f=>f.id));
 const seedNodesByClue=new Map<string,string[]>();
 for(const h of seeds){
  const m=scoreFacetCoverage(recall,h.title+' '+h.body).matchedFacetIds.filter(id=>questionFacetIds.has(id));
  for(const fId of m){const arr=seedNodesByClue.get(fId)??[];if(!arr.includes(h.nodeId!))arr.push(h.nodeId!);seedNodesByClue.set(fId,arr);}
 }
 if(seedNodesByClue.size>=2&&Date.now()<deadlineAt){
  const bridges=triangulateMultiClueGraph(store,seedNodesByClue,recall,{namespaceId,maxHops:3,deadlineAt,budget});
  for(const b of bridges){
   if(Date.now()>=deadlineAt)break;
   const row=store.db.prepare('SELECT title,body FROM derived_nodes WHERE node_id=? AND namespace_id=?').get(b.nodeId,namespaceId) as any;
   if(!row||!scoreFacetCoverage(recall,`${row.title} ${row.body}`).anchored)continue;
   for(const c of hydrateProvenanceSupport(store,b.nodeId,recall,namespaceId,windowCache,deadlineAt,budget,windowPolicy)){
    c.reasons.push('triangulated_bridge');
    c.utility+=b.triangulationScore;
    c.trace={...c.trace,triangulatedClues:b.convergedClues,minHop:b.minHop,triangulationScore:b.triangulationScore};
    collect(c);
   }
  }
 }
 // Rank source-backed unit alternatives before merging. Duplicate routing
 // pages add no evidence gain. A sharp quality drop plus no new exact clue
 // must not turn every weakly related declaration into mandatory context.
 const bySource=new Map<string,EvidenceCandidate[]>();for(const c of structuralPool){const list=bySource.get(c.sourceId)??[];list.push(c);bySource.set(c.sourceId,list);}
 for(const [sourceId,pool] of bySource){
  const selected=selectCoherentEvidence(pool,recall,windowPolicy);
  const raw=out.get(sourceId);
  if(raw&&getLanguageGrammar(store.getSource(sourceId)?.originKey??'')&&!raw.supportGroupIds.length&&!raw.trace?.documentStructuralRoute&&selected.length&&selected.every(c=>!(c.trace?.structuralUnits??[]).some((u:any)=>!isDiscreteCodeUnit(u)))){
   const covered=new Set(selected.flatMap(c=>c.matchedFacetIds));
   const residual=(raw.excerpts??[]).filter(e=>scoreFacetCoverage(recall,e.text,covered).gain>0);
   if(!residual.length)out.delete(sourceId);else {bind(raw,residual);const score=scoreFacetCoverage(recall,raw.text);raw.utility=score.score;raw.matchedFacetIds=score.matchedFacetIds;}
  }
  for(const c of selected)merge(c);
 }
 // Generic L2 line/source pages are alternative routes, not extra claims. They
 // may add a genuinely new clue, but cannot reintroduce an already-covered
 // weak tail after structural selection. Semantic facts and multi-source
 // support bypass this alternative-routing pool and remain indivisible.
 for(const c of extractivePool){
  const current=out.get(c.sourceId);
  const hasCoherent=current?.trace?.coherentStructuralRoute&&!current?.trace?.documentStructuralRoute;
  if(hasCoherent&&!c.reasons.some(r=>r==='contradiction'||r==='dependency')&&!historical(recall)&&!/\b(contrast)\b/i.test(recall.original)){
   const seen=new Set(current!.matchedFacetIds);
   if(!c.matchedFacetIds.some(id=>!seen.has(id)))continue;
  }
  merge(c);
 }
 // Chronological State Evolution Ledger (for multi-revision flip-flops / court-case style timelines):
 if(out.size>0&&Date.now()<deadlineAt){
  const ledgers=buildTemporalStateLedger(store,[...out.keys()],recall,namespaceId);
  for(const l of ledgers){
   for(const srcId of l.sourceIds){
    const cand=out.get(srcId);
    if(cand&&!cand.derivedText?.includes(l.ledgerText)){
     cand.derivedText=(cand.derivedText?cand.derivedText+'\n':'')+l.ledgerText;cand.trace.semanticInterpretation=true;
    }
   }
  }
 }
 for(const c of out.values())c.claimSignatures=claimSignatures(recall,c.text);
 const candidates=focusCursorEvidence([...out.values()],recall).sort((a,b)=>b.utility-a.utility||a.sourceId.localeCompare(b.sourceId));
 // Equivalent claims with irrelevant archive boilerplate are alternatives.
 // Never remove one member of a genuinely complementary multi-source group.
 const groupClaims=new Map<string,Set<string>>();for(const c of candidates)for(const g of c.supportGroupIds){const set=groupClaims.get(g)??new Set<string>();set.add(JSON.stringify(claimSignatures(recall,c.text)));groupClaims.set(g,set);}
 const redundantSourceIds:string[]=[];const seen=new Set<string>();const unique=candidates.filter(c=>{const signature=JSON.stringify(claimSignatures(recall,c.text));const key=signature==='[]'?c.text:signature;if(c.supportGroupIds.some(g=>(groupClaims.get(g)?.size??0)>1))return true;if(seen.has(key)){redundantSourceIds.push(c.sourceId);return false;}seen.add(key);return true;});
 // Keep incomplete support groups visible. Planner's range-aware atomic
 // validation must reject them; stripping the group would detach its claim.


 return {candidates:unique,redundantSourceIds,work:{seeds:seeds.length,chunks:inspectedChunks,nodes:nodes.inspected??nodes.length,statistics:statisticsInspected,inspectedTotal:budget.inspected+rawBudget.inspected+factBudget.inspected+wikiBudget.inspected+facetBudget.inspected,readBytes:budget.bytes+rawBudget.bytes+factBudget.bytes+wikiBudget.bytes+facetBudget.bytes,maxInspected:policy.maxInspected,maxReadBytes:policy.maxBytes,windowAnchors:windowPolicy.maxAnchors,windowBytes:windowPolicy.maxWindowBytes,sourceEvidenceBytes:windowPolicy.maxSourceBytes,hydrationReserved:policy.hydrationRows,l0Inspected:rawBudget.inspected,l1Inspected:factBudget.inspected,l2Inspected:wikiBudget.inspected,facetInspected:facetBudget.inspected,hydrationInspected:budget.inspected,facetQueries,neighbors:related.length,neighborsInspected:related.inspected,hydrated:out.size},truncated:budget.inspected>=budget.maxInspected||budget.bytes>=budget.maxBytes||raw.truncated||nodes.truncated||continuationTruncated||raw.length>=128||nodes.length===64||eligible.length>16||related.truncated||Date.now()>=deadlineAt||recall.truncated||unique.some(c=>c.trace?.truncated)};
}
