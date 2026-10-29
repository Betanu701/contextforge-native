import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { planContext, executeTrancheStream, resolveCapabilityEnvelope } from '../src/planner.ts';
import type { PlanContextInput } from '../src/planner.ts';
import { analyzeRecallQuery, scoreFacetCoverage } from '../src/retrieval.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'cf-planner-restoration-'));
  const store=new ContextForgeStore(join(dir,'store.sqlite'));
  return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function request(store:ContextForgeStore, extra:Partial<PlanContextInput>={}):PlanContextInput {
  return {store,sessionId:'session',admissionId:'plan',query:'Trace caching validation routing',rawSystemPrompt:'Be precise.',
    envelope:resolveCapabilityEnvelope({nativeContextTokens:32000,hostTokenBudget:30000,hostBudgetScope:'history_only',input:['text']}),...extra};
}

test('strict explicit caller order wins over relevance, orientation and temporal render ordering',()=>{
  const f=fixture();try {
    const sources=[
      f.store.ingestSource({originKey:'src/last.ts',text:'export const caching = true;',observedAt:300}),
      f.store.ingestSource({originKey:'README.md',text:'Caching validation routing architecture overview.',observedAt:100}),
      f.store.ingestSource({originKey:'src/first.ts',text:'export const validation = true;',observedAt:200}),
    ];
    for(const [index,query] of ['Trace caching validation routing','Compare previous caching validation routing history'].entries()) {
      const p=planContext(request(f.store,{admissionId:String(index),query,sourceIds:sources.slice(0,2).map(s=>s.sourceId),attachments:[{sourceId:sources[2].sourceId,modality:'text'}],strictExplicitObligationsOnly:true}));
      assert.deepEqual(p.receipt.selections.map(s=>s.sourceId),sources.map(s=>s.sourceId));
      assert.deepEqual(p.receipt.selections.map(s=>s.renderedMessageIndexes),[[0],[1],[2]]);
      assert.equal(p.receipt.disposition,'admitted');
      assert.ok(p.receipt.demand.obligations.every(o=>o.status==='satisfied'));
    }
  }finally{f.clean();}
});

test('strict admission priority is caller order, not a relevance score bonus',()=>{
  const f=fixture();try {
    const first=f.store.ingestSource({originKey:'src/preferred.ts',text:'export const preferred = true;'});
    const terms=Array.from({length:120},(_,i)=>`symbol_${i}`).join(' ');
    const broad=f.store.ingestSource({originKey:'src/broad.ts',text:terms});
    const p=planContext(request(f.store,{query:terms,sourceIds:[first.sourceId,broad.sourceId],strictExplicitObligationsOnly:true}));
    const admitted=p.receipt.stages.flatMap(s=>s.addedSelectionIds);
    assert.equal(admitted[0],p.receipt.selections.find(s=>s.sourceId===first.sourceId)!.selectionId);
    assert.deepEqual(p.receipt.selections.map(s=>s.sourceId),[first.sourceId,broad.sourceId]);
  }finally{f.clean();}
});

test('source metadata is cached once per explicit source and never read by sort comparators',()=>{
  const f=fixture();try {
    const ids=Array.from({length:16},(_,i)=>f.store.ingestSource({originKey:`src/file-${i}.ts`,text:`export const cache${i} = true;`,observedAt:16-i}).sourceId);
    const original=f.store.getSource.bind(f.store), calls=new Map<string,number>();
    f.store.getSource=(id:string)=>{
      assert.doesNotMatch(new Error().stack??'',/at Array\.sort/,'source SQL is not allowed inside sorting');
      calls.set(id,(calls.get(id)??0)+1);return original(id);
    };
    const p=planContext(request(f.store,{sourceIds:ids,strictExplicitObligationsOnly:true}));
    assert.deepEqual(p.receipt.selections.map(s=>s.sourceId),ids);
    // createSpan also validates its source once, independently of planner metadata.
    for(const id of ids)assert.equal(calls.get(id),2);
  }finally{f.clean();}
});

test('raw retrieval utility is normalized coverage, independent of mandatory priority',()=>{
  const f=fixture();try {
    const originKey='src/cache.ts',text='Caching validation routing checks.',query='Caching validation routing';
    const source=f.store.ingestSource({originKey,text});
    const p=planContext(request(f.store,{query,sourceIds:[source.sourceId],strictExplicitObligationsOnly:true}));
    assert.equal(p.receipt.selections[0].utility,scoreFacetCoverage(analyzeRecallQuery(query),`${originKey}\n${text}`).score);
    assert.equal(p.receipt.selections[0].required,true);
  }finally{f.clean();}
});

test('tranche final ranking hydrates source metadata and spans outside comparators',async()=>{
  const f=fixture();try {
    const ids=Array.from({length:3},(_,i)=>f.store.ingestSource({originKey:`src/cache-${i}.ts`,text:`export const cacheValidator${i} = true;`}).sourceId);
    const source=f.store.getSource.bind(f.store),span=f.store.readEvidenceSpan.bind(f.store);
    f.store.getSource=(id:string)=>{assert.doesNotMatch(new Error().stack??'',/at Array\.sort/);return source(id);};
    f.store.readEvidenceSpan=(...args:Parameters<typeof span>)=>{assert.doesNotMatch(new Error().stack??'',/at Array\.sort/);return span(...args);};
    const result=await executeTrancheStream(request(f.store,{sourceIds:ids}),async pass=>({keepSourceIds:pass.receipt.selections.map(s=>s.sourceId)}));
    assert.equal(result.allRequestedSourcesCovered,true);
    assert.equal(new Set(result.finalPlan.receipt.selections.map(s=>s.sourceId)).size,3);
  }finally{f.clean();}
});

test('relevant orientation renders first without boosting utility; unrelated docs have no orientation privilege',()=>{
  const f=fixture();try {
    const impl=f.store.ingestSource({originKey:'src/cache.ts',text:'Caching implementation.',observedAt:30});
    const readme=f.store.ingestSource({originKey:'README.md',text:'Caching validation routing architecture.',observedAt:20});
    const reference=f.store.ingestSource({originKey:'docs/reference.md',text:'Caching validation routing reference.',observedAt:10});
    const unrelated=f.store.ingestSource({originKey:'overview.md',text:'Gardening and flowers.',observedAt:40});
    const p=planContext(request(f.store,{sourceIds:[impl.sourceId,readme.sourceId,reference.sourceId,unrelated.sourceId]}));
    const ids=p.receipt.selections.map(s=>s.sourceId);
    assert.equal(ids[0],readme.sourceId);
    assert.ok(ids.indexOf(reference.sourceId)>ids.indexOf(impl.sourceId),'docs/ is not an orientation classification');
    assert.ok(ids.indexOf(unrelated.sourceId)>0,'unrelated orientation has no first-position privilege');
    assert.ok(p.receipt.selections.every(s=>s.utility<=1));
  }finally{f.clean();}
});

test('required source reservations reduce the optional knee before later packing stages',()=>{
  const f=fixture();try {
    const required=f.store.ingestSource({originKey:'named-source',text:'named source obligatory evidence. '.repeat(700)});
    for(let i=0;i<30;i++)f.store.ingestSource({originKey:`record-${i}`,text:(`Evidence calibration measurement uncertainty conditional exception variant${i} `).repeat(20)});
    new ContextForgeCompiler(f.store).compile();
    const p=planContext(request(f.store,{query:'Explain calibration measurement uncertainty conditional exception',sourceIds:[required.sourceId],envelope:resolveCapabilityEnvelope({nativeContextTokens:100000,hostTokenBudget:100000,hostBudgetScope:'total_input',input:['text']})}));
    assert.ok(p.receipt.demand.obligations.every(o=>o.status==='satisfied'));
    assert.ok(p.receipt.selections.some(s=>!s.required));
    assert.ok(p.receipt.tokens.serializedInputTokens<=11600,`required evidence must not get a second optional budget: ${p.receipt.tokens.serializedInputTokens}`);
  }finally{f.clean();}
});

test('expanded required payload retains bounded optional recall and complete support admission',()=>{
  const f=fixture();try {
    const required=Array.from({length:12},(_,i)=>f.store.ingestSource({originKey:`attachment-${i}`,text:`Required appendix ${i}. `+'Reference payload. '.repeat(2400)}));
    const evidence=f.store.ingestSource({originKey:'measurement-note',text:'Calibration measurement uncertainty depends on the independent control.'});
    new ContextForgeCompiler(f.store).compile();
    const p=planContext(request(f.store,{query:'Explain calibration measurement uncertainty',sourceIds:required.map(s=>s.sourceId),envelope:resolveCapabilityEnvelope({nativeContextTokens:262144,hostTokenBudget:262144,hostBudgetScope:'total_input',input:['text']})}));
    assert.ok(p.receipt.demand.obligations.every(o=>o.status==='satisfied'));
    assert.equal(new Set(p.receipt.selections.filter(s=>s.required).map(s=>s.sourceId)).size,12);
    assert.ok(p.receipt.selections.some(s=>!s.required&&s.sourceId===evidence.sourceId));
    assert.ok(p.receipt.selections.filter(s=>!s.required).reduce((n,s)=>n+s.costs.total,0)<=11500);
    assert.equal(p.receipt.disposition,'admitted');
    assert.deepEqual(p.receipt.retrieval!.supportGroupMissingIds,[]);
    assert.ok(p.receipt.tokens.selectedHistory<=p.receipt.tokens.admissibleHistory);
  }finally{f.clean();}
});

test('full required quotes satisfy contained support spans without duplicate optional excerpts',()=>{
  const f=fixture();try {
    const source=f.store.ingestSource({originKey:'required-observation',text:'Calibration uncertainty is controlled. '+ 'Original supporting detail. '.repeat(1900)});
    const artifact=f.store.getEvidenceChunks(source.sourceId)[0].artifactId;
    const span=f.store.createSpan(source.sourceId,artifact,0,Buffer.byteLength('Calibration uncertainty is controlled.'));
    f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:'calibration-support',kind:'fact',title:'Calibration uncertainty',body:'Calibration uncertainty is controlled.',canonical:{},compilerVersion:'test',observedAt:1,spanIds:[span],extractionRule:'test'});
    const input=request(f.store,{query:'Explain calibration uncertainty',sourceIds:[source.sourceId]});
    const baseline=planContext({...input,strictExplicitObligationsOnly:true});
    const p=planContext({...input,admissionId:'contained-span',envelope:resolveCapabilityEnvelope({nativeContextTokens:32000,hostTokenBudget:baseline.receipt.tokens.selectedHistory+100,hostBudgetScope:'history_only',input:['text']})});
    assert.ok(p.receipt.retrieval!.supportGroupDeliveredIds.length>0);
    assert.deepEqual(p.receipt.retrieval!.supportGroupMissingIds,[]);
    assert.equal(p.receipt.disposition,'admitted');
    assert.ok(!p.receipt.selections.some(s=>s.provenanceSpanIds.includes(span)),'support is covered by the enclosing full artifact quote, not duplicate span IDs');
    assert.equal(p.receipt.selections.filter(s=>!s.required).length,0);
  }finally{f.clean();}
});

test('expanded required payload cannot spend optional recall past physical capacity',()=>{
  const f=fixture();try {
    const required=f.store.ingestSource({originKey:'required-appendix',text:'Reference payload. '.repeat(3000)});
    f.store.ingestSource({originKey:'measurement-note',text:'Calibration measurement uncertainty. '.repeat(200)});
    const input=request(f.store,{query:'Explain calibration measurement uncertainty',sourceIds:[required.sourceId]});
    const initial=planContext({...input,strictExplicitObligationsOnly:true});
    const capacity=initial.receipt.tokens.selectedHistory+100;
    const p=planContext({...input,admissionId:'tight-plan',envelope:resolveCapabilityEnvelope({nativeContextTokens:32000,hostTokenBudget:capacity,hostBudgetScope:'history_only',input:['text']})});
    assert.ok(p.receipt.demand.obligations.every(o=>o.status==='satisfied'));
    assert.ok(p.receipt.tokens.selectedHistory<=capacity);
    assert.ok(p.receipt.selections.filter(s=>!s.required).reduce((n,s)=>n+s.costs.total,0)<=100);
  }finally{f.clean();}
});

test('disjoint relevant functions survive separate windows with complete bodies',async()=>{
  const f=fixture();try {
    const text=Array.from({length:6},(_,i)=>`export function targetMethod${i}() {\n${'  // implementation context\n'.repeat(70)}  return "answer-${i}";\n}\n`).join('\n');
    const source=f.store.ingestSource({originKey:'src/sample.ts',text});
    new ContextForgeCompiler(f.store).compile();
    const result=await executeTrancheStream({...request(f.store,{query:'Explain targetMethod0 targetMethod5',sourceIds:[source.sourceId]}),trancheTokenBudget:16000},p=>({keepSpanIds:p.receipt.selections.flatMap(s=>s.provenanceSpanIds)}));
    assert.ok(result.passes.length>=1);
    assert.equal(result.allRequestedSourcesCovered,true);
    const wire=JSON.stringify(result.finalPlan.messages);
    assert.match(wire,/answer-0/);assert.match(wire,/answer-5/);
    assert.doesNotMatch(wire,/answer-3/,'unselected unrelated functions remain cold');
    assert.ok(result.finalPlan.receipt.tokens.serializedInputTokens<=16000);
  }finally{f.clean();}
});

test('budget-blocked stream units are never reported as locally admitted',async()=>{
  const f=fixture();try {
    const s=f.store.ingestSource({originKey:'large.txt',text:'required evidence '.repeat(1000)});
    const result=await executeTrancheStream({...request(f.store,{sourceIds:[s.sourceId]}),trancheTokenBudget:100,maxPasses:2});
    assert.equal(result.allRequestedSourcesCovered,false);
    assert.deepEqual(result.totalUniqueSourcesAdmitted,[]);
    assert.deepEqual(result.verifiedSpanIds,[]);
  }finally{f.clean();}
});

test('optional orientation is bounded to 15 percent of available evidence budget',()=>{
  const f=fixture();try {
    const impl=f.store.ingestSource({originKey:'src/cache.ts',text:'export function cacheValidator() { return true; }'});
    const doc=f.store.ingestSource({originKey:'README.md',text:'cacheValidator architecture background. '.repeat(60)});
    const p=planContext(request(f.store,{query:'Explain cacheValidator architecture background',envelope:resolveCapabilityEnvelope({nativeContextTokens:32000,hostTokenBudget:1000,hostBudgetScope:'history_only',input:['text']})}));
    assert.ok(p.receipt.selections.some(s=>s.sourceId===impl.sourceId),'implementation remains eligible');
    const orientationTokens=p.receipt.selections.filter(s=>s.sourceId===doc.sourceId).reduce((n,s)=>n+s.costs.total,0);
    assert.ok(orientationTokens<=150,`orientation used ${orientationTokens} tokens`);
    assert.ok(p.receipt.tokens.selectedHistory<=1000);
  }finally{f.clean();}
});
