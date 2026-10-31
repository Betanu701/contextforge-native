import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { executeTrancheStream } from '../src/planner.ts';
import { estimateTokens } from '../src/symbolic-ir.ts';
import type { TrancheStreamInput, ContextPlan } from '../src/planner.ts';
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'cf-elastic-tranche-')),store=new ContextForgeStore(join(dir,'db'));
  return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const quoted=(p:ContextPlan)=>p.receipt.selections.filter(s=>s.role==='quoted_evidence');
const keep=(p:ContextPlan)=>({keepSpanIds:quoted(p).flatMap(s=>s.provenanceSpanIds)});
function input(store:ContextForgeStore,extra:Partial<TrancheStreamInput>={}):TrancheStreamInput {
  return {store,sessionId:'elastic',admissionId:'elastic',query:'Inspect `rotateValve`.',rawSystemPrompt:'Cite exact evidence.',trancheTokenBudget:8000,maxPasses:16,
    envelope:{nativeContextTokens:16000,hostTokenBudget:8000,hostBudgetScope:'total_input',input:['text'],safetyMarginTokens:100},...extra};
}
function evidence(store:ContextForgeStore,p:ContextPlan,sourceId?:string){return quoted(p).filter(s=>!sourceId||s.sourceId===sourceId).flatMap(s=>s.provenanceSpanIds).map(id=>store.readEvidenceSpan(id).text).join('\n');}
test('omitted stream inventory discovers active authorized documents and snapshots; [] keeps an empty requested queue',async()=>{
 const f=fixture();try{
  const doc=f.store.ingestSource({originKey:'valve.ts',text:'export function rotateValve() { return 1; }\n'});
  const snapshot=f.store.ingestSource({originKey:'snapshot.ts',kind:'external_snapshot',text:'export function rotateValve() { return 2; }\n'});
  const old=f.store.ingestSource({originKey:'old.ts',text:'export function rotateValve() { return 3; }\n'});
  f.store.db.prepare("UPDATE source_lifecycle SET status='withdrawn' WHERE source_id=?").run(old.sourceId);
  f.store.ingestSource({originKey:'turn',kind:'turn',text:'Unrelated conversation.'});
  const other=f.store.resolveNamespace({scopeKind:'project',scopeKey:'elsewhere'});
  const foreign=f.store.ingestSource({namespaceId:other,originKey:'foreign.ts',text:'export function rotateValve() { return 4; }\n'});
  const result=await executeTrancheStream(input(f.store),keep);
  assert.deepEqual(new Set(result.totalUniqueSourcesAdmitted),new Set([doc.sourceId,snapshot.sourceId]));
  assert.ok(!result.totalUniqueSourcesAdmitted.includes(foreign.sourceId));assert.equal(result.allRequestedSourcesCovered,true);
  const empty=await executeTrancheStream(input(f.store,{sourceIds:[],admissionId:'empty'}),()=>({}));
  assert.equal(empty.passes.length,1);
  assert.ok(empty.passes[0].plan.receipt.demand.obligations.every(o=>!o.requestedSourceIds.length),'no implicit mandatory inventory for []');
  const ordered=await executeTrancheStream(input(f.store,{sourceIds:[snapshot.sourceId,doc.sourceId],admissionId:'ordered'}),keep);
  assert.deepEqual(quoted(ordered.finalPlan).filter(s=>s.required).map(s=>s.sourceId),[snapshot.sourceId,doc.sourceId]);
 }finally{f.clean();}
});

test('over-2MB late indexed hit retains persisted part and signature without reparsing or prefix scanning',async()=>{
 const f=fixture();try{
  const text='export function rotateValve(value) {\n'+Array.from({length:1100},()=>`  // ${'padding '.repeat(260)}\n`).join('')+'  const latePressureWitness = value + 17;\n  return latePressureWitness;\n}\n';
  assert.ok(Buffer.byteLength(text)>2*1024*1024);
  const source=f.store.ingestSource({originKey:'large-valve.ts',text});new ContextForgeCompiler(f.store).compile();
  const getChunks=f.store.getEvidenceChunks.bind(f.store);let prefixScans=0;
  f.store.getEvidenceChunks=((id,options)=>{if(id===source.sourceId&&!options?.byteStart&&!options?.afterByteStart){prefixScans++;throw new Error('large source prefix scan forbidden');}return getChunks(id,options);}) as typeof f.store.getEvidenceChunks;
  f.store.getStructuralUnits=()=>{throw new Error('runtime full-source decomposition forbidden');};
  f.store.readSourceBlob=()=>{throw new Error('runtime whole source read forbidden');};
  const unchecked=(f.store as any).readBlobUnchecked;let fullReads=0;(f.store as any).readBlobUnchecked=()=>{fullReads++;throw new Error('hidden whole blob read forbidden');};
  const result=await executeTrancheStream(input(f.store,{sourceIds:[source.sourceId],query:'Inspect `latePressureWitness`.',maxPasses:8}),keep);
  assert.equal(fullReads,0);(f.store as any).readBlobUnchecked=unchecked;
  assert.equal(prefixScans,0);assert.ok(result.passes.length>0);
  const delivered=evidence(f.store,result.finalPlan);
  assert.match(delivered,/latePressureWitness/);assert.match(delivered,/export function rotateValve\(value\)/);
  const spans=quoted(result.finalPlan).flatMap(s=>s.provenanceSpanIds).map(id=>f.store.readEvidenceSpan(id));
  assert.ok(spans.some(s=>s.byteStart>2*1024*1024));
  for(const s of spans)assert.equal(s.text,Buffer.from(text).subarray(s.byteStart,s.byteEnd).toString());
  assert.ok(quoted(result.finalPlan).some(s=>(s.trace.structuralUnits as any[])?.some(u=>u.kind==='part'&&u.totalParts>1)));
  for(const p of [...result.passes.map(p=>p.plan),result.finalPlan]){assert.ok(p.receipt.tokens.serializedInputTokens<=8000);assert.ok(p.receipt.tokens.selectedHistory<=p.receipt.tokens.admissibleHistory);}
 }finally{f.clean();}
});

test('more than 8192 short chunks route a late hit through persisted metadata',async()=>{
 const f=fixture();try{
  const text='export function shortLines(value) {\n'+'  // filler\n'.repeat(8250)+'  const finalChunkWitness = value + 9;\n  return finalChunkWitness;\n}\n';
  assert.ok(Buffer.byteLength(text)<2*1024*1024);
  const source=f.store.ingestSource({originKey:'short-lines.ts',text});new ContextForgeCompiler(f.store).compile();
  const count=Number(f.store.db.prepare('SELECT count(*) AS n FROM chunks c JOIN spans p USING(span_id) WHERE p.source_id=?').get(source.sourceId)!.n);assert.ok(count>8192);
  f.store.getEvidenceChunks=()=>{throw new Error('short-chunk prefix scan forbidden');};
  f.store.getStructuralUnits=()=>{throw new Error('runtime structural reparse forbidden');};
  const result=await executeTrancheStream(input(f.store,{sourceIds:[source.sourceId],query:'Inspect `finalChunkWitness`.',maxPasses:4}),keep);
  assert.match(evidence(f.store,result.finalPlan),/finalChunkWitness/);
  assert.match(evidence(f.store,result.finalPlan),/export function shortLines/);
  assert.ok(result.finalPlan.receipt.tokens.serializedInputTokens<=8000);
 }finally{f.clean();}
});

test('single-source final capacity expands while multiple sources keep proportional bounds and physical admission',async()=>{
 const f=fixture();try{
  const symbols=Array.from({length:6},(_,i)=>`valveStage${i}`);
  const text=symbols.map(name=>`export function ${name}() {\n  const padding = '${'q'.repeat(3000)}';\n  return '${name}Witness';\n}\n`).join('\n');
  const first=f.store.ingestSource({originKey:'first.ts',text});
  const second=f.store.ingestSource({originKey:'second.ts',text});
  new ContextForgeCompiler(f.store).compile();
  const query=`Inspect ${symbols.map(s=>'`'+s+'`').join(' and ')}.`;
  const single=await executeTrancheStream(input(f.store,{sourceIds:[first.sourceId],query,admissionId:'single'}),keep);
  const multi=await executeTrancheStream(input(f.store,{sourceIds:[first.sourceId,second.sourceId],query,admissionId:'multi'}),keep);
  const singleText=evidence(f.store,single.finalPlan,first.sourceId),multiText=evidence(f.store,multi.finalPlan,first.sourceId);
  assert.ok(singleText.length>multiText.length,`single=${singleText.length} multi=${multiText.length}`);
  assert.ok(estimateTokens(singleText)<=Math.floor(8000*0.85));
  for(const source of [first,second])assert.ok(estimateTokens(evidence(f.store,multi.finalPlan,source.sourceId))<=Math.floor(8000*0.85/Math.sqrt(2)));
  assert.ok(Number(f.store.db.prepare('SELECT count(*) AS n FROM planner_receipts').get()!.n)>=single.passes.length+multi.passes.length+2);
  for(const name of symbols)assert.ok(singleText.includes(name+'Witness'),name);
  for(const result of [single,multi])for(const p of [...result.passes.map(p=>p.plan),result.finalPlan]){
    assert.ok(p.receipt.tokens.serializedInputTokens<=8000);assert.ok(p.receipt.tokens.selectedHistory<=p.receipt.tokens.admissibleHistory);
  }
 }finally{f.clean();}
});

test('large indexed no-hit does not resurrect a prefix or claim requested source coverage',async()=>{const f=fixture();try{
 const source=f.store.ingestSource({originKey:'huge-extraction',text:'routine material\n'.repeat(150000)});
 const unchecked=(f.store as any).readBlobUnchecked;let reads=0;(f.store as any).readBlobUnchecked=()=>{reads++;throw new Error('whole artifact fallback');};
 const result=await executeTrancheStream(input(f.store,{sourceIds:[source.sourceId],query:'AbsentUniqueQuasarToken',maxPasses:2}),keep);assert.equal(reads,0);assert.equal(result.allRequestedSourcesCovered,false);assert.equal(quoted(result.finalPlan).length,0);(f.store as any).readBlobUnchecked=unchecked;
}finally{f.clean();}});

test('part incompleteness survives metadata aggregation and source-only final retention',async()=>{const f=fixture();try{
 const text='export function targetFunction(value) {\n'+'  // filler\n'.repeat(8300)+'  return UniqueWitness(value);\n}\n';const source=f.store.ingestSource({originKey:'test.ts',text});new ContextForgeCompiler(f.store).compileNamespace();const result=await executeTrancheStream(input(f.store,{sourceIds:[source.sourceId],query:'Inspect `UniqueWitness`.',maxPasses:2}),p=>({keepSourceIds:quoted(p).map(s=>s.sourceId)}));
 assert.equal(result.allRequestedSourcesCovered,false);for(const p of [result.passes[0].plan,result.finalPlan]){const s=quoted(p)[0];assert.ok(s);assert.equal(s.trace.truncated,true);assert.equal(s.trace.structuralIncomplete,true);}
}finally{f.clean();}});
test('uncompiled nonindexed stream never resurrects a full-blob fallback for missing windows',async()=>{const f=fixture();try{
 const text='export function targetFunction(value) {\n'+'  // filler\n'.repeat(5500)+'  return UniqueWitness(value);\n}\n';const source=f.store.ingestSource({originKey:'test.ts',text});let reads=0;const old=(f.store as any).readBlobUnchecked;(f.store as any).readBlobUnchecked=()=>{reads++;throw new Error('whole blob forbidden');};
 const result=await executeTrancheStream(input(f.store,{sourceIds:[source.sourceId],query:'Inspect `UniqueWitness`.',maxPasses:2}),p=>({keepSourceIds:quoted(p).map(s=>s.sourceId)}));assert.equal(reads,0);assert.ok(result.finalPlan);(f.store as any).readBlobUnchecked=old;
}finally{f.clean();}});
