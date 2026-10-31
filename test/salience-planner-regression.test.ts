import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { planContext } from '../src/planner.ts';
import type { PlanContextInput } from '../src/planner.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'cf-salience-'));
  const store=new ContextForgeStore(join(dir,'store.sqlite'));
  return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function request(store:ContextForgeStore, extra:Partial<PlanContextInput>={}) {
  return planContext({store,sessionId:'session',admissionId:'plan',query:'ceramic kiln',rawSystemPrompt:'Be precise.',
    envelope:{nativeContextTokens:64000,hostTokenBudget:60000,hostBudgetScope:'history_only',input:['text']},...extra});
}
const sourceIds=(p:ReturnType<typeof planContext>)=>[...new Set(p.receipt.selections.filter(i=>i.role==='quoted_evidence').map(i=>i.sourceId))];

for(const compiled of [false,true])test(`two-clue evidence stops a novel single-token tail under actual budget competition (compiled=${compiled})`,()=>{
  const f=fixture();try {
    const strong=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln needs a slow cooling cycle.'});
    for(let i=0;i<24;i++)f.store.ingestSource({originKey:`catalog-${i}`,text:`The kiln catalog edition ${i} describes an unrelated shelf finish.`});
    if(compiled)new ContextForgeCompiler(f.store).compile();
    const p=request(f.store,{envelope:{nativeContextTokens:64000,hostTokenBudget:1000,hostBudgetScope:'history_only',input:['text']}});
    assert.deepEqual(sourceIds(p),[strong.sourceId]);
    assert.ok(p.receipt.coldStorage.exclusions.some(e=>e.reason==='low_marginal_gain'));
    assert.ok(p.receipt.tokens.selectedHistory<1000);
    assert.ok(p.receipt.tokens.remainingHistoryCapacity>0);
  }finally{f.clean();}
});

test('complementary multi-clue sources and a unique exact facet survive the relative knee',()=>{
  const f=fixture();try {
    const first=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln glaze needs slow cooling.'});
    const second=f.store.ingestSource({originKey:'mixture-note',text:'The ceramic pigment requires dry storage.'});
    const unique=f.store.ingestSource({originKey:'special-note',text:'Batch_Q7 requires a separate inspection.'});
    new ContextForgeCompiler(f.store).compile();
    const p=request(f.store,{query:'ceramic kiln glaze pigment Batch_Q7'});
    for(const s of [first,second,unique])assert.ok(sourceIds(p).includes(s.sourceId));
    assert.ok(p.receipt.selections.every(i=>i.provenanceSpanIds.length>0));
  }finally{f.clean();}
});

test('a low-scoring source with a unique fully matched question facet survives',()=>{
  const f=fixture();try {
    const broad=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln glaze pigment needs slow cooling.'});
    const rare=f.store.ingestSource({originKey:'air-note',text:'Ventilation requires an open exhaust.'});
    const p=request(f.store,{query:'ceramic kiln glaze pigment ventilation'});
    assert.deepEqual(new Set(sourceIds(p)),new Set([broad.sourceId,rare.sourceId]));
    const broadScore=p.receipt.selections.find(i=>i.sourceId===broad.sourceId)!.utility;
    const rareScore=p.receipt.selections.find(i=>i.sourceId===rare.sourceId)!.utility;
    assert.ok(rareScore<broadScore/2,'unique coverage, not utility alone, exempts this evidence');
  }finally{f.clean();}
});

test('a weak explicit source remains a complete obligation and explicit source lists retain every requested source',()=>{
  const f=fixture();try {
    const strong=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln needs slow cooling.'});
    const weak=f.store.ingestSource({originKey:'catalog-note',text:'The kiln catalog describes unrelated shelf finishes.'});
    const p=request(f.store,{sourceIds:[weak.sourceId]});
    assert.ok(sourceIds(p).includes(strong.sourceId));
    assert.ok(p.receipt.selections.some(i=>i.sourceId===weak.sourceId&&i.required));
    assert.ok(p.receipt.demand.obligations.every(o=>o.status==='satisfied'));
    const all=request(f.store,{admissionId:'explicit-multi',query:'Review every document about ceramic kiln',sourceIds:[strong.sourceId,weak.sourceId]});
    assert.deepEqual(new Set(sourceIds(all)),new Set([strong.sourceId,weak.sourceId]));
    assert.ok(all.receipt.demand.obligations.every(o=>o.status==='satisfied'));
  }finally{f.clean();}
});

test('without a stronger two-clue reference single-clue evidence is not cut by an absolute floor',()=>{
  const f=fixture();try {
    const only=f.store.ingestSource({originKey:'catalog-note',text:'The kiln requires ventilation.'});
    assert.deepEqual(sourceIds(request(f.store)),[only.sourceId]);
  }finally{f.clean();}
});

test('primary optional evidence renders last among independent quotes, before chronological history',()=>{
  const f=fixture();try {
    const strongest=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln glaze needs slow cooling.',observedAt:1});
    const complementary=f.store.ingestSource({originKey:'mixture-note',text:'The ceramic pigment requires dry storage.',observedAt:2});
    f.store.commitTurn({sessionId:'session',advancementKey:'tail',messages:[{role:'user',content:'Keep the notebook handy.'},{role:'assistant',content:'Ready.'}]});
    const p=request(f.store,{query:'ceramic kiln glaze pigment'});
    assert.deepEqual(sourceIds(p),[complementary.sourceId,strongest.sourceId]);
    assert.deepEqual(p.messages.slice(-2).map(m=>m.content),['Keep the notebook handy.','Ready.']);
    const quotes=p.receipt.selections.filter(i=>i.role==='quoted_evidence');
    assert.ok(quotes[0].utility<quotes[1].utility);
    assert.ok(quotes[0].renderedMessageIndexes[0]<quotes[1].renderedMessageIndexes[0]);
    const temporal=request(f.store,{admissionId:'temporal',query:'Compare ceramic kiln glaze pigment history'});
    assert.deepEqual(sourceIds(temporal),[strongest.sourceId,complementary.sourceId]);
  }finally{f.clean();}
});

test('coverage notice evicts the weakest optional bundle rather than the final salient quote',()=>{
  const f=fixture();try {
    const strongest=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln glaze needs slow cooling.'});
    const complementary=f.store.ingestSource({originKey:'mixture-note',text:'The ceramic pigment requires dry storage.'});
    const query='ceramic kiln glaze pigment';
    const baseline=request(f.store,{query});
    assert.equal(sourceIds(baseline).length,2);
    const tight=request(f.store,{query,admissionId:'tight',sourceIds:['unavailable-source'],
      envelope:{nativeContextTokens:64000,hostTokenBudget:baseline.receipt.tokens.selectedHistory,hostBudgetScope:'history_only',input:['text']}});
    assert.deepEqual(sourceIds(tight),[strongest.sourceId]);
    assert.ok(!sourceIds(tight).includes(complementary.sourceId));
    assert.ok(tight.messages.some(m=>typeof m.content==='string'&&m.content.includes('coverage is incomplete')));
    assert.ok(tight.receipt.demand.obligations.some(o=>o.status!=='satisfied'));
    assert.ok(tight.receipt.tokens.selectedHistory<=tight.receipt.tokens.admissibleHistory);
  }finally{f.clean();}
});

test('low lexical quality cannot sever a multi-source provenance bundle or graph contradiction',()=>{
  const f=fixture();try {
    const strong=f.store.ingestSource({originKey:'firing-note',text:'The ceramic kiln glaze requires cooling.'});
    const support=f.store.ingestSource({originKey:'sensor-note',text:'The kiln sensor is uncalibrated.'});
    const opposing=f.store.ingestSource({originKey:'safety-note',text:'Heating is prohibited until inspection.'});
    const span=(id:string)=>f.store.getEvidenceChunks(id)[0].spanId;
    const node=(key:string,text:string,ids:string[])=>f.store.publishNode({namespaceId:f.store.namespaceId,layer:1,logicalKey:key,kind:'fact',title:text,body:text,canonical:{},compilerVersion:'test',observedAt:1,spanIds:ids.map(span),extractionRule:'test'});
    const main=node('firing-rule','ceramic kiln glaze cooling requires sensor qualification',[strong.sourceId,support.sourceId]);
    const other=node('safety-rule','Heating is prohibited until inspection.',[opposing.sourceId]);
    f.store.db.prepare('INSERT INTO derivation_edges VALUES(?,?,?)').run(main.nodeId,other.nodeId,'contradicts');
    const p=request(f.store,{query:'ceramic kiln glaze cooling'});
    assert.deepEqual(new Set(sourceIds(p)),new Set([strong.sourceId,support.sourceId,opposing.sourceId]));
    assert.deepEqual(p.receipt.retrieval!.supportGroupMissingIds,[]);
  }finally{f.clean();}
});
