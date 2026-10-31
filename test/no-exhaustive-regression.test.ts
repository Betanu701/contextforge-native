import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {ContextForgeStore} from '../src/store.ts';import {planContext} from '../src/planner.ts';import {selectCoherentEvidence} from '../src/evidence.ts';import {analyzeRecallQuery} from '../src/retrieval.ts';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-no-exhaustive-')),store=new ContextForgeStore(join(dir,'db'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
test('broad vocabulary in questions and code never creates inventory obligations or disables recall',()=>{const f=fixture();try{
 const relevant=f.store.ingestSource({originKey:'target-note',text:'Quasar drift correction uses amber compensation.'});f.store.ingestSource({originKey:'unrelated-archive',text:'Unrelated garden records. '.repeat(10000)});
 for(const word of ['all','every','entire','comprehensive','exhaustive'])for(const query of [`How does Quasar drift handle ${word} files?`,`Explain Quasar drift in this code:\n\`\`\`python\nfor item in ${word}_files:\n    process(item)\n\`\`\``]){
  const p=planContext({store:f.store,query,sessionId:'s',admissionId:word+query.length,rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:16000,hostTokenBudget:3000,hostBudgetScope:'history_only',input:['text']}});
  assert.equal(p.receipt.demand.obligations.length,0);assert.equal(p.receipt.retrieval?.discoveryEnabled,true);assert.ok(p.receipt.selections.some(s=>s.sourceId===relevant.sourceId));assert.ok(!p.receipt.selections.some(s=>s.required));
 }
}finally{f.clean();}});
test('broad words do not bypass coherent code sibling deduplication',()=>{
 const candidates=Array.from({length:5},(_,i)=>({sourceId:'s',text:'Quasar drift compensation',spanIds:['s'+i],artifactIds:['a'],matchedFacetIds:[],supportGroupIds:[],reasons:[],utility:1,excerpts:[{spanId:'s'+i,artifactId:'a',byteStart:i*100,byteEnd:i*100+25,text:'Quasar drift compensation'}],trace:{structuralUnits:[{kind:'block',symbolPath:'code.py::unit'+i,originKey:'code.py',byteStart:i*100,byteEnd:i*100+25}]}}));
 for(const word of ['all','every','entire','comprehensive','exhaustive'])assert.equal(selectCoherentEvidence(candidates,analyzeRecallQuery(`Quasar drift compensation ${word} files`)).length,2);
});
