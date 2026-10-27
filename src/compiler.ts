import { ContextForgeStore, COMPILER_VERSION, canonicalJson, nodeRecord, sha256, stableId } from './store.ts';
import type { DerivedNodeRecord, FactRecord, JsonValue } from './types.ts';

type Evidence = { source_id:string; span_id:string; body:string; observed_at:number; trust_class:string; fidelity:string; namespace_id:string };
type Parsed = { entity:string; predicate:string; object:JsonValue; polarity:1|-1; kind:FactRecord['assertionKind']; unit?:string; stateKey?:string; replace?:boolean; formula?:JsonValue; operandIndexes?:number[] };
export interface CompileResult { compilerVersion:string; namespaceId:string; sourceIds:string[]; nodeIds:string[]; deterministicOutputSha256:string; provenanceGaps:number }
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
      const evidence=db.prepare(`SELECT s.source_id,s.namespace_id,s.observed_at,s.trust_class,c.span_id,c.body,a.fidelity FROM chunks c JOIN spans p USING(span_id) JOIN artifacts a USING(artifact_id) JOIN sources s ON s.source_id=p.source_id JOIN source_lifecycle l ON l.source_id=s.source_id WHERE s.namespace_id=? AND l.status='active' AND a.kind<>'normalized_message' AND s.kind<>'tool_result' ORDER BY s.observed_at,s.source_id,c.ordinal,c.chunk_id`).all(namespaceId) as Evidence[];
      const sourceIds=[...new Set(evidence.map(e=>e.source_id))].sort();
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
          if(shared&&existing&&Number(existing.observed_at)>e.observed_at) {
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
      const pages=new Map<string,{title:string;lines:Map<string,string>;spans:Set<string>;deps:Set<string>;observed:number}>();
      const add=(key:string,title:string,rawBody:string,spanIds:string[],deps:string[],observed:number)=>{
        const body=rawBody.replace(/\[span:([a-f0-9]{64})\]/g,'[ref-span:$1]');
        let page=pages.get(key);if(!page){page={title,lines:new Map(),spans:new Set(),deps:new Set(),observed};pages.set(key,page);}
        const citation=spanIds.map(s=>`[span:${s}]`).join(' '); page.lines.set(stableId('cf-wiki-line-v1',body,spanIds),`${body} ${citation}`);
        spanIds.forEach(s=>page!.spans.add(s));deps.forEach(s=>page!.deps.add(s));page.observed=Math.max(page.observed,observed);
      };
      for(const e of evidence) {
        add(`wiki/sources/${e.source_id}`,`Source ${e.source_id}`,e.body.trim(),[e.span_id],[],e.observed_at);
        add(`wiki/timeline/${new Date(e.observed_at).toISOString().slice(0,10)}`,'Timeline',e.body.trim(),[e.span_id],[],e.observed_at);
        for(const heading of e.body.matchAll(/^#+\s+(.+)$/gm))add(`wiki/concepts/${encodeURIComponent(heading[1].trim())}`,heading[1].trim(),e.body.trim(),[e.span_id],[],e.observed_at);
      }
      for(const f of facts) {
        const spans=this.store.getProvenance(f.node_id as string).map(p=>p.spanId), body=(f.assertion_kind==='unresolved_candidate'?'Unresolved candidate: ':'')+String(f.body);
        add(`wiki/entities/${f.entity_id}`,String(f.display_name),body,spans,[f.node_id as string],Number(f.observed_at));
        if(f.assertion_kind==='unresolved_candidate')continue;
        if(f.predicate==='decision')add('wiki/decisions/decision-log','Decision log',body,spans,[f.node_id as string],Number(f.observed_at));
        if(f.polarity===-1)add('wiki/facts/negative-facts','Negative facts',body,spans,[f.node_id as string],Number(f.observed_at));
        if(f.predicate==='constraint')add('wiki/facts/constraints','Constraints',body,spans,[f.node_id as string],Number(f.observed_at));
        if(f.predicate==='concept')add(`wiki/concepts/${encodeURIComponent(String(f.body))}`,'Concept',body,spans,[f.node_id as string],Number(f.observed_at));
        add(`wiki/status/${f.entity_id}/${encodeURIComponent(String(f.predicate))}`,'Status: '+f.display_name,body,spans,[f.node_id as string],Number(f.observed_at));
      }
      for(const [key,p] of [...pages].sort(([a],[b])=>a.localeCompare(b))) {
        made.push(this.store.publishNode({namespaceId,layer:2,logicalKey:key,kind:'wiki',title:p.title,body:[...p.lines].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v).join('\n'),canonical:{template:'extractive-v1',dependencies:[...p.deps].sort()},compilerVersion:COMPILER_VERSION,observedAt:p.observed,spanIds:[...p.spans],dependencyNodeIds:[...p.deps],extractionRule:'extractive-wiki-v1'}));
      }
      const nodes=db.prepare("SELECT node_id,content_sha256 FROM derived_nodes WHERE namespace_id=? AND layer IN (1,2) AND status='active' ORDER BY node_id").all(namespaceId);
      const manifest=canonicalJson(nodes.map(r=>({nodeId:r.node_id,sha256:r.content_sha256}))), hash=sha256(manifest);
      const jobs=db.prepare("SELECT * FROM compile_jobs WHERE source_id IN (SELECT source_id FROM sources WHERE namespace_id=?) AND state IN ('queued','leased') ORDER BY job_id").all(namespaceId);
      const generation=jobs.length?this.store.bumpGeneration(namespaceId):Number(db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(namespaceId)!.generation);
      for(const job of jobs) {
        db.prepare('INSERT INTO compile_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(stableId('cf-receipt-v1',job.job_id,hash),job.job_id,namespaceId,job.input_sha256,COMPILER_VERSION,manifest,canonicalJson({sourceCount:sourceIds.length,parser:'controlled-grammar-v1'}),generation,Date.now());
        db.prepare("UPDATE compile_jobs SET state='done',lease_until=NULL WHERE job_id=?").run(job.job_id);
      }
      const lint=this.lintWiki(namespaceId);if(!lint.ok)throw new Error('Compiler provenance validation failed: '+canonicalJson(lint.issues));
      return {compilerVersion:COMPILER_VERSION,namespaceId,sourceIds,nodeIds:nodes.map(r=>r.node_id as string),deterministicOutputSha256:hash,provenanceGaps:lint.provenanceGaps};
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
      if(node.layer===2)for(const match of String(node.body).matchAll(/\[span:([a-f0-9]{64})\]/g))if(!provenance.some(p=>p.spanId===match[1]))issues.push({nodeId:node.node_id as string,code:'unlinked_citation'});
    }
    return {ok:issues.length===0,provenanceGaps:issues.filter(i=>['missing_provenance','invalid_source','unlinked_citation','quote_hash_mismatch'].includes(i.code)).length,issues};
  }
}
export function lintWiki(store:ContextForgeStore,namespaceId=store.namespaceId):WikiLintResult { return new ContextForgeCompiler(store).lintWiki(namespaceId); }
