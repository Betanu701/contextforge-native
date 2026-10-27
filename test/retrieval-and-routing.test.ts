import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore, sha256, canonicalJson, createStoreReadBudget } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { analyzeRecallQuery, tokenizeRecallText, buildFtsQuery, isTrivialPhatic, scoreFacetCoverage } from '../src/retrieval.ts';
import { planContext, expandRelatedPremises } from '../src/planner.ts';
const runtime=JSON.parse(readFileSync(new URL('./fixtures/evidence-runtime.json',import.meta.url),'utf8'));
const oracles=JSON.parse(readFileSync(new URL('./fixtures/evidence-oracles.json',import.meta.url),'utf8'));
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-routing-'));const store=new ContextForgeStore(join(dir,'db.sqlite'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
let admission=0;
function plan(store:ContextForgeStore,query:string,extra:any={}){return planContext({store,query,sessionId:'test',admissionId:String(admission++),rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:64000,hostTokenBudget:64000,hostBudgetScope:'history_only',input:['text']},...extra});}
function text(p:any){return p.messages.map((m:any)=>typeof m.content==='string'?m.content:m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')).join('\n');}

test('1 shared tokenizer retains identifier, decimal, camel and snake witnesses and safe FTS syntax',()=>{
 for(const [input,expected] of [['RFC-38',['rfc-38','rfc38','rfc','38']],['RFC38_adopted',['rfc38_adopted','rfc38','38','adopted']],['RFC-K72',['rfc-k72','rfck72','rfc','k72','72']],['node-T9',['node-t9','nodet9','node','t9','9']],['quorum-5',['quorum-5','quorum5','quorum','5']],['AX-731',['ax-731','ax731','ax','731']],['vz_8Q-04a-Z9',['vz_8q-04a-z9','vz8q04az9','vz','8q','04a','z9']],['safeDepthM',['safedepthm','safe','depth','m','safe depth']],['minimum_safe_depth_m',['minimum','safe','depth','m','safe depth']],['async_batch_flush_allowed_with_WAL',['async','batch','flush','allowed','wal','async batch flush']],['23.8',['23.8']],['83',['83']],['Aru',['aru']]] as any)for(const e of expected)assert.ok(tokenizeRecallText(input).includes(e),input+' '+e);
 const q=analyzeRecallQuery('Pela probe? Return the answer object with fields: sample, fault_code');assert.deepEqual(q.substantiveTerms,['pela','probe']);assert.ok(q.facets.filter(f=>f.origin==='output_schema').every(f=>f.weight<1));assert.doesNotThrow(()=>buildFtsQuery('" OR * NEAR(test)'));
});

test('2 all 32 frozen development cases deliver every original support group and no unrelated source',()=>{
 for(const v of runtime.variants){const f=fixture();try{const ids=v.docs.map((d:any)=>f.store.ingestSource({originKey:d.key,text:d.text,kind:d.kind,role:d.role,observedAt:d.observedAt}).sourceId);new ContextForgeCompiler(f.store).compile();let delayed=false;
 for(const c of v.cases){if(c.phase==='delayed'&&!delayed){for(const d of v.delay)f.store.ingestSource({originKey:d.key,text:d.text,kind:d.kind,role:d.role,observedAt:d.observedAt});delayed=true;}
 const p=plan(f.store,c.question),wire=text(p),oracle=oracles[c.id],allowed=oracle.docIndices.map((i:number)=>ids[i]);for(const group of oracle.supportGroups)assert.ok(group.some((s:string)=>wire.includes(s)),c.id+' missing '+group);assert.deepEqual(new Set(p.receipt.selections.map(s=>s.sourceId)),new Set(allowed),c.id);for(const s of p.receipt.selections)for(const span of s.provenanceSpanIds)assert.equal(f.store.readEvidenceSpan(span).sourceId,s.sourceId);
 }}finally{f.clean();}}
});

test('3 derived routing hydrates exact support without lexical overlap and excludes unrelated omnibus entries',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'raw',text:'The instrument was sealed by the night operator.'}),u=f.store.ingestSource({originKey:'unrelated',text:'Unrelated mango receipt.'});const p=f.store.getEvidenceChunks(s.sourceId)[0],up=f.store.getEvidenceChunks(u.sourceId)[0];
 f.store.publishNode({namespaceId:f.store.namespaceId,layer:2,logicalKey:'wiki/topics/route',kind:'wiki',title:'Zircon handoff',body:'Zircon handoff\nUnrelated mango',canonical:{entries:[{entryId:'selected',text:'Zircon handoff',spanIds:[p.spanId],dependencyNodeIds:[],entityKeys:['Zircon']},{entryId:'excluded',text:'Unrelated mango',spanIds:[up.spanId],dependencyNodeIds:[],entityKeys:['mango']}]},compilerVersion:'test',observedAt:1,spanIds:[p.spanId,up.spanId],extractionRule:'test'});
 const result=plan(f.store,'Zircon handoff');assert.match(text(result),/instrument was sealed/);assert.doesNotMatch(text(result),/mango receipt/);assert.ok(result.receipt.selections.some(s=>s.reasons.includes('provenance_support')));
 }finally{f.clean();}});

test('4 bulky Unicode tool anomaly works before compiler and exposes exact bounded spans',()=>{const f=fixture();try{const doc=runtime.variants[0].docs.find((d:any)=>d.family==='buried_tool_anomaly');const s=f.store.ingestSource({originKey:'telemetry',kind:'tool_result',role:'tool',text:'λΔ source qualification\n'+doc.text});const result=plan(f.store,'Identify Pela anomalous sample, fault_code and correction');assert.ok(text(result).includes('sample=83 subsystem=pelameter status=anomaly fault_code=AX-731 correction=quarantine'));assert.match(text(result),/No other sample/);assert.ok(result.estimatedTokens<2200);for(const sel of result.receipt.selections){assert.equal(sel.sourceId,s.sourceId);for(const id of sel.provenanceSpanIds){const p=f.store.readEvidenceSpan(id);assert.equal(sha256(p.bytes),sha256(Buffer.from(p.text)));}}}finally{f.clean();}});

test('5 premise groups preserve narrow correction, rejection, table roles, exceptions and calculation',()=>{const f=fixture();try{for(const d of runtime.variants[1].docs)f.store.ingestSource({originKey:d.key,text:d.text,kind:d.kind,role:d.role,observedAt:d.observedAt});new ContextForgeCompiler(f.store).compile();for(const family of ['partial_supersession','rejected_proposal','table_attribution','condition_exception','cumulative_math']){const c=runtime.variants[1].cases.find((c:any)=>c.family===family);const p=plan(f.store,c.question);for(const group of oracles[c.id].supportGroups)assert.ok(group.some((s:string)=>text(p).includes(s)));}}finally{f.clean();}});

test('6 stopword/schema dilution adversary cannot fill a roomy context',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'real',text:'Jadra probe anomaly sample=73 fault_code=ZR-412 correction=isolate.'});for(let i=0;i<8;i++)f.store.ingestSource({originKey:'noise-'+i,text:'the for with not and return object fields sample=73 fault_code=none correction=none launch_date=unknown'});const p=plan(f.store,'Identify Jadra probe anomaly. Return the answer object with fields: sample, fault_code, correction');assert.deepEqual([...new Set(p.receipt.selections.map(s=>s.sourceId))],[s.sourceId]);}finally{f.clean();}});

test('7 renamed and reordered unseen cases transfer without fixture mappings',()=>{for(const reverse of [false,true]){const f=fixture();try{const docs=[{originKey:'old',text:'Halden release 1 sets worker_id=node-U6 and retry_mode=quorum-9.',observedAt:1},{originKey:'new',text:'Halden release 2 changes only worker_id=node-P4; retry_mode=quorum-9 is unchanged.',observedAt:2}];for(const d of reverse?docs.reverse():docs)f.store.ingestSource(d);f.store.ingestSource({originKey:'noise',text:'Mervin launch_date absent; keeper unknown.'});new ContextForgeCompiler(f.store).compile();const p=plan(f.store,'What worker_id and retry_mode apply to Halden after release 2?');assert.match(text(p),/node-P4/);assert.match(text(p),/quorum-9/);assert.equal(new Set(p.receipt.selections.map(s=>s.sourceId)).size,2);}finally{f.clean();}}});

test('8 graph is direction-aware, one-hop, cycle-deduplicated and excludes generic hubs/withdrawn support',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'graph',text:'Distinct original premise.'});const span=f.store.getEvidenceChunks(s.sourceId)[0].spanId;const make=(key:string,deps:string[]=[])=>f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:key,kind:'fact',title:key,body:key,canonical:{entity:'record'},compilerVersion:'test',observedAt:1,spanIds:[span],dependencyNodeIds:deps,extractionRule:'test'});const a=make('Alpha'),b=make('Beta',[a.nodeId]),c=make('Gamma',[b.nodeId]),d=make('Delta');const related=f.store.getRelatedNodes([a.nodeId]);assert.deepEqual(related.map(r=>r.node.nodeId),[b.nodeId]);assert.equal(related[0].direction,'outgoing');assert.ok(!related.some(r=>r.node.nodeId===c.nodeId||r.node.nodeId===d.nodeId));f.store.db.prepare('INSERT INTO derivation_edges VALUES(?,?,?)').run(b.nodeId,a.nodeId,'contradicts');assert.ok(expandRelatedPremises(f.store,[a.nodeId],analyzeRecallQuery('Alpha')).some(r=>r.relation==='contradicts'));f.store.withdrawSource(s.sourceId);assert.deepEqual(f.store.getRelatedNodes([a.nodeId]),[]);assert.throws(()=>f.store.readEvidenceSpan(span),/Unavailable/);}finally{f.clean();}});

test('9 corrected source/span result, pre-limit layer quotas, aliases, rebuild and empty origin safety',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'',text:'Fact: CedarDB | safeDepthM = 23.8\nRFC38_adopted is false'});new ContextForgeCompiler(f.store).compile();assert.ok(f.store.search('safe_depth_m',{layers:[0]}).every(h=>h.sourceId===s.sourceId&&h.spanId&&h.artifactId));assert.ok(f.store.search('CedarDB',{layers:[2],limit:1}).every(h=>h.layer===2));assert.ok(f.store.search('RFC-38').length);const first=f.store.rebuildRecallProjection();const second=f.store.rebuildRecallProjection();assert.equal(second.updated,0);assert.equal(plan(f.store,'Unrelated unrelated').receipt.selections.length,0);assert.throws(()=>f.store.search('x',{namespaceId:'denied'}),/denied/);}finally{f.clean();}});

test('10 tight admission and deadline never claim successful required support',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'explicit',text:'Source qualification. '.repeat(400)});const p=plan(f.store,'Read explicit',{sourceIds:[s.sourceId],envelope:{nativeContextTokens:64000,hostTokenBudget:100,hostBudgetScope:'history_only',input:['text']}});assert.notEqual(p.receipt.disposition,'admitted');assert.ok(p.receipt.demand.obligations.some(o=>o.status!=='satisfied'));const deadline=plan(f.store,'explicit',{deadlineAt:0});assert.equal(deadline.receipt.stopReason,'retrieval_deadline');}finally{f.clean();}});

test('11 compile repeat and lexical rebuild preserve identities and zero provenance gaps',()=>{const f=fixture();try{f.store.ingestSource({originKey:'old',text:'State: Velden | worker = node-D4',observedAt:1});f.store.ingestSource({originKey:'new',text:'Correction: Velden | worker = node-F9',observedAt:2});const c=new ContextForgeCompiler(f.store),a=c.compile(),b=c.compile();assert.equal(a.deterministicOutputSha256,b.deterministicOutputSha256);assert.deepEqual(c.lintWiki(),{ok:true,provenanceGaps:0,issues:[]});const before=f.store.getStats().chunks;f.store.rebuildRecallProjection();c.compile();assert.equal(f.store.getStats().chunks,before);}finally{f.clean();}});

test('12 heavy then phatic keeps newest complete tail and no optional documents',()=>{const f=fixture();try{for(let i=0;i<12;i++)f.store.ingestSource({originKey:'doc-'+i,text:'Long Jadra report '+i});f.store.commitTurn({sessionId:'test',advancementKey:'tail',messages:[{role:'user',content:'Newest small turn'},{role:'assistant',content:'Acknowledged'}]});const heavy=plan(f.store,'Review all documents');for(const q of ['hello','Thanks!','ok','got it','continue conversation']){assert.ok(isTrivialPhatic(q));assert.equal(analyzeRecallQuery(q).substantiveTerms.length,0);const p=plan(f.store,q);assert.equal(p.receipt.selections.filter(i=>i.role==='quoted_evidence').length,0);assert.equal(p.epoch.epochId,heavy.epoch.epochId);}for(const q of ['hello Pela','83','Aru','What did Alice say?'])assert.ok(analyzeRecallQuery(q).substantiveTerms.length);}finally{f.clean();}});

test('R1 exact subspan, alternate artifact and distant direct/routed merge retain wire bytes and closure',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'bulky',text:'Zircon direct hit.\n'+Array.from({length:400},(_,i)=>'line '+i+' '+('padding '.repeat(8))+'\n').join('')});
 const a=f.store.db.prepare("SELECT * FROM artifacts WHERE source_id=? AND kind='raw'").get(s.sourceId)!;const raw=String(a.text_content),start=Buffer.byteLength(raw.slice(0,raw.indexOf('line 199'))),sub=f.store.createSpan(s.sourceId,String(a.artifact_id),start,start+8);
 const alternate=f.store.addArtifact({sourceId:s.sourceId,kind:'text',text:'Exact alternate support named Q9.'});const alt=f.store.createSpan(s.sourceId,alternate.artifactId,0,Buffer.byteLength(alternate.textContent!));
 f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'zircon',kind:'fact',title:'Zircon direct hit',body:'Zircon direct hit interpretation',canonical:{},compilerVersion:'test',observedAt:1,spanIds:[sub,alt],extractionRule:'test'});
 const p=plan(f.store,'Zircon direct hit');assert.match(text(p),/line 199/);assert.match(text(p),/Exact alternate support named Q9/);assert.ok(p.receipt.selections[0].provenanceSpanIds.includes(sub));assert.ok(p.receipt.selections[0].provenanceSpanIds.includes(alt));assert.ok(p.receipt.retrieval!.supportGroupDeliveredIds.length);assert.equal(p.receipt.retrieval!.supportGroupMissingIds.length,0);
 }finally{f.clean();}});

test('R2 superseded derived values are excluded for current state and labeled for history',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'support',text:'Velden worker source.'});const span=f.store.getEvidenceChunks(s.sourceId)[0].spanId;for(const value of ['OLD','NEW'])f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'velden',kind:'fact',title:'Velden worker',body:'Velden worker is '+value,canonical:{},compilerVersion:'test',observedAt:value==='OLD'?1:2,spanIds:[span],extractionRule:'test'});const p=plan(f.store,'Velden worker');assert.match(text(p),/NEW/);assert.doesNotMatch(text(p),/OLD/);const history=plan(f.store,'Compare Velden worker history');assert.match(text(history),/\[superseded\] revision 1: Velden worker is OLD/);assert.equal(history.receipt.selections[0].status,'active');}finally{f.clean();}});

test('R3 shared-key neighbors are admitted and inspected graph work is bounded and marked truncated',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'graph-bounds',text:'Zircon qualification.'}),span=f.store.getEvidenceChunks(s.sourceId)[0].spanId;const make=(i:number)=>f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'shared'+i,kind:'fact',title:'Zircon qualification '+i,body:'Zircon qualification '+i,canonical:{entity:'Zircon'},compilerVersion:'test',observedAt:1,spanIds:[span],extractionRule:'test'});const seed=make(0),neighbor=make(1);assert.ok(expandRelatedPremises(f.store,[seed.nodeId],analyzeRecallQuery('Zircon qualification')).some(r=>r.relation==='shared_key'&&r.node.nodeId===neighbor.nodeId));for(let i=2;i<90;i++)make(i);const r=f.store.getRelatedNodes([seed.nodeId],{limit:64}) as any;assert.ok(r.truncated);assert.ok(r.inspected<=256);const expired=f.store.getRelatedNodes([seed.nodeId],{deadlineAt:0} as any) as any;assert.ok(expired.truncated);assert.equal(expired.length,0);}finally{f.clean();}});

test('R4 compiled equivalent single claims deduplicate without defeating exhaustive obligations',()=>{const f=fixture();try{for(let i=0;i<5;i++)f.store.ingestSource({originKey:'copy'+i,text:'Varden launch is Tuesday.'});new ContextForgeCompiler(f.store).compile();const p=plan(f.store,'Varden launch');assert.equal(p.receipt.selections.length,1);const all=plan(f.store,'Review all documents');assert.equal(all.receipt.selections.length,5);}finally{f.clean();}});

test('R5 compound identifier planner admission, exact case bonus, alias cap observability',()=>{const f=fixture();try{f.store.ingestSource({originKey:'compact',text:'RFC38 adopted.'});assert.equal(plan(f.store,'RFC-38').receipt.selections.length,1);const exact=scoreFacetCoverage('vz_8Q-04a-Z9','vz_8Q-04a-Z9'),normalized=scoreFacetCoverage('vz_8Q-04a-Z9','vz_8q-04a-z9');assert.ok(exact.score>normalized.score);assert.ok(normalized.anchored);const q=analyzeRecallQuery(Array.from({length:100},(_,i)=>'alpha-'+i+'-beta').join(' '));buildFtsQuery(q);assert.ok(q.truncated);}finally{f.clean();}});

test('R6 authorized active-source ranking is isolated from other namespace statistics',()=>{const f=fixture();try{f.store.ingestSource({originKey:'one',text:'olive grove'});f.store.ingestSource({originKey:'two',text:'olive oil olive'});const before=f.store.search('olive').map(h=>[h.sourceId,h.score]);const ns=f.store.resolveNamespace({scopeKey:'other'});for(let i=0;i<20;i++)f.store.ingestSource({namespaceId:ns,originKey:'foreign'+i,text:'olive '.repeat(i+1)});assert.deepEqual(f.store.search('olive').map(h=>[h.sourceId,h.score]),before);}finally{f.clean();}});

test('R7 huge UTF8 line is bounded and blank-line gaps are explicitly noncontiguous',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'huge',text:'λ'.repeat(40000)+' Zircon anomaly=Q9 '+'終'.repeat(40000)});const p=plan(f.store,'Zircon anomaly');assert.match(text(p),/Zircon anomaly=Q9/);assert.ok(text(p).length<30000);for(const id of p.receipt.selections[0].provenanceSpanIds)assert.ok(!f.store.readEvidenceSpan(id).text.includes('�'));const b=f.store.ingestSource({originKey:'blank',text:'Zircon first.\n\nZircon second.'});const q=plan(f.store,'Zircon first second');assert.ok(text(q).includes('noncontiguous excerpt')||text(q).includes('Zircon first.\n\nZircon second.'));}finally{f.clean();}});

test('R8 explicit representation binds only rendered artifacts and all selection hashes cover message content',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'explicit-bind',text:'Zircon primary.'}),alt=f.store.addArtifact({sourceId:s.sourceId,kind:'text',text:'Unrendered alternate.'});const p=plan(f.store,'Read explicit-bind',{sourceIds:[s.sourceId]});const i=p.receipt.selections[0];assert.ok(!i.artifactIds.includes(alt.artifactId));assert.ok(i.provenanceSpanIds.every(id=>f.store.readEvidenceSpan(id).artifactId!==alt.artifactId));for(const q of [p,plan(f.store,'Zircon primary')])for(const item of q.receipt.selections)assert.equal(item.contentSha256,sha256(canonicalJson(q.messages[item.renderedMessageIndexes[0]].content)));}finally{f.clean();}});

test('R9 source trust and external snapshot fidelity remain visible in wire and receipt',()=>{const f=fixture();try{const s=f.store.ingestSource({originKey:'trust',text:'Zircon snapshot qualification.',kind:'external_snapshot',trustClass:'external_untrusted',metadata:{fidelity:'lossy'}});const p=plan(f.store,'Zircon snapshot');assert.match(text(p),/external_untrusted/);assert.match(text(p),/source_fidelity:lossy/);assert.equal(p.receipt.selections[0].trace?.sourceFidelity,'lossy');const t=f.store.ingestSource({originKey:'tool-trust',text:'Karth tool qualification.',kind:'tool_result',role:'tool'});const q=plan(f.store,'Karth tool qualification');assert.match(text(q),/tool_output/);assert.equal(q.receipt.selections[0].trace?.trustClass,'tool_output');}finally{f.clean();}});

// Independent review recheck witnesses: do not weaken these to whole-window
// equality, source-ID-only coverage, or the pre-compiler path.
import { hydrateProvenanceSupport } from '../src/planner.ts';

test('R1 explicit source merges exact alternate-artifact support rather than suppressing its route',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'explicit-alt',text:'Zircon raw only.'});
 const alternate=f.store.addArtifact({sourceId:s.sourceId,kind:'text',text:'Exact alternate support named Q9.'});
 const span=f.store.createSpan(s.sourceId,alternate.artifactId,0,Buffer.byteLength(alternate.textContent!));
 f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'zircon-alt',kind:'fact',title:'Zircon derived Q9',body:'Zircon derived Q9',canonical:{},compilerVersion:'test',observedAt:1,spanIds:[span],extractionRule:'test'});
 const p=plan(f.store,'Zircon',{sourceIds:[s.sourceId]});
 assert.match(text(p),/Zircon raw only/);assert.match(text(p),/Exact alternate support named Q9/);
 assert.ok(p.receipt.selections.some(i=>i.provenanceSpanIds.includes(span)&&i.artifactIds.includes(alternate.artifactId)));
 assert.ok(p.receipt.retrieval!.supportGroupDeliveredIds.length);assert.equal(p.receipt.retrieval!.supportGroupMissingIds.length,0);
 }finally{f.clean();}});

test('R1 multi-source closure remains atomic with explicit overlap and tight history budget',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'explicit-closure',text:'Zircon raw only.'});
 const alternate=f.store.addArtifact({sourceId:s.sourceId,kind:'text',text:'Exact alternate support named Q9.'});
 const a=f.store.createSpan(s.sourceId,alternate.artifactId,0,Buffer.byteLength(alternate.textContent!));
 const other=f.store.ingestSource({originKey:'second-premise',text:'Second independent premise. '+('support padding '.repeat(350))});
 const b=f.store.createSpan(other.sourceId,f.store.getEvidenceChunks(other.sourceId)[0].artifactId,0,Buffer.byteLength('Second independent premise. '+('support padding '.repeat(350))));
 const body='Zircon derived Q9 requires both premises.';
 f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'zircon-closure',kind:'fact',title:body,body,canonical:{},compilerVersion:'test',observedAt:1,spanIds:[a,b],extractionRule:'test'});
 const roomy=plan(f.store,'Zircon',{sourceIds:[s.sourceId]});assert.ok(text(roomy).includes(body));
 for(const id of [a,b])assert.ok(roomy.receipt.selections.some(i=>i.provenanceSpanIds.includes(id)));
 assert.equal(roomy.receipt.retrieval!.supportGroupMissingIds.length,0);
 const tight=plan(f.store,'Zircon',{sourceIds:[s.sourceId],envelope:{nativeContextTokens:64000,hostTokenBudget:250,hostBudgetScope:'history_only',input:['text']}});
 assert.ok(!text(tight).includes(body),'a derived interpretation must not travel without both exact premises');
 assert.ok(tight.receipt.retrieval!.supportGroupMissingIds.length,'discovered closure must not vanish when explicit overlap suppresses a candidate');
 assert.notEqual(tight.receipt.disposition,'admitted');if(tight.receipt.disposition!=='blocked')assert.match(text(tight),/coverage is incomplete/i);
 }finally{f.clean();}});

test('R2 helper rejects superseded nodes for current and bare release requests, permits explicit history',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'helper-lifecycle',text:'Velden worker source.'}),span=f.store.getEvidenceChunks(s.sourceId)[0].spanId;
 const publish=(value:string,observedAt:number)=>f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'velden-helper',kind:'fact',title:'Velden worker',body:'Velden worker is '+value,canonical:{},compilerVersion:'test',observedAt,spanIds:[span],extractionRule:'test'});
 const old=publish('OLD',1);publish('NEW',2);
 for(const query of ['Velden worker','Velden worker release']){
  assert.deepEqual(hydrateProvenanceSupport(f.store,old.nodeId,analyzeRecallQuery(query)),[],query);
  assert.doesNotMatch(text(plan(f.store,query)),/worker is OLD/,query);
 }
 assert.ok(hydrateProvenanceSupport(f.store,old.nodeId,analyzeRecallQuery('Compare Velden worker history')).some(c=>c.derivedText?.includes('[superseded] revision 1: Velden worker is OLD')));
 }finally{f.clean();}});

test('R4 repeated supported claims ignore unrelated archive suffixes but exhaustive sources remain complete',()=>{const f=fixture();try{
 const ids=[];for(let i=0;i<5;i++)ids.push(f.store.ingestSource({originKey:'archive-copy-'+i,text:'Varden launch is Tuesday.\nArchive copy '+i+'.'}).sourceId);
 new ContextForgeCompiler(f.store).compile();const p=plan(f.store,'Varden launch');
 assert.equal(p.receipt.selections.length,1);assert.equal(p.receipt.coldStorage.exclusions.filter(x=>x.reason==='redundant').length,4);assert.match(text(p),/Varden launch is Tuesday/);assert.equal(p.receipt.retrieval!.supportGroupMissingIds.length,0);
 const all=plan(f.store,'Review all documents');assert.deepEqual(new Set(all.receipt.selections.map(i=>i.sourceId)),new Set(ids));
 for(let i=0;i<5;i++)assert.ok(text(all).includes('Archive copy '+i+'.'));
 }finally{f.clean();}});

test('R7 compiled bulky optional source retains bounded exact support within 8000 history tokens',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'compiled-payload',text:('Zircon payload '+('x'.repeat(80))+' ').repeat(1700)});
 const compiler=new ContextForgeCompiler(f.store);compiler.compile();
 const pages=f.store.db.prepare("SELECT logical_key,canonical_json FROM derived_nodes WHERE layer=2 AND status='active' AND logical_key LIKE ? ORDER BY logical_key").all('wiki/sources/'+s.sourceId+'%');
 assert.ok(pages.length>1,'source fallbacks must be partitioned, not unbounded omnibus pages');
 for(const page of pages){const entries=JSON.parse(String(page.canonical_json)).entries;assert.ok(entries.length<=64);assert.ok(entries.reduce((n:number,e:any)=>n+e.text.length,0)<=16384);}
 const p=plan(f.store,'Zircon payload',{envelope:{nativeContextTokens:64000,hostTokenBudget:8000,hostBudgetScope:'history_only',input:['text']}});
 assert.ok(p.receipt.selections.length,'bounded evidence must remain selectable after compilation');assert.match(text(p),/Zircon payload/);assert.ok(p.estimatedTokens<=8000);assert.ok(text(p).length<40000);
 assert.equal(p.receipt.retrieval!.supportGroupMissingIds.length,0);
 for(const selection of p.receipt.selections)for(const id of selection.provenanceSpanIds){const span=f.store.readEvidenceSpan(id);assert.equal(sha256(span.bytes),sha256(Buffer.from(span.text)));assert.ok(!span.text.includes('�'));}
 assert.deepEqual(compiler.lintWiki(),{ok:true,provenanceGaps:0,issues:[]});
 }finally{f.clean();}});

test('R7 compiler partitions oversized legacy UTF8 chunk into exact bounded subspans deterministically',()=>{const f=fixture();try{
 const body=('Zircon λ payload 終 '+('x'.repeat(80))+' ').repeat(500),s=f.store.ingestSource({originKey:'legacy-payload',text:body});
 const artifact=f.store.getEvidenceChunks(s.sourceId)[0].artifactId,whole=f.store.createSpan(s.sourceId,artifact,0,Buffer.byteLength(body));
 // Reproduce an old persisted whole-line chunk, without changing collection APIs.
 const row=f.store.db.prepare('SELECT * FROM chunks WHERE span_id=?').get(f.store.getEvidenceChunks(s.sourceId)[0].spanId)!;
 f.store.db.prepare('DELETE FROM chunks WHERE span_id IN (SELECT span_id FROM spans WHERE source_id=?)').run(s.sourceId);
 f.store.db.prepare('INSERT INTO chunks(chunk_id,namespace_id,span_id,parent_chunk_id,ordinal,chunk_kind,title,body,layout_json,compiler_version) VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.chunk_id,f.store.namespaceId,whole,null,0,row.chunk_kind,row.title,body,row.layout_json,row.compiler_version);
 const compiler=new ContextForgeCompiler(f.store),first=compiler.compile(),second=compiler.compile();assert.equal(first.deterministicOutputSha256,second.deterministicOutputSha256);
 const pages=f.store.db.prepare("SELECT canonical_json FROM derived_nodes WHERE layer=2 AND status='active' AND logical_key LIKE ?").all('wiki/sources/'+s.sourceId+'%');
 const entries=pages.flatMap(p=>JSON.parse(String(p.canonical_json)).entries).sort((a:any,b:any)=>a.spans[0].byteStart-b.spans[0].byteStart);
 assert.ok(entries.length>1);assert.equal(entries.map((e:any)=>e.text).join(''),body);
 for(const entry of entries){assert.ok(Buffer.byteLength(entry.text)<=2048);assert.ok(!entry.text.includes('�'));assert.equal(entry.spanIds.length,1);assert.equal(f.store.readEvidenceSpan(entry.spanIds[0]).text,entry.text);}
 assert.deepEqual(compiler.lintWiki(),{ok:true,provenanceGaps:0,issues:[]});
 }finally{f.clean();}});

test('R3 planner continues uncovered anchored facets beyond the combined scan cap',()=>{const f=fixture();try{
 for(let i=0;i<300;i++)f.store.ingestSource({originKey:'frequent-'+i,text:'Zircon alpha beta gamma delta '+i});
 const rare=f.store.ingestSource({originKey:'rare-epsilon',text:'Zircon epsilon qualification '+('padding '.repeat(70))});
 for(let i=0;i<200;i++)f.store.ingestSource({originKey:'epsilon-noise-'+i,text:'Unrelated epsilon '+i});
 const p=plan(f.store,'Zircon alpha beta gamma delta epsilon');
 assert.ok(p.receipt.selections.some(s=>s.sourceId===rare.sourceId));assert.ok(p.receipt.retrieval!.work.facetQueries>0);assert.ok(p.receipt.retrieval!.truncated);
 assert.ok(p.receipt.retrieval!.work.chunks<=256+8*256);assert.ok(p.receipt.retrieval!.work.inspectedTotal<=8192);assert.ok(p.receipt.retrieval!.work.readBytes<=8*1024*1024);
 }finally{f.clean();}});

test('R3 discover checks deadline before preparing the second FTS lane',()=>{const f=fixture();const now=Date.now;try{
 f.store.ingestSource({originKey:'deadline-lane',text:'Zircon qualification.'});
 const prepare=f.store.db.prepare.bind(f.store.db);let clock=100,queries=0;
 f.store.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.includes('FROM retrieval_fts')){queries++;const iterate=stmt.iterate.bind(stmt);stmt.iterate=(...args:any[])=>{const it=iterate(...args),next=it.next.bind(it);it.next=()=>{const r=next();if(!r.done)clock=200;return r;};return it;};}return stmt;}) as any;
 Date.now=()=>clock;const p=plan(f.store,'Zircon',{deadlineAt:150});assert.equal(queries,1);assert.equal(p.receipt.retrieval!.work.chunks,1);assert.equal(p.receipt.retrieval!.work.nodes,0);assert.ok(p.receipt.retrieval!.truncated);
 }finally{Date.now=now;f.clean();}});

test('R4 identical canonical entity predicate object claims deduplicate across assertion labels',()=>{const f=fixture();try{
 for(const [i,label] of ['Fact','State','Decision','Fact','State'].entries())f.store.ingestSource({originKey:'typed-copy-'+i,text:label+': Varden | launch = Tuesday\nArchive copy '+i+'.'});
 new ContextForgeCompiler(f.store).compile();const p=plan(f.store,'Varden launch');assert.equal(p.receipt.selections.length,1);assert.match(text(p),/Tuesday/);
 assert.equal(plan(f.store,'Review all documents').receipt.selections.length,5);
 }finally{f.clean();}});

// Bounded storage regression probes (kept in the shipped retrieval suite).
function boundedFixture(fn:(s:ContextForgeStore)=>void){const dir=mkdtempSync(join(tmpdir(),'cf-r3-final-'));const s=new ContextForgeStore(join(dir,'db'));try{fn(s);}finally{s.close();rmSync(dir,{recursive:true,force:true});}}

test('R3 discovery streams only capped rows, reports inspected work, and resumes by rowid',()=>boundedFixture(s=>{
 for(let i=0;i<301;i++)s.ingestSource({originKey:String(i),text:'Zircon matching '+i});
 const prepare=s.db.prepare.bind(s.db);let actual=0;
 s.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.includes('FROM retrieval_fts')){stmt.all=()=>{throw new Error('materialized FTS');};const iterate=stmt.iterate.bind(stmt);stmt.iterate=(...args:any[])=>{const it=iterate(...args);const next=it.next.bind(it);it.next=()=>{const r=next();if(!r.done)actual++;return r;};return it;};}return stmt;}) as any;
 const first=s.search('Zircon',{limit:8,maxInspected:17,maxStatisticsInspected:0});
 assert.equal(actual,17);assert.equal(first.inspected,17);assert.equal(first.length,8);assert.equal(first.truncated,true);
 const second=s.search('Zircon',{limit:17,maxInspected:17,maxStatisticsInspected:0,afterRowid:first.nextRowid});
 assert.equal(actual,34);assert.equal(second.inspected,17);assert.ok(second.nextRowid>first.nextRowid);
 assert.ok(second.every(h=>!first.some(p=>p.sourceId===h.sourceId)));
}));

test('R3 statistics are capped, charged to shared work and not cached as complete',()=>boundedFixture(s=>{
 for(let i=0;i<25;i++)s.ingestSource({originKey:String(i),text:'Zircon matching '+i});
 const budget=createStoreReadBudget({maxInspected:11});
 const hits=s.search('Zircon',{budget,limit:10,maxInspected:8,maxStatisticsInspected:3});
 assert.equal(hits.statisticsInspected,3);assert.equal(hits.inspected,8);assert.equal(hits.workInspected,11);assert.equal(budget.inspected,11);assert.equal(hits.truncated,true);
 const next=s.search('Zircon',{maxStatisticsInspected:3,maxInspected:1});assert.equal(next.statisticsInspected,3);
 const stopped=s.search('Zircon',{budget});assert.equal(stopped.inspected,0);assert.equal(stopped.statisticsInspected,0);assert.equal(stopped.truncated,true);
}));

test('R3 discovery checks deadlines between iterator steps and before later lanes',()=>boundedFixture(s=>{
 for(let i=0;i<5;i++)s.ingestSource({originKey:String(i),text:'Zircon matching '+i});
 const prepare=s.db.prepare.bind(s.db),now=Date.now;let clock=100,actual=0,queries=0;
 s.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.includes('FROM retrieval_fts')){queries++;const iterate=stmt.iterate.bind(stmt);stmt.iterate=(...args:any[])=>{const it=iterate(...args),next=it.next.bind(it);it.next=()=>{const r=next();if(!r.done){actual++;clock=200;}return r;};return it;};}return stmt;}) as any;
 Date.now=()=>clock;
 try{const budget=createStoreReadBudget({deadlineAt:150});const a=s.search('Zircon',{budget,maxStatisticsInspected:0});const b=s.search('Zircon',{budget,layers:[1,2]});assert.equal(actual,1);assert.equal(a.inspected,1);assert.equal(b.inspected,0);assert.equal(queries,1);assert.equal(a.truncated,true);}finally{Date.now=now;}
}));

test('R3 evidence hydrates only bounded ranges without whole artifact reads and supports continuation',()=>boundedFixture(s=>{
 const source=s.ingestSource({originKey:'bulky',text:Array.from({length:5000},(_,i)=>'Zircon line '+i+' padding padding\n').join('')});
 (s as any).readBlobUnchecked=()=>{throw new Error('whole artifact hydration');};
 const budget=createStoreReadBudget({maxInspected:7,maxBytes:2048});
 const a=s.getEvidenceChunks(source.sourceId,{maxInspected:3,maxBytes:1024,budget});
 assert.equal(a.length,3);assert.equal(a.inspected,3);assert.equal(a.truncated,true);assert.ok(a.bytes<1024);
 const b=s.getEvidenceChunks(source.sourceId,{maxInspected:3,budget,afterByteStart:a.nextByteStart});
 assert.equal(b.length,3);assert.ok(b[0].byteStart>a[a.length-1].byteStart);assert.equal(budget.inspected,6);
 const expired=s.getEvidenceChunks(source.sourceId,{deadlineAt:0});assert.equal(expired.inspected,0);assert.equal(expired.length,0);assert.equal(expired.truncated,true);
 const tiny=s.getEvidenceChunks(source.sourceId,{maxBytes:1});assert.equal(tiny.length,0);assert.equal(tiny.bytes,0);assert.equal(tiny.inspected,1);assert.equal(tiny.truncated,true);
}));

test('R3 bounded hydration still rejects quote corruption',()=>boundedFixture(s=>{
 const source=s.ingestSource({originKey:'quote',text:'Zircon exact quote.'});const chunks=s.getEvidenceChunks(source.sourceId);
 (s as any).readBlobRange=()=>Buffer.from('corrupt quote');
 assert.throws(()=>s.getEvidenceChunks(source.sourceId),/EvidenceQuoteMismatch/);
}));

test('R3 statistics stop at deadline before any FTS lane runs',()=>boundedFixture(s=>{
 for(let i=0;i<5;i++)s.ingestSource({originKey:String(i),text:'Zircon matching '+i});
 const prepare=s.db.prepare.bind(s.db),now=Date.now;let clock=100,actual=0,queries=0;
 s.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.includes('FROM retrieval_fts'))queries++;
 if(sql.includes('SELECT p.source_id,substr(CAST(c.body')){const iterate=stmt.iterate.bind(stmt);stmt.iterate=(...args:any[])=>{const it=iterate(...args),next=it.next.bind(it);it.next=()=>{const r=next();if(!r.done){actual++;clock=200;}return r;};return it;};}return stmt;}) as any;
 Date.now=()=>clock;
 try{const hits=s.search('Zircon',{deadlineAt:150});assert.equal(actual,1);assert.equal(hits.statisticsInspected,1);assert.equal(hits.inspected,0);assert.equal(queries,0);assert.equal(hits.truncated,true);}finally{Date.now=now;}
}));

test('R3 facet-only continuation reaches anchored rare evidence behind global ranking cap',()=>boundedFixture(s=>{
 for(let i=0;i<140;i++)s.ingestSource({originKey:'common-'+i,text:'Zircon alpha beta gamma delta '+i});
 const rare=s.ingestSource({originKey:'rare',text:'Zircon epsilon qualification '+('padding '.repeat(70))});
 for(let i=0;i<200;i++)s.ingestSource({originKey:'noise-'+i,text:'Unrelated epsilon '+i});
 const budget=createStoreReadBudget({maxInspected:200});
 const global=s.search('Zircon alpha beta gamma delta epsilon',{budget,limit:128,maxInspected:128,maxStatisticsInspected:0});
 assert.ok(!global.some(h=>h.sourceId===rare.sourceId));assert.equal(global.inspected,128);
 const continuation=s.search('epsilon',{budget,limit:32,maxInspected:32,maxStatisticsInspected:0});
 assert.ok(continuation.some(h=>h.sourceId===rare.sourceId));assert.equal(budget.inspected,160);
}));

test('R3 exact support span hydration can share the same deadline and byte budget',()=>boundedFixture(s=>{
 const source=s.ingestSource({originKey:'support',text:'Zircon exact supporting premise.'}),chunk=s.getEvidenceChunks(source.sourceId)[0];
 (s as any).readBlobUnchecked=()=>{throw new Error('whole artifact hydration');};
 const budget=createStoreReadBudget({maxInspected:1,maxBytes:128});
 const span=s.readEvidenceSpan(chunk.spanId,{budget});assert.equal(span.text,chunk.text);assert.equal(budget.inspected,1);assert.equal(budget.bytes,Buffer.byteLength(chunk.text));
 assert.throws(()=>s.readEvidenceSpan(chunk.spanId,{budget}),/EvidenceReadBudgetExceeded/);
 assert.throws(()=>s.readEvidenceSpan(chunk.spanId,{maxBytes:1}),/EvidenceReadBudgetExceeded/);
}));

test('natural cumulative prose produces exact BigInt facts and original L0 hydration across entities and units',()=>{
 for(const c of [
  {name:'Orvi',intro:'The Orvi lab balance was not tared',unit:'g',a:'218.5',b:'643.75',c:'901.25',nets:['218.5','425.25','257.50']},
  {name:'Kelvo',intro:'In Kelvo, the scale was untared',unit:'g',a:'218.5',b:'643.75',c:'901.25',nets:['218.5','425.25','257.50']},
  {name:'Rulven',intro:'Rulven cumulative readings',unit:'ml',a:'10.00',b:'36.15',c:'50.20',nets:['10.00','26.15','14.05']},
  {name:'Tavren',intro:'Tavren running total',unit:'kg',a:'9007199254740993.00',b:'9007199254741019.15',c:'9007199254741041.15',nets:['9007199254740993.00','26.15','22.00']},
  ...['mg','mL','L','oz','lb'].map((unit,i)=>({name:'Unitlab'+i,intro:'Unitlab'+i+' successive readings',unit,a:'1.00',b:'2.25',c:'3.50',nets:['1.00','1.25','1.25']}))
 ]){const f=fixture();try{
  const quote=`${c.intro}: the empty vessel read ${c.a} ${c.unit}, after adding resin it read ${c.b} ${c.unit}, and after solvent read ${c.c} ${c.unit}`;
  const source=f.store.ingestSource({originKey:'natural-scale',text:quote,role:'user'});const compiler=new ContextForgeCompiler(f.store);compiler.compile();
  const rows=f.store.db.prepare("SELECT f.*,n.body,n.canonical_json,e.display_name FROM facts f JOIN derived_nodes n USING(node_id) JOIN entities e USING(entity_id) WHERE f.predicate='net_mass' ORDER BY e.display_name").all();
  assert.equal(rows.length,3,c.name);for(const [name,index] of [['vessel',0],['resin',1],['solvent',2]] as const){const row=rows.find(r=>r.display_name===`${c.name} ${name}`)!;assert.ok(row,`${c.name} ${name}`);assert.deepEqual(JSON.parse(String(row.object_json)),{value:c.nets[index],unit:c.unit});assert.equal(row.assertion_kind,'derived_calculation');assert.equal(JSON.parse(String(row.canonical_json)).formula.rounding,'exact_decimal');assert.ok(f.store.getProvenance(String(row.node_id)).some(p=>p.sourceId===source.sourceId));}
  for(const name of ['resin','solvent']){const result=plan(f.store,`${c.name} ${name} net added amount`),wire=text(result);assert.ok(wire.includes(quote),c.name+' missing original quote');assert.ok(wire.includes(`${c.name} ${name} net_mass`),c.name+' missing derived calculation');assert.ok(result.receipt.selections.some(s=>s.sourceId===source.sourceId));}
  if(c.name==='Tavren'){const wire=text(plan(f.store,'Tavren solvent net added amount'));assert.match(wire,/= 22 \(unit: kg; exact: 22\.00 kg;/);}
  if(c.name==='Orvi'){const wire=text(plan(f.store,'Orvi resin solvent net added amount'));assert.match(wire,/= 257\.5 \(unit: g; exact: 257\.50 g; calculated: 901\.25 - 643\.75 = 257\.5 g\)/);assert.match(wire,/= 425\.25 \(unit: g;/);}
  assert.equal(compiler.lintWiki().provenanceGaps,0);
 }finally{f.clean();}}
});

test('prose scale grammar rejects missing cues, mixed units and missing ordered tare; legacy lists retain exact values',()=>{
 const f=fixture();try{
  for(const [i,text] of [
   'A scale: the empty vessel read 10 g, after resin it read 30 g',
   'The scale was untared: empty vessel read 10 g, after resin read 30 kg',
   'Cumulative readings: after resin read 10 g, after solvent read 30 g'
  ].entries())f.store.ingestSource({originKey:'invalid'+i,text});
  new ContextForgeCompiler(f.store).compile();assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM facts WHERE predicate='net_mass'").get()!.n,0);
  f.store.ingestSource({originKey:'legacy',text:'Cumulative kitchen scale: 104g bowl, 130g cheese, 152g sour cream'});new ContextForgeCompiler(f.store).compile();assert.deepEqual(f.store.db.prepare("SELECT object_json FROM facts WHERE predicate='net_mass' ORDER BY CAST(json_extract(object_json,'$.value') AS REAL)").all().map(r=>JSON.parse(String(r.object_json)).value),['22','26','104']);
  f.store.ingestSource({originKey:'legacy-decimal',text:'scale: 10g cup, 36.15g oil'});new ContextForgeCompiler(f.store).compile();assert.ok(f.store.db.prepare("SELECT object_json FROM facts WHERE predicate='net_mass'").all().some(r=>JSON.parse(String(r.object_json)).value==='26.15'));
 }finally{f.clean();}
});

test('opaque normalized protocol JSON cannot crowd out decoded original causal premises',()=>{const f=fixture();try{
 for(let i=0;i<40;i++)f.store.commitTurn({sessionId:'noise',advancementKey:String(i),messages:[{role:'user',id:'n'+i,content:'padding '.repeat(400)+'Juniper runtime investigation'},{role:'assistant',content:'Recorded'}]});
 const result=f.store.ingestSource({originKey:'diagram',role:'user',text:'Juniper deployment diagram connects public gateway to process listener.'});
 new ContextForgeCompiler(f.store).compile();const p=plan(f.store,'Juniper deployment diagram process listener');assert.ok(text(p).includes('Juniper deployment diagram connects public gateway to process listener.'));assert.ok(p.receipt.selections.some(s=>s.sourceId===result.sourceId));
 for(const hit of f.store.search('Juniper',{layers:[0],limit:256})){const artifact=f.store.db.prepare('SELECT kind FROM artifacts WHERE artifact_id=?').get(hit.artifactId);assert.notEqual(artifact?.kind,'normalized_message');}
 }finally{f.clean();}});
