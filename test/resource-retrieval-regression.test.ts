import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ContextForgeStore,sha256} from '../src/store.ts';
import {resolveRetrievalWorkPolicy} from '../src/retrieval.ts';
import {planContext} from '../src/planner.ts';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-resource-'));const store=new ContextForgeStore(join(dir,'db'));return {store,dir,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
const wire=(p:any)=>JSON.stringify(p.messages);
test('inspection scales with envelope/corpus but remains memory bounded and reserves hydration',()=>{
 const small=resolveRetrievalWorkPolicy({historyTokens:2000,corpusBytes:20000,availableMemoryBytes:512*1024*1024});
 const large=resolveRetrievalWorkPolicy({historyTokens:64000,corpusBytes:100*1024*1024,availableMemoryBytes:512*1024*1024});
 assert.ok(large.maxInspected>small.maxInspected);assert.ok(large.maxBytes<=512*1024*1024/32);assert.ok(large.hydrationRows>=large.maxInspected/2);assert.equal(large.hydrationRows+4*large.discoveryRows,large.maxInspected);
 const constrained=resolveRetrievalWorkPolicy({historyTokens:64000,corpusBytes:100*1024*1024,availableMemoryBytes:64*1024*1024});assert.ok(constrained.maxInspected<large.maxInspected);
});
test('indexed ranking finds a late target beyond 12000 spans without enumerating source chunks',()=>{const f=fixture();try{
 const text=Array.from({length:12000},(_,i)=>`row ${i} common report padding\n`).join('')+'UNIQUE_NEEDLE late exact answer = 47\n';
 const s=f.store.ingestSource({originKey:'large-extraction',text});
 const start=performance.now(),hits=f.store.search('UNIQUE_NEEDLE common',{limit:8,maxInspected:32});assert.ok(hits.some(h=>h.body.includes('late exact answer')));assert.ok(hits.inspected<=32);assert.ok(performance.now()-start<2000,'indexed narrowing must not degenerate into namespace-row FTS probes');
 const old=f.store.getEvidenceChunks.bind(f.store);(f.store as any).getEvidenceChunks=()=>{throw new Error('large seed hydration must not scan source chunks');};
 const p=planContext({store:f.store,query:'What is UNIQUE_NEEDLE late exact answer?',sessionId:'s',admissionId:'late',rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:32000,hostTokenBudget:9500,hostBudgetScope:'history_only',input:['text']}});
 assert.ok(wire(p).includes('late exact answer = 47'));assert.ok(p.receipt.selections.length);assert.ok(p.receipt.retrieval!.work.hydrationInspected>0);assert.ok(p.receipt.retrieval!.work.inspectedTotal<=p.receipt.retrieval!.work.maxInspected);(f.store as any).getEvidenceChunks=old;
 assert.equal(f.store.readSourceBlob(s.sourceId).toString(),text);
}finally{f.clean();}});
test('L1 and L2 lanes survive large L0 volume and hydrate their distinct premises',()=>{const f=fixture();try{
 f.store.ingestSource({originKey:'noise',text:'Zircon common report\n'.repeat(11000)});
 for(const layer of [1,2] as const){const s=f.store.ingestSource({originKey:'premise'+layer,text:`Exact premise for lane ${layer}.`});const span=f.store.getEvidenceChunks(s.sourceId)[0].spanId;f.store.publishNode({namespaceId:f.store.namespaceId,layer,logicalKey:'zircon-lane'+layer,kind:'fact',title:'Zircon special evidence',body:'Zircon special evidence',canonical:{},compilerVersion:'test',observedAt:layer,spanIds:[span],extractionRule:'test'});}
 const p=planContext({store:f.store,query:'Zircon special evidence',sessionId:'s',admissionId:'fair',rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:32000,hostTokenBudget:9500,hostBudgetScope:'history_only',input:['text']}});
 assert.ok(wire(p).includes('Exact premise for lane 1'));assert.ok(wire(p).includes('Exact premise for lane 2'));assert.ok(p.receipt.retrieval!.work.l1Inspected>0);assert.ok(p.receipt.retrieval!.work.l2Inspected>0);
}finally{f.clean();}});
test('withdrawn high-score rows cannot starve the active indexed candidate before LIMIT',()=>{const f=fixture();try{
 for(let i=0;i<80;i++){const s=f.store.ingestSource({originKey:'revoked'+i,text:'UniqueAnchor'});f.store.withdrawSource(s.sourceId);}
 const target=f.store.ingestSource({originKey:'active',text:'UniqueAnchor active original evidence with extra context.'});const hits=f.store.search('UniqueAnchor',{limit:1,maxInspected:1});assert.equal(hits.length,1);assert.equal(hits[0].sourceId,target.sourceId);
}finally{f.clean();}});
test('temporal and kind eligibility are applied before ranked candidate LIMIT',()=>{const f=fixture();try{
 for(let i=0;i<16;i++)f.store.ingestSource({originKey:'old'+i,text:'Nebulon alpha',observedAt:100,kind:'document'});
 const current=f.store.ingestSource({originKey:'current',text:'Nebulon active original evidence with extra context.',observedAt:200,kind:'external_snapshot'});
 for(const options of [{observedFrom:150},{kinds:['external_snapshot']}]){const hits=f.store.search('Nebulon',{layers:[0],limit:8,maxInspected:8,...options});assert.equal(hits.length,1);assert.equal(hits[0].sourceId,current.sourceId);}
}finally{f.clean();}});
test('artifact fidelity reads use a covering metadata index rather than traversing large text payloads',()=>{const f=fixture();try{
 const s=f.store.ingestSource({originKey:'covering',text:'padding report\n'.repeat(600000)+'last marker\n'});const span=f.store.getEvidenceChunks(s.sourceId,{maxInspected:1})[0];
 const plan=f.store.db.prepare('EXPLAIN QUERY PLAN SELECT a.fidelity FROM artifacts a INDEXED BY cf_artifact_metadata WHERE artifact_id=?').all(span.artifactId);assert.ok(plan.some(r=>String(r.detail).includes('COVERING INDEX cf_artifact_metadata')));
 const start=performance.now();for(let i=0;i<100;i++){const hit=f.store.readEvidenceSpan(span.spanId,{maxBytes:4096});assert.equal(hit.fidelity,'exact');assert.equal(hit.text,span.text);}assert.ok(performance.now()-start<1000,'per-quote fidelity must not reread multi-MB artifact records');
}finally{f.clean();}});
