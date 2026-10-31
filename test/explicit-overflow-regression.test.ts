import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { planContext } from '../src/planner.ts';
import type { PlanContextInput } from '../src/planner.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-explicit-overflow-'));const store=new ContextForgeStore(join(dir,'store.sqlite'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
function request(store:ContextForgeStore,extra:Partial<PlanContextInput>={}):PlanContextInput{return {store,sessionId:'overflow',admissionId:'plan',query:'Explain lateWitness quarantineToken',rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:32000,hostTokenBudget:2000,hostBudgetScope:'history_only',input:['text']},...extra};}
const largeText=(name='lateWitness')=>'Unrelated background record and archival detail.\n'.repeat(2300)+`\nThe ${name} requires quarantineToken before a retry; otherwise reject the transaction.\n`;

test('ordinary explicit 100KB source hydrates a late indexed hit within H=2000 without full blob reads',()=>{
 const f=fixture();try{
  const source=f.store.ingestSource({originKey:'large-record.txt',text:largeText()});
  // Distractors rank highly but cannot displace the requested source's seeds.
  for(let i=0;i<12;i++)f.store.ingestSource({originKey:`distractor-${i}`,text:'lateWitness quarantineToken '.repeat(8)});
  const read=f.store.readBlob.bind(f.store);f.store.readBlob=(hash:string)=>{assert.notEqual(hash,source.contentSha256,'overflow must use budgeted range hydration');return read(hash);};
  const p=planContext(request(f.store,{sourceIds:[source.sourceId]}));
  const required=p.receipt.selections.find(s=>s.required&&s.sourceId===source.sourceId);
  assert.ok(required,'coherent late evidence must fit instead of rejecting the whole file');
  assert.match(JSON.stringify(p.messages),/requires quarantineToken before a retry/);
  assert.equal(required.trace?.explicitSourcePartial,true);
  assert.ok(Number(required.trace?.explicitReadBytes)<=256*1024);
  assert.equal(p.receipt.demand.obligations.find(o=>o.kind==='source')?.status,'partial');
  assert.equal(p.receipt.disposition,'partial');
  assert.match(p.receipt.warnings.join('\n'),/not complete source coverage/);
  assert.ok(p.receipt.tokens.selectedHistory<=2000);
 }finally{f.clean();}
});

test('oversized explicit source groups retain source obligations and late evidence independently',()=>{
 const f=fixture();try{
  const ids=['alphaWitness','betaWitness'].map(name=>f.store.ingestSource({originKey:`${name}.txt`,text:largeText(name)}).sourceId);
  const p=planContext(request(f.store,{sourceIds:ids,query:'Explain alphaWitness betaWitness quarantineToken',envelope:{nativeContextTokens:32000,hostTokenBudget:4000,hostBudgetScope:'history_only',input:['text']}}));
  assert.deepEqual(p.receipt.demand.obligations.filter(o=>o.kind==='source').map(o=>o.requestedSourceIds[0]),ids);
  assert.deepEqual(p.receipt.selections.filter(s=>s.required).map(s=>s.sourceId),ids);
  assert.match(JSON.stringify(p.messages),/alphaWitness requires quarantineToken/);assert.match(JSON.stringify(p.messages),/betaWitness requires quarantineToken/);
  assert.ok(p.receipt.demand.obligations.every(o=>o.status==='partial'));
  assert.ok(p.receipt.tokens.selectedHistory<=4000);
 }finally{f.clean();}
});

test('tiny H fails closed instead of silently claiming oversized explicit source coverage',()=>{
 const f=fixture();try{
  const source=f.store.ingestSource({originKey:'large-record.txt',text:largeText()});
  const p=planContext(request(f.store,{sourceIds:[source.sourceId],envelope:{nativeContextTokens:32000,hostTokenBudget:1,hostBudgetScope:'history_only',input:['text']}}));
  assert.equal(p.receipt.selections.length,0);assert.equal(p.receipt.disposition,'blocked');
  assert.notEqual(p.receipt.demand.obligations[0].status,'satisfied');assert.ok(p.receipt.tokens.selectedHistory<=1);
 }finally{f.clean();}
});

test('fitting 150KB required pressure payload remains complete, not windowed at ordinary knee',()=>{
 const f=fixture();try{
  const text='Required payload records. '.repeat(6500),source=f.store.ingestSource({originKey:'required-pressure.txt',text});
  const p=planContext(request(f.store,{sourceIds:[source.sourceId],query:'Review required payload',envelope:{nativeContextTokens:100000,hostTokenBudget:90000,hostBudgetScope:'history_only',input:['text']}}));
  const required=p.receipt.selections.find(s=>s.required)!;
  assert.ok(required);assert.notEqual(required.trace?.explicitSourcePartial,true);
  assert.ok(JSON.stringify(p.messages).includes(text));assert.equal(p.receipt.demand.obligations[0].status,'satisfied');
 }finally{f.clean();}
});

test('explicit required spans are atomic and cannot be silently reduced to a fitting subset',()=>{
 const f=fixture();try{
  const source=f.store.ingestSource({originKey:'required-spans.txt',text:largeText()});
  const artifact=String(f.store.db.prepare("SELECT artifact_id FROM artifacts WHERE source_id=? AND kind='raw'").get(source.sourceId)!.artifact_id);
  const first=f.store.createEvidenceSpan(source.sourceId,artifact,0,1800).spanId;
  const last=f.store.createEvidenceSpan(source.sourceId,artifact,80000,100000).spanId;
  const p=planContext(request(f.store,{sourceIds:[source.sourceId],requiredSpansBySource:{[source.sourceId]:[first,last]},strictExplicitObligationsOnly:true}));
  assert.equal(p.receipt.selections.length,0);assert.notEqual(p.receipt.demand.obligations[0].status,'satisfied');assert.notEqual(p.receipt.disposition,'admitted');
 }finally{f.clean();}
});

test('optional same-source recall cannot falsely satisfy rejected caller-required spans',()=>{const f=fixture();try{
 const source=f.store.ingestSource({originKey:'required-spans.txt',text:largeText()});const artifact=String(f.store.db.prepare("SELECT artifact_id FROM artifacts WHERE source_id=? AND kind='raw'").get(source.sourceId)!.artifact_id);const first=f.store.createEvidenceSpan(source.sourceId,artifact,0,1800).spanId,last=f.store.createEvidenceSpan(source.sourceId,artifact,80000,100000).spanId;
 const p=planContext(request(f.store,{sourceIds:[source.sourceId],requiredSpansBySource:{[source.sourceId]:[first,last]}}));assert.notEqual(p.receipt.demand.obligations[0].status,'satisfied');assert.notEqual(p.receipt.disposition,'admitted');
}finally{f.clean();}});
test('oversized explicit no-hit source fails closed instead of selecting arbitrary prefix',()=>{const f=fixture();try{
 const source=f.store.ingestSource({originKey:'large-record.txt',text:largeText()});for(const [i,query] of ['', 'zebraAbsentTerm'].entries()){const p=planContext(request(f.store,{admissionId:'absent-'+i,query,sourceIds:[source.sourceId],strictExplicitObligationsOnly:true}));assert.equal(p.receipt.selections.length,0);assert.notEqual(p.receipt.demand.obligations[0].status,'satisfied');}
}finally{f.clean();}});
