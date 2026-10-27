import { ContextForgeStore, COMPILER_VERSION, canonicalJson, sha256, stableId } from './store.ts';
import type { DerivedNodeRecord, FactRecord, JsonValue } from './types.ts';

export const WIKI_COMPILER_VERSION = 'extractive-facets-v2';
export type Evidence = { source_id:string; span_id:string; body:string; observed_at:number; trust_class:string; fidelity:string; namespace_id:string; source_kind:string; artifact_id:string; artifact_kind:string; ordinal:number; byte_start:number; byte_end:number };
export interface RoutingEntry {
  textKind:'extractive'|'derived'; entryId:string; text:string; spanIds:string[]; dependencyNodeIds:string[]; entityKeys:string[]; topicKeys:string[]; facetKinds:string[];
  ordinal:number; observedAt:number; sourceId:string; artifactId:string; trustClass:string; fidelity:string;
  spans:Array<{spanId:string;sourceId:string;artifactId:string;byteStart:number;byteEnd:number}>;
}
type WikiPage = { title:string; entries:RoutingEntry[]; observed:number; omission?:{totalEntries:number;includedEntries:number;omittedEntries:number;complete:boolean;sourceHandle:string} };
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
const routingKey=(s:string)=>s.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu,' ');
const unique=(values:string[])=>[...new Set(values)].sort(compareText);
const entryOrder=(a:RoutingEntry,b:RoutingEntry)=>a.observedAt-b.observedAt||compareText(a.sourceId,b.sourceId)||compareText(a.artifactId,b.artifactId)||a.ordinal-b.ordinal||compareText(a.entryId,b.entryId);

/** Select one textual representation per source; raw message JSON is never a substitute for decoded text. */
export function collectEvidence(store:ContextForgeStore,namespaceId=store.namespaceId):{l1:Evidence[];l2:Evidence[]} {
  store.assertNamespace(namespaceId);
  const rows=store.db.prepare(`SELECT s.source_id,s.namespace_id,s.observed_at,s.trust_class,s.kind AS source_kind,c.span_id,c.body,c.ordinal,a.fidelity,a.artifact_id,a.kind AS artifact_kind,p.byte_start,p.byte_end
    FROM chunks c JOIN spans p USING(span_id) JOIN artifacts a USING(artifact_id) JOIN sources s ON s.source_id=p.source_id JOIN source_lifecycle l ON l.source_id=s.source_id
    WHERE s.namespace_id=? AND l.status='active' AND a.kind<>'normalized_message' AND a.text_content IS NOT NULL
    ORDER BY s.observed_at,s.source_id,a.artifact_id,c.ordinal,c.chunk_id`).all(namespaceId) as Evidence[];
  const sources=new Map<string,Map<string,Evidence[]>>();
  for(const row of rows){let artifacts=sources.get(row.source_id);if(!artifacts){artifacts=new Map();sources.set(row.source_id,artifacts);}const group=artifacts.get(row.artifact_id)??[];group.push(row);artifacts.set(row.artifact_id,group);}
  const l2:Evidence[]=[];
  for(const artifacts of sources.values()) {
    const groups=[...artifacts.values()];
    const preference=(e:Evidence)=>{
      if(['turn','tool_result'].includes(e.source_kind))return e.artifact_kind==='text'?0:e.artifact_kind==='raw'?10:20;
      return e.artifact_kind==='raw'?0:e.artifact_kind==='text'?1:2;
    };
    groups.sort((a,b)=>preference(a[0])-preference(b[0])||compareText(a[0].artifact_id,b[0].artifact_id));
    // Opaque raw JSON for accepted turns has no text_content, and is excluded above.
    l2.push(...groups[0]);
  }
  l2.sort((a,b)=>a.observed_at-b.observed_at||compareText(a.source_id,b.source_id)||compareText(a.artifact_id,b.artifact_id)||a.ordinal-b.ordinal);
  return {l1:l2.filter(e=>e.source_kind!=='tool_result'),l2};
}

/** All labels are lexical navigation hints, never assertions or entity equivalence. */
export function extractRoutingFacets(text:string):{entityKeys:string[];topicKeys:string[];facetKinds:string[]} {
  const entities:string[]=[],topics:string[]=[],kinds:string[]=[];
  const heading=/^\s*#{1,6}\s+(.+?)\s*#*\s*$/u.exec(text);
  if(heading){topics.push(heading[1]);kinds.push('heading','topic');}
  const controlled=/^(?:State|Correction|Decision|Negative fact|Constraint|Concept|Fact):\s*([^|=]+)\|/iu.exec(text);
  if(controlled)entities.push(controlled[1]);
  if(text.trim().startsWith('{'))try { const row=JSON.parse(text);if(typeof row.entity==='string')entities.push(row.entity);if(typeof row.predicate==='string')topics.push(row.predicate); }catch{}
  for(const m of text.matchAll(/(?:^|[\s,;|])([\p{L}_][\p{L}\p{N}_.-]*)\s*[:=]/gu)) {
    topics.push(m[1]);
    if(/^(?:entity|subject|project|system|subsystem|product|service)$/iu.test(m[1])) {
      const value=/^\s*([^\s,;|]+)/u.exec(text.slice(m.index!+m[0].length));if(value)entities.push(value[1]);
    }
  }
  for(const m of text.matchAll(/\b[\p{Lu}][\p{L}\p{N}]*(?:[-_.][\p{L}\p{N}]+)+\b|\b[\p{Lu}][\p{L}\p{N}]{1,}\b/gu)) {
    if(!/^(?:The|This|That|There|These|Those|It|We|No|Not|Fact|State|Correction|Decision|Constraint|Concept|Negative|Report|Status|Return)$/u.test(m[0]))entities.push(m[0]);
  }
  for(const m of text.matchAll(/\b[\p{L}][\p{L}\p{N}]*(?:[-_.][\p{L}\p{N}]+)+\b/gu))if(/[\p{N}\p{Lu}]/u.test(m[0]))entities.push(m[0]);
  if(/\b(?:status|current)\b/iu.test(text))kinds.push('status');
  if(/\b(?:changed?|unchanged|correction|replac\w*|release|previous)\b/iu.test(text))kinds.push('status','change');
  if(/\b(?:except\w*|unless|only|provided|if|when|without|must|never|constraint|not|cannot|may|might|conditional|unchanged|ambig\w*|unknown|undocumented|absen\w*|no)\b/iu.test(text))kinds.push('qualification','constraint');
  if(/\b(?:propos\w*|reject\w*|declin\w*|instead)\b/iu.test(text))kinds.push('proposal');
  if(/\b(?:anomal\w*|fault\w*|exception\w*|quarantine|outlier|failure|error)\b/iu.test(text))kinds.push('anomaly');
  if(/\bdecision\b/iu.test(text))kinds.push('decision');
  if(/\bnegative fact\b/iu.test(text))kinds.push('negative');
  if(text.includes('|')||text.includes('\t'))kinds.push('table');
  return {entityKeys:unique(entities.map(routingKey).filter(k=>k&&k!=='record')),topicKeys:unique(topics.map(routingKey)),facetKinds:unique(kinds.length?kinds:['content'])};
}
function evidenceEntry(rows:Evidence[],dependencies:string[]=[],extraKinds:string[]=[]):RoutingEntry {
  const text=rows.map((e,i)=>(i>0&&!(e.artifact_id===rows[i-1].artifact_id&&e.byte_start===rows[i-1].byte_end)?'\n[noncontiguous excerpt]\n':'')+e.body).join(''),first=rows[0],facets=extractRoutingFacets(text);
  return {textKind:'extractive',entryId:stableId('cf-wiki-entry-v2',first.source_id,rows.map(e=>e.span_id),text),text,spanIds:unique(rows.map(e=>e.span_id)),dependencyNodeIds:unique(dependencies),
    entityKeys:facets.entityKeys,topicKeys:facets.topicKeys,facetKinds:unique([...facets.facetKinds,...extraKinds]),ordinal:first.ordinal,observedAt:first.observed_at,sourceId:first.source_id,artifactId:first.artifact_id,trustClass:first.trust_class,fidelity:first.fidelity,
    spans:rows.map(e=>({spanId:e.span_id,sourceId:e.source_id,artifactId:e.artifact_id,byteStart:e.byte_start,byteEnd:e.byte_end}))};
}

/** Deterministic bounded routing pages, including partitioned source fallbacks. */
export function buildWikiPages(evidence:Evidence[],facts:RoutingEntry[]):Map<string,WikiPage> {
  const pages=new Map<string,WikiPage>();
  const add=(key:string,title:string,entry:RoutingEntry)=>{
    let page=pages.get(key);if(!page){page={title,entries:[],observed:entry.observedAt};pages.set(key,page);}
    if(!page.entries.some(e=>e.entryId===entry.entryId))page.entries.push(entry);page.observed=Math.max(page.observed,entry.observedAt);
  };
  const bySource=new Map<string,Evidence[]>();for(const e of evidence){const rows=bySource.get(e.source_id)??[];rows.push(e);bySource.set(e.source_id,rows);}
  const spanDeps=new Map<string,string[]>();for(const fact of facts)for(const span of fact.spanIds)spanDeps.set(span,unique([...(spanDeps.get(span)??[]),...fact.dependencyNodeIds]));
  for(const [sourceId,rows] of bySource) {
    let heading:string|undefined;let headingEntities:string[]=[];const entries:RoutingEntry[]=[];
    for(const row of rows) {
      const entry=evidenceEntry([row],spanDeps.get(row.span_id));
      if(entry.facetKinds.includes('heading')){heading=row.body.replace(/^\s*#+\s*/u,'').trim();headingEntities=entry.entityKeys;}
      if(heading){entry.topicKeys=unique([...entry.topicKeys,routingKey(heading)]);entry.entityKeys=unique([...entry.entityKeys,...headingEntities]);}
      entries.push(entry);
      add(`wiki/sources/${sourceId}`,heading??`Source ${sourceId}`,entry);
      add(`wiki/timeline/${new Date(row.observed_at).toISOString().slice(0,10)}`,'Timeline',entry);
    }
    // Table entries bind each row to its original header, introduction, and adjacent qualifications.
    for(let i=0;i<rows.length;i++) {
      if(!/[|\t]/u.test(rows[i].body))continue;
      const start=i;while(i+1<rows.length&&/[|\t]/u.test(rows[i+1].body))i++;
      const end=i;const prefix=rows.slice(Math.max(0,start-2),start);
      const header=rows[start];const divider=start+1<=end&&/^\s*\|?[\s:|-]+\|?\s*$/u.test(rows[start+1].body)?rows[start+1]:undefined;
      const suffix=rows.slice(end+1,Math.min(rows.length,end+3)).filter(e=>extractRoutingFacets(e.body).facetKinds.some(k=>['qualification','heading'].includes(k))||/\b(?:author|inspector|units?|report)\b/iu.test(e.body));
      for(let j=start+(divider?2:1);j<=end;j++) {
        const members=[...prefix,header,...(divider?[divider]:[]),rows[j],...suffix];
        const entry=evidenceEntry(members,unique(members.flatMap(e=>spanDeps.get(e.span_id)??[])),['table']);
        const tableHeading=entries.filter(e=>e.ordinal<=rows[start].ordinal&&e.facetKinds.includes('heading')).at(-1);
        if(tableHeading){entry.topicKeys=unique([...entry.topicKeys,...tableHeading.topicKeys]);entry.entityKeys=unique([...entry.entityKeys,...tableHeading.entityKeys]);}
        entry.ordinal=rows[j].ordinal;
        entries.push(entry);add(`wiki/tables/${sourceId}`,'Table excerpts',entry);
      }
    }
    const summaryEntries=[...entries].sort((a,b)=>{
      const priority=(e:RoutingEntry)=>e.facetKinds.some(k=>['qualification','proposal','anomaly'].includes(k))?0:e.facetKinds.includes('change')?1:e.facetKinds.includes('heading')||e.ordinal===rows[0].ordinal?2:3;
      return priority(a)-priority(b)||entryOrder(a,b);
    });
    let chars=0;const included:RoutingEntry[]=[];
    for(const entry of summaryEntries)if(included.length<32&&chars+entry.text.length<=8192){included.push(entry);chars+=entry.text.length;}
    // Never truncate an original line to make it look like a complete source quote.
    if(included.length) {
      for(const entry of included)add(`wiki/summaries/${sourceId}`,`Source summary: ${heading??sourceId}`,entry);
      pages.get(`wiki/summaries/${sourceId}`)!.omission={totalEntries:entries.length,includedEntries:included.length,omittedEntries:entries.length-included.length,complete:included.length===entries.length,sourceHandle:`wiki/sources/${sourceId}`};
    }
    for(const entry of entries) {
      for(const entity of entry.entityKeys)add(`wiki/entities/${encodeURIComponent(entity)}`,entity,entry);
      for(const topic of entry.topicKeys)add(`wiki/concepts/${encodeURIComponent(topic)}`,topic,entry);
      for(const kind of entry.facetKinds) {
        if(['status','change','proposal','anomaly'].includes(kind)) {
          const subjects=entry.entityKeys.length?entry.entityKeys:[`source-${sourceId}`];
          for(const subject of subjects)add(`wiki/status/${encodeURIComponent(subject)}/${kind}`,`${kind}: ${subject}`,entry);
        }
        if(kind==='decision')add('wiki/decisions/decision-log','Decision log',entry);
        if(kind==='negative')add('wiki/facts/negative-facts','Negative facts',entry);
        if(kind==='constraint')add('wiki/facts/constraints','Constraints',entry);
      }
    }
  }
  for(const entry of facts) {
    for(const entity of entry.entityKeys)add(`wiki/entities/${encodeURIComponent(entity)}`,entity,entry);
    for(const topic of entry.topicKeys)add(`wiki/status/${encodeURIComponent(entry.entityKeys[0]??`source-${entry.sourceId}`)}/${encodeURIComponent(topic)}`,`Status: ${topic}`,entry);
    if(entry.facetKinds.includes('decision'))add('wiki/decisions/decision-log','Decision log',entry);
    if(entry.facetKinds.includes('negative'))add('wiki/facts/negative-facts','Negative facts',entry);
    if(entry.facetKinds.includes('constraint'))add('wiki/facts/constraints','Constraints',entry);
  }
  const bounded=new Map<string,WikiPage>();
  for(const [key,page] of [...pages].sort(([a],[b])=>compareText(a,b))) {
    page.entries.sort(entryOrder);
    let part=0,chars=0,entries:RoutingEntry[]=[];
    const flush=()=>{if(entries.length){bounded.set(part===0?key:`${key}/part-${String(part+1).padStart(4,'0')}`,{...page,entries});part++;entries=[];chars=0;}};
    for(const entry of page.entries){if(entries.length&&(entries.length>=64||chars+entry.text.length>16384))flush();entries.push(entry);chars+=entry.text.length;}flush();
  }
  return bounded;
}
type Parsed = { entity:string; predicate:string; object:JsonValue; polarity:1|-1; kind:FactRecord['assertionKind']; unit?:string; stateKey?:string; replace?:boolean; formula?:JsonValue; operandIndexes?:number[] };
export interface CompileResult { compilerVersion:string; wikiCompilerVersion:string; createdNodeIds:string[]; revisedNodeIds:string[]; unchangedNodeIds:string[]; retiredNodeIds:string[]; unprocessedSourceIds:string[]; namespaceId:string; sourceIds:string[]; nodeIds:string[]; deterministicOutputSha256:string; provenanceGaps:number }
export interface WikiLintResult { ok:boolean; provenanceGaps:number; issues:Array<{nodeId:string;code:string}> }
function decimalSubtract(a:string,b:string):string {
  const places=Math.max((a.split('.')[1]??'').length,(b.split('.')[1]??'').length);
  const integer=(x:string)=>BigInt(x.replace('.','')+'0'.repeat(places-(x.split('.')[1]??'').length));
  let result=(integer(a)-integer(b)).toString();
  if(!places)return result; const negative=result.startsWith('-'); if(negative)result=result.slice(1);
  result=result.padStart(places+1,'0');return (negative?'-':'')+result.slice(0,-places)+'.'+result.slice(-places);
}
/** Conservative versioned grammars. Unstructured prose stays extractive L0/L2. */
export function extractAssertions(text:string): Parsed[] {
  const line=text.trim(); const out:Parsed[]=[];
  if(line.startsWith('{')) {
    try {
      const value=JSON.parse(line);
      if(value.type==='fact'&&typeof value.entity==='string'&&typeof value.predicate==='string'&&'object' in value) {
        canonicalJson(value.object);
        out.push({entity:value.entity,predicate:value.predicate,object:value.object,polarity:value.polarity===-1?-1:1,kind:'explicit',unit:typeof value.unit==='string'?value.unit:undefined,stateKey:typeof value.stateKey==='string'?value.stateKey:undefined,replace:value.operation==='set'});
      }
    } catch { /* malformed/unsupported structured data stays source-only */ }
    return out;
  }
  const controlled=/^(Decision|Negative fact|Constraint|Concept|Fact|State|Correction):\s*(.+)$/i.exec(line);
  if(controlled) {
    const tag=controlled[1].toLowerCase(), body=controlled[2];
    const state=/^([^|=]+)\|\s*([^=]+)=\s*(.+)$/.exec(body);
    if(state) {
      const entity=state[1].trim(), predicate=state[2].trim();
      out.push({entity,predicate,object:state[3].trim(),polarity:tag==='negative fact'?-1:1,kind:'explicit',stateKey:['state','correction'].includes(tag)?`${entity}/${predicate}`:undefined,replace:['state','correction'].includes(tag)});
    } else out.push({entity:'record',predicate:tag.replaceAll(' ','_'),object:body,polarity:tag==='negative fact'?-1:1,kind:'explicit'});
    return out;
  }
  // A bare sequence of gram readings is a supported cumulative kitchen-scale grammar.
  const scale=/^(?:cumulative(?: kitchen)?(?: scale)?|scale)\s*:\s*/i.test(line);
  const readings=[...line.replace(/^(?:cumulative(?: kitchen)?(?: scale)?|scale)\s*:\s*/i,'').matchAll(/(?:^|,\s*)(\d+(?:\.\d+)?)\s*g\s+([^,]+)/g)];
  if((scale||readings.length>=2)&&readings.length>=2) {
    let previous='0';
    readings.forEach((r,index)=>{
      const totalIndex=out.length;
      out.push({entity:r[2].trim(),predicate:'cumulative_mass',object:{value:r[1],unit:'g',reported:r[0].replace(/^,\s*/, '')},polarity:1,kind:'parsed_measurement',unit:'g'});
      const net=decimalSubtract(r[1],previous);
      if(!net.startsWith('-'))out.push({entity:r[2].trim(),predicate:'net_mass',object:{value:net,unit:'g'},polarity:1,kind:'derived_calculation',unit:'g',formula:{op:'subtract',left:r[1],right:previous,rounding:'exact_decimal',baseline:index===0?'zero_tare':null},operandIndexes:index===0?[totalIndex]:[totalIndex,totalIndex-2]});
      previous=r[1];
    });return out;
  }
  const measurement=/^([\p{L}\p{N}_ .\/-]+?)\s*:\s*(-?\d+(?:\.\d+)?)\s*(g|kg|mg|ml|mL|L|kcal|cal|cm|mm|m|bpm|%|ms|s|°C|°F)\s*$/u.exec(line);
  if(measurement)out.push({entity:measurement[1].trim(),predicate:'measurement',object:{value:measurement[2],unit:measurement[3],reported:line},polarity:1,kind:'parsed_measurement',unit:measurement[3]});
  return out;
}

export class ContextForgeCompiler {
  readonly store:ContextForgeStore;
  constructor(store:ContextForgeStore) { this.store=store; }
  compile(namespaceId=this.store.namespaceId):CompileResult {
    this.store.assertNamespace(namespaceId,'write');
    return this.store.transaction(() => {
      const db=this.store.db;
      const collected=collectEvidence(this.store,namespaceId),evidence=collected.l1;
      const sourceIds=unique(collected.l2.map(e=>e.source_id));
      const before=db.prepare("SELECT node_id,logical_key FROM derived_nodes WHERE namespace_id=? AND layer IN (1,2) AND status='active'").all(namespaceId);
      const beforeIds=new Set(before.map(n=>String(n.node_id))),beforeKeys=new Set(before.map(n=>String(n.logical_key)));
      const made:DerivedNodeRecord[]=[];
      for(const e of evidence) {
        const assertions=extractAssertions(e.body), extracted:string[]=[];
        assertions.forEach((parsed,index)=>{
          const authoritative=['user_statement','owner_instruction'].includes(e.trust_class)&&!['machine_inferred','lossy'].includes(e.fidelity);
          const kind=authoritative?parsed.kind:'unresolved_candidate';
          const entityId=stableId('cf-entity-v1',namespaceId,parsed.entity);
          db.prepare('INSERT OR IGNORE INTO entities VALUES(?,?,?,?,?)').run(entityId,namespaceId,parsed.entity,parsed.entity,'[]');
          // A state update is explicit and must not let backfilled observations displace current state.
          const shared=parsed.stateKey&&parsed.replace&&authoritative;
          let key=shared?`state/${parsed.stateKey}`:`fact/${e.span_id}/${index}`;
          const existing=db.prepare("SELECT * FROM derived_nodes WHERE namespace_id=? AND logical_key=? AND status='active'").get(namespaceId,key);
          const currentSpan=shared&&existing?db.prepare(`SELECT p.source_id,p.artifact_id,p.byte_start FROM provenance v JOIN spans p USING(span_id) WHERE v.node_id=? ORDER BY p.source_id,p.artifact_id,p.byte_start DESC LIMIT 1`).get(existing.node_id):undefined;
          const older=existing&&(Number(existing.observed_at)>e.observed_at||(Number(existing.observed_at)===e.observed_at&&currentSpan&&(compareText(String(currentSpan.source_id),e.source_id)>0||(currentSpan.source_id===e.source_id&&(compareText(String(currentSpan.artifact_id),e.artifact_id)>0||(currentSpan.artifact_id===e.artifact_id&&Number(currentSpan.byte_start)>e.byte_start))))));
          if(shared&&existing&&older) {
            const prior=db.prepare('SELECT n.* FROM derived_nodes n JOIN provenance p USING(node_id) WHERE n.namespace_id=? AND n.logical_key=? AND p.span_id=? LIMIT 1').get(namespaceId,key,e.span_id);
            if(prior){extracted.push(prior.node_id as string);return;}
            key=`historical-state/${e.span_id}/${index}`;
          }
          const operands=(parsed.operandIndexes??[]).map(i=>extracted[i]).filter(Boolean);
          let formattedFactBody = e.body.trim();
          if (parsed.kind === 'derived_calculation' && parsed.object && typeof parsed.object === 'object' && !Array.isArray(parsed.object) && 'value' in parsed.object) {
            const val = String((parsed.object as Record<string, unknown>).value ?? '');
            const unit = String((parsed.object as Record<string, unknown>).unit ?? parsed.unit ?? '').trim();
            const fRec = parsed.formula && typeof parsed.formula === 'object' && !Array.isArray(parsed.formula) ? (parsed.formula as Record<string, unknown>) : null;
            const calcStr = fRec && fRec.left && fRec.right ? ` (calculated: ${fRec.left} - ${fRec.right} = ${val}${unit ? ' ' + unit : ''})` : '';
            formattedFactBody = `${parsed.entity} ${parsed.predicate} (net added amount) = ${val}${unit ? ' ' + unit : ''}${calcStr}`;
          } else if (parsed.kind === 'parsed_measurement' && parsed.object && typeof parsed.object === 'object' && !Array.isArray(parsed.object) && 'value' in parsed.object) {
            const val = String((parsed.object as Record<string, unknown>).value ?? '');
            const unit = String((parsed.object as Record<string, unknown>).unit ?? parsed.unit ?? '').trim();
            formattedFactBody = `${parsed.entity} ${parsed.predicate} = ${val}${unit ? ' ' + unit : ''}`;
          }
          const node=this.store.publishNode({namespaceId,layer:1,logicalKey:key,kind:parsed.predicate,title:`${parsed.entity}: ${parsed.predicate}`,body:formattedFactBody,canonical:{entity:parsed.entity,predicate:parsed.predicate,object:parsed.object,polarity:parsed.polarity,assertionKind:kind,formula:parsed.formula??null,inputFactIds:operands,authority:e.trust_class},compilerVersion:COMPILER_VERSION,observedAt:e.observed_at,spanIds:[e.span_id],dependencyNodeIds:operands,extractionRule:'controlled-grammar-v1'});
          db.prepare('INSERT OR IGNORE INTO facts VALUES(?,?,?,?,?,?,?,?,?,?)').run(node.nodeId,entityId,parsed.predicate,canonicalJson(parsed.object),parsed.polarity,kind,parsed.unit??null,parsed.stateKey??null,e.trust_class,kind==='unresolved_candidate'?null:1);
          extracted.push(node.nodeId); made.push(node);
        });
      }
      const facts=db.prepare(`SELECT n.*,f.entity_id,f.predicate,f.polarity,f.assertion_kind,e.display_name,e.entity_key FROM derived_nodes n JOIN facts f USING(node_id) LEFT JOIN entities e USING(entity_id) WHERE n.namespace_id=? AND n.status='active' ORDER BY n.observed_at,n.node_id`).all(namespaceId);
      const factEntries:RoutingEntry[]=[];
      for(const f of facts) {
        const provenance=this.store.getProvenance(String(f.node_id));
        if(!provenance.length)continue;
        const primary=provenance[0],source=this.store.getSource(primary.sourceId)!;
        const body=(f.assertion_kind==='unresolved_candidate'?'Unresolved candidate: ':'')+String(f.body);
        const facets=extractRoutingFacets(body);
        factEntries.push({textKind:'derived',entryId:stableId('cf-wiki-fact-entry-v2',f.node_id,body),text:body,spanIds:provenance.map(p=>p.spanId),dependencyNodeIds:[String(f.node_id)],
          entityKeys:unique([...facets.entityKeys,...(f.entity_key==='record'?[]:[routingKey(String(f.entity_key))])]),topicKeys:unique([...facets.topicKeys,routingKey(String(f.predicate))]),
          facetKinds:unique([...facets.facetKinds,...(f.polarity===-1?['negative']:[]),...(['decision','constraint','concept'].includes(String(f.predicate))?[String(f.predicate)]:[])]),
          ordinal:collected.l2.find(e=>e.span_id===primary.spanId)?.ordinal??0,observedAt:Number(f.observed_at),sourceId:primary.sourceId,artifactId:primary.artifactId,trustClass:source.trustClass,
          fidelity:String(db.prepare('SELECT fidelity FROM artifacts WHERE artifact_id=?').get(primary.artifactId)!.fidelity),
          spans:provenance.map(p=>({spanId:p.spanId,sourceId:p.sourceId,artifactId:p.artifactId,byteStart:p.byteStart!,byteEnd:p.byteEnd!}))});
      }
      // Old stores can contain a whole long line in one chunk. Keep collection
      // and L1 extraction unchanged, but give L2 exact, bounded UTF-8 subspans.
      // These are routing excerpts, not a truncated claim or a replacement for
      // the original immutable chunk. Fresh bounded chunks retain their IDs.
      const routingEvidence:Evidence[]=[];
      const ordinals=new Map<string,number>();
      for(const row of collected.l2) {
        const bytes=Buffer.from(row.body);
        for(let start=0;start<bytes.length;) {
          let end=Math.min(bytes.length,start+2048);
          while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
          const ordinal=ordinals.get(row.source_id)??0;ordinals.set(row.source_id,ordinal+1);
          routingEvidence.push({...row,ordinal,body:bytes.subarray(start,end).toString('utf8'),byte_start:row.byte_start+start,byte_end:row.byte_start+end,
            span_id:start===0&&end===bytes.length?row.span_id:this.store.createSpan(row.source_id,row.artifact_id,row.byte_start+start,row.byte_start+end)});
          start=end;
        }
      }
      const pages=buildWikiPages(routingEvidence,factEntries);
      for(const [key,p] of pages) {
        const deps=unique(p.entries.flatMap(e=>e.dependencyNodeIds)),spans=unique(p.entries.flatMap(e=>e.spanIds));
        // Citation-looking original bytes are data, not a way to forge a compiler reference.
        const render=(text:string)=>text.replace(/\[span:([a-f0-9]{64})\]/g,'[ref-span:$1]');
        made.push(this.store.publishNode({namespaceId,layer:2,logicalKey:key,kind:'wiki',title:p.title,
          body:p.entries.map(e=>`${render(e.text)} ${e.spanIds.map(s=>`[span:${s}]`).join(' ')}`).join('\n'),
          canonical:{template:WIKI_COMPILER_VERSION,entries:p.entries as unknown as JsonValue,dependencies:deps,...(p.omission?{omission:p.omission}:{})},
          compilerVersion:WIKI_COMPILER_VERSION,observedAt:p.observed,spanIds:spans,dependencyNodeIds:deps,extractionRule:WIKI_COMPILER_VERSION}));
      }
      const retiredNodeIds:string[]=[];
      // Do not touch hand-published wiki pages, L3, or arbitrary dependent keyspaces.
      const obsolete=db.prepare("SELECT * FROM derived_nodes WHERE namespace_id=? AND layer=2 AND kind='wiki' AND status='active' ORDER BY logical_key,node_id").all(namespaceId);
      for(const node of obsolete) {
        const template=JSON.parse(String(node.canonical_json)).template;
        if(!String(node.logical_key).startsWith('wiki/')||![COMPILER_VERSION,WIKI_COMPILER_VERSION].includes(String(node.compiler_version))||!['extractive-v1',WIKI_COMPILER_VERSION].includes(template)||pages.has(String(node.logical_key)))continue;
        const cause=collected.l2[0]?.span_id??this.store.getProvenance(String(node.node_id))[0]?.spanId;
        if(!cause)throw new Error('Compiler page retirement requires a source span');
        db.prepare("UPDATE derived_nodes SET status='withdrawn' WHERE node_id=? AND status='active'").run(node.node_id);
        db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(stableId('cf-wiki-retirement-v2',node.node_id),namespaceId,null,node.node_id,'active','withdrawn',cause,Date.now(),'compiler','obsolete compiler-owned wiki partition');
        retiredNodeIds.push(String(node.node_id));
      }
      const nodes=db.prepare("SELECT node_id,content_sha256 FROM derived_nodes WHERE namespace_id=? AND layer IN (1,2) AND status='active' ORDER BY node_id").all(namespaceId);
      const manifest=canonicalJson(nodes.map(r=>({nodeId:r.node_id,sha256:r.content_sha256}))), hash=sha256(manifest);
      const jobs=db.prepare("SELECT * FROM compile_jobs WHERE source_id IN (SELECT source_id FROM sources WHERE namespace_id=?) AND state IN ('queued','leased') ORDER BY job_id").all(namespaceId);
      const createdNodeIds=unique(made.filter(n=>!beforeIds.has(n.nodeId)&&!beforeKeys.has(n.logicalKey)).map(n=>n.nodeId));
      const revisedNodeIds=unique(made.filter(n=>!beforeIds.has(n.nodeId)&&beforeKeys.has(n.logicalKey)).map(n=>n.nodeId));
      const unchangedNodeIds=unique(made.filter(n=>beforeIds.has(n.nodeId)).map(n=>n.nodeId));
      const activeSourceIds=db.prepare("SELECT s.source_id FROM sources s JOIN source_lifecycle l USING(source_id) WHERE s.namespace_id=? AND l.status='active' ORDER BY s.source_id").all(namespaceId).map(s=>String(s.source_id));
      const unprocessedSourceIds=activeSourceIds.filter(id=>!sourceIds.includes(id));
      const changed=createdNodeIds.length+revisedNodeIds.length+retiredNodeIds.length>0;
      const generation=changed?this.store.bumpGeneration(namespaceId):Number(db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(namespaceId)!.generation);
      // An L2-only upgrade also receives an immutable receipt even when every L1 job was already done.
      const receiptJobs=jobs.length?jobs:changed?db.prepare("SELECT * FROM compile_jobs WHERE source_id IN (SELECT source_id FROM sources WHERE namespace_id=?) AND state='done' ORDER BY job_id LIMIT 1").all(namespaceId):[];
      for(const job of receiptJobs) {
        db.prepare('INSERT OR IGNORE INTO compile_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(stableId('cf-receipt-v1',job.job_id,hash),job.job_id,namespaceId,job.input_sha256,COMPILER_VERSION,manifest,canonicalJson({sourceCount:sourceIds.length,parser:'controlled-grammar-v1',compilerVersion:COMPILER_VERSION,wikiCompilerVersion:WIKI_COMPILER_VERSION,createdNodeIds,revisedNodeIds,unchangedNodeIds,retiredNodeIds,unprocessedSourceIds}),generation,Date.now());
        if(job.state!=='done')db.prepare("UPDATE compile_jobs SET state='done',lease_until=NULL WHERE job_id=?").run(job.job_id);
      }
      const lint=this.lintWiki(namespaceId);if(!lint.ok)throw new Error('Compiler provenance validation failed: '+canonicalJson(lint.issues));
      return {compilerVersion:COMPILER_VERSION,wikiCompilerVersion:WIKI_COMPILER_VERSION,createdNodeIds,revisedNodeIds,unchangedNodeIds,retiredNodeIds,unprocessedSourceIds,namespaceId,sourceIds,nodeIds:nodes.map(r=>r.node_id as string),deterministicOutputSha256:hash,provenanceGaps:lint.provenanceGaps};
    });
  }
  compilePending(namespaceId=this.store.namespaceId):CompileResult { return this.compile(namespaceId); }
  compileSource(sourceId:string):CompileResult { const source=this.store.getSource(sourceId);if(!source)throw new Error('Unknown source');return this.compile(source.namespaceId); }
  lintWiki(namespaceId=this.store.namespaceId):WikiLintResult {
    this.store.assertNamespace(namespaceId);const issues:WikiLintResult['issues']=[];
    const nodes=this.store.db.prepare("SELECT * FROM derived_nodes WHERE namespace_id=? AND status='active'").all(namespaceId);
    const blobCache=new Map<string,Buffer>();
    for(const node of nodes) {
      const provenance=this.store.getProvenance(node.node_id as string);
      if(!provenance.length)issues.push({nodeId:node.node_id as string,code:'missing_provenance'});
      for(const p of provenance) {
        const row=this.store.db.prepare('SELECT s.namespace_id,l.status,a.blob_sha256,sp.quote_sha256 FROM spans sp JOIN sources s USING(source_id) JOIN source_lifecycle l USING(source_id) JOIN artifacts a USING(artifact_id) WHERE sp.span_id=?').get(p.spanId)!;
        if(row.namespace_id!==namespaceId||row.status!=='active')issues.push({nodeId:node.node_id as string,code:'invalid_source'});
        try {
          const sha=row.blob_sha256 as string;
          let bytes=blobCache.get(sha);
          if(!bytes){bytes=this.store.readBlob(sha);blobCache.set(sha,bytes);}
          if(p.byteStart!==null&&sha256(bytes.subarray(p.byteStart,p.byteEnd!))!==row.quote_sha256)throw new Error();
        }
        catch {issues.push({nodeId:node.node_id as string,code:'quote_hash_mismatch'});}
      }
      if(node.layer===2) {
        let canonical:any;
        try{canonical=JSON.parse(String(node.canonical_json));}catch{issues.push({nodeId:String(node.node_id),code:'invalid_canonical'});}
        if(canonical?.template===WIKI_COMPILER_VERSION) {
          const issue=(code:string)=>issues.push({nodeId:String(node.node_id),code});
          const pageSpans=new Set(provenance.map(p=>p.spanId)),seen=new Set<string>(),entrySpans=new Set<string>(),entryDeps=new Set<string>();
          if(node.compiler_version!==WIKI_COMPILER_VERSION)issue('invalid_wiki_version');
          if(!Array.isArray(canonical.entries)||!canonical.entries.length)issue('missing_entries');
          else {
            for(const entry of canonical.entries) {
              if(!entry||typeof entry.entryId!=='string'||seen.has(entry.entryId)||typeof entry.text!=='string'||!Array.isArray(entry.spanIds)||!entry.spanIds.length||!Array.isArray(entry.spans)||!Array.isArray(entry.dependencyNodeIds)) {issue('invalid_entry');continue;}
              seen.add(entry.entryId);
              if(!Number.isSafeInteger(entry.ordinal)||entry.ordinal<0||!['extractive','derived'].includes(entry.textKind)||typeof entry.trustClass!=='string'||typeof entry.fidelity!=='string')issue('invalid_entry_metadata');
              if(!entry.spans.some((span:any)=>span.sourceId===entry.sourceId&&span.artifactId===entry.artifactId))issue('entry_source_mismatch');
              for(const spanId of entry.spanIds){entrySpans.add(spanId);if(!pageSpans.has(spanId))issue('entry_unlinked_span');}
              const exactParts:Buffer[]=[];
              for(const span of entry.spans) {
                const p=provenance.find(p=>p.spanId===span.spanId);
                if(!p||!entry.spanIds.includes(span.spanId)||p.sourceId!==span.sourceId||p.artifactId!==span.artifactId||p.byteStart!==span.byteStart||p.byteEnd!==span.byteEnd){issue('entry_span_mismatch');continue;}
                const artifact=this.store.db.prepare('SELECT blob_sha256,fidelity FROM artifacts WHERE artifact_id=?').get(p.artifactId)!;
                const source=this.store.getSource(p.sourceId);
                if(entry.textKind==='extractive'&&(entry.sourceId!==p.sourceId||entry.artifactId!==p.artifactId||entry.trustClass!==source?.trustClass||entry.fidelity!==artifact.fidelity))issue('entry_authority_mismatch');
                try {
                  const sha=String(artifact.blob_sha256);let bytes=blobCache.get(sha);if(!bytes){bytes=this.store.readBlob(sha);blobCache.set(sha,bytes);}
                  const index=entry.spans.indexOf(span),previous=entry.spans[index-1];if(previous&&!(previous.artifactId===span.artifactId&&previous.byteEnd===span.byteStart))exactParts.push(Buffer.from('\n[noncontiguous excerpt]\n'));
                  exactParts.push(bytes.subarray(p.byteStart!,p.byteEnd!));
                }catch{issue('quote_hash_mismatch');}
              }
              if(unique(entry.spans.map((s:any)=>String(s.spanId))).join(',')!==unique(entry.spanIds).join(','))issue('entry_span_mismatch');
              if(entry.textKind==='extractive') {
                if(Buffer.concat(exactParts).toString('utf8')!==entry.text)issue('entry_quote_mismatch');
                if(entry.entryId!==stableId('cf-wiki-entry-v2',entry.sourceId,entry.spans.map((s:any)=>s.spanId),entry.text))issue('entry_id_mismatch');
              } else if(!entry.dependencyNodeIds.length)issue('derived_entry_missing_dependency');
              for(const id of entry.dependencyNodeIds) {
                entryDeps.add(id);
                const dependency=this.store.db.prepare('SELECT namespace_id,status FROM derived_nodes WHERE node_id=?').get(id);
                if(!dependency||dependency.namespace_id!==namespaceId||dependency.status!=='active')issue('invalid_entry_dependency');
                else {
                  const support=new Set(this.store.getProvenance(id).map(p=>p.spanId));
                  if(!entry.spanIds.some((id:string)=>support.has(id))||(entry.textKind==='derived'&&[...support].some(id=>!entry.spanIds.includes(id))))issue('entry_dependency_unlinked');
                }
              }
            }
            if([...pageSpans].some(id=>!entrySpans.has(id)))issue('unmapped_page_provenance');
            const expected=canonical.entries.filter((e:any)=>e&&typeof e.text==='string'&&Array.isArray(e.spanIds)).map((e:any)=>`${e.text.replace(/\[span:([a-f0-9]{64})\]/g,'[ref-span:$1]')} ${e.spanIds.map((id:string)=>`[span:${id}]`).join(' ')}`).join('\n');
            if(expected!==node.body)issue('unmapped_page_text');
          }
          if(!Array.isArray(canonical.dependencies)||unique(canonical.dependencies).join(',')!==unique([...entryDeps]).join(','))issue('invalid_page_dependencies');
          const edges=this.store.db.prepare("SELECT parent_node_id FROM derivation_edges WHERE child_node_id=? AND relation IN ('compiles','depends_on') ORDER BY parent_node_id").all(node.node_id).map(r=>String(r.parent_node_id));
          if(unique(edges).join(',')!==unique([...entryDeps]).join(','))issue('invalid_dependency_edges');
          if(canonical.omission) {
            const o=canonical.omission;
            if(!Number.isSafeInteger(o.totalEntries)||!Number.isSafeInteger(o.includedEntries)||!Number.isSafeInteger(o.omittedEntries)||o.omittedEntries<0||o.includedEntries<0||o.totalEntries!==o.includedEntries+o.omittedEntries||o.includedEntries!==(canonical.entries?.length??0)||o.complete!==(o.omittedEntries===0)||typeof o.sourceHandle!=='string'||!o.sourceHandle.startsWith('wiki/sources/'))issue('invalid_omission_metadata');
            else {
              const fallback=this.store.db.prepare("SELECT namespace_id FROM derived_nodes WHERE namespace_id=? AND logical_key=? AND layer=2 AND status='active'").get(namespaceId,o.sourceHandle);
              if(!fallback)issue('missing_source_fallback');
            }
          }
        }
      }
      if(node.layer===2)for(const match of String(node.body).matchAll(/\[span:([a-f0-9]{64})\]/g))if(!provenance.some(p=>p.spanId===match[1]))issues.push({nodeId:node.node_id as string,code:'unlinked_citation'});
    }
    return {ok:issues.length===0,provenanceGaps:issues.filter(i=>['missing_provenance','invalid_source','unlinked_citation','quote_hash_mismatch','entry_unlinked_span','entry_span_mismatch','entry_quote_mismatch','entry_authority_mismatch','entry_source_mismatch','entry_dependency_unlinked','invalid_entry_dependency','unmapped_page_provenance','unmapped_page_text'].includes(i.code)).length,issues};
  }
}
export function lintWiki(store:ContextForgeStore,namespaceId=store.namespaceId):WikiLintResult { return new ContextForgeCompiler(store).lintWiki(namespaceId); }
