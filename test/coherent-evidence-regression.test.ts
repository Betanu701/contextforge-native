import {planContext} from '../src/planner.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ContextForgeStore} from '../src/store.ts';import {ContextForgeCompiler} from '../src/compiler.ts';
import {analyzeRecallQuery} from '../src/retrieval.ts';
import {renderAttributedEvidence,selectCoherentEvidence,hydrateProvenanceSupport,buildEvidenceWindow} from '../src/evidence.ts';
import type {EvidenceCandidate} from '../src/evidence.ts';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-coherent-'));const store=new ContextForgeStore(join(dir,'db'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
function candidate(text:string,index:number,path='module.py'):EvidenceCandidate {return {sourceId:'source',text,spanIds:['span'+index],artifactIds:['artifact'],matchedFacetIds:[],supportGroupIds:[],reasons:['provenance_support'],trace:{structuralUnits:[{kind:'block',symbolPath:path,byteStart:index*1000,byteEnd:index*1000+Buffer.byteLength(text)}]},utility:1,excerpts:[{spanId:'span'+index,artifactId:'artifact',byteStart:index*1000,byteEnd:index*1000+Buffer.byteLength(text),text}]};}
test('coherent alternatives stop at specificity drop and suppress duplicate routes without trimming an atomic quote',()=>{
 const strong=candidate('def quasar_reconcile():\n    return drift_limit\n',0,'core.py::quasar_reconcile');
 const weak=Array.from({length:12},(_,i)=>candidate('def helper():\n    return drift_limit\n',i+1));
 const duplicate={...strong};const chosen=selectCoherentEvidence([strong,duplicate,...weak],analyzeRecallQuery('quasar_reconcile drift_limit'));
 assert.ok(chosen.some(c=>c.text===strong.text));assert.ok(chosen.length<=2);assert.ok(chosen.every(c=>c.text===strong.text||c.text===weak[0].text));
 const compare=selectCoherentEvidence([strong,...weak.slice(0,4)],analyzeRecallQuery('Compare every quasar_reconcile drift_limit alternative'));assert.ok(compare.length>chosen.length);
});
test('coherent alternatives preserve independently required clues and contradiction companions',()=>{
 const first=candidate('Quasar alpha_key=7',0);const second=candidate('Quasar beta_key=9',1);const correction=candidate('Quasar alpha_key=not7',2);correction.reasons=['contradiction'];
 const selected=selectCoherentEvidence([first,second,correction],analyzeRecallQuery('Quasar alpha_key beta_key'));assert.equal(selected.length,3);
});
test('each disconnected quote has adjacent verified owner and citation; exact payload stays separate from metadata',()=>{const f=fixture();try{
 const text='def same():\n    return 11\n\n# outside\n\ndef same():\n    return 29\n';const s=f.store.ingestSource({originKey:'attachment',text});const art=f.store.getEvidenceChunks(s.sourceId)[0].artifactId;const a=0,b=Buffer.byteLength(text.slice(0,text.indexOf('\n# outside'))),c=Buffer.byteLength(text.slice(0,text.lastIndexOf('def same'))),d=Buffer.byteLength(text);
 const spans=[[a,b],[c,d]].map(([x,y])=>f.store.createEvidenceSpan(s.sourceId,art,x,y));
 const cand:EvidenceCandidate={sourceId:s.sourceId,text:'',spanIds:spans.map(x=>x.spanId),artifactIds:[art],matchedFacetIds:[],supportGroupIds:[],reasons:[],utility:1,excerpts:spans,trace:{structuralUnits:[{symbolPath:'first.py::same',originKey:'first.py',pathVerified:true,byteStart:a,byteEnd:b,artifactId:art},{symbolPath:'second.py::same',originKey:'second.py',pathVerified:true,byteStart:c,byteEnd:d,artifactId:art}]}};
 const result=renderAttributedEvidence(f.store,cand,analyzeRecallQuery('same 29'));
 assert.match(result,/Evidence first\.py::same[^\n]*\[span:[a-f0-9]+\]\n<source_quote>\ndef same\(\):\n    return 11/);assert.match(result,/Evidence second\.py::same[^\n]*\[span:[a-f0-9]+\]\n<source_quote>\ndef same\(\):\n    return 29/);
 assert.ok(result.indexOf('second.py')>result.indexOf('first.py'));assert.ok(!result.includes('outside'));assert.equal(f.store.readSourceBlob(s.sourceId).toString(),text);
}finally{f.clean();}});
test('a persisted structural route never inherits unrelated cached source seeds',()=>{const f=fixture();try{
 const text='def quasar_reconcile():\n    return 29\n\n'+Array.from({length:1000},(_,i)=>`def irrelevant_${i}():\n    return ${i}\n`).join('\n');const s=f.store.ingestSource({originKey:'large.py',text});new ContextForgeCompiler(f.store).compile();
 const node=f.store.db.prepare("SELECT node_id FROM derived_nodes WHERE layer=2 AND status='active' AND logical_key LIKE 'wiki/structure/%' AND json_extract(canonical_json,'$.entries[0].structural.symbolName')='quasar_reconcile' AND json_extract(canonical_json,'$.entries[0].structural.kind')='block'").get()!;
 const q=analyzeRecallQuery('quasar_reconcile');const unrelated=buildEvidenceWindow(f.store,s.sourceId,analyzeRecallQuery('irrelevant_999'))!;const cache=new Map([[s.sourceId,unrelated]]);const result=hydrateProvenanceSupport(f.store,String(node.node_id),q,f.store.namespaceId,cache);
 assert.ok(result.length);for(const c of result){assert.match(c.text,/def quasar_reconcile/);assert.ok(!c.text.includes('irrelevant_999'));assert.ok(c.trace.coherentStructuralRoute);}
}finally{f.clean();}});

test('contained and duplicate quotes retain dependency groups and semantic interpretations',()=>{
 const whole=candidate('quasar drift\nqualifier\n',0);const part=candidate('qualifier\n',0);part.excerpts![0].byteStart=13;part.excerpts![0].byteEnd=23;part.reasons=['dependency'];part.supportGroupIds=['multi'];part.supportRequirements={multi:['qual','other-source']};part.derivedText='Derived qualifier';part.trace.semanticInterpretation=true;
 const selected=selectCoherentEvidence([whole,part],analyzeRecallQuery('quasar drift'));assert.equal(selected.length,1);assert.ok(selected[0].supportGroupIds.includes('multi'));assert.deepEqual(selected[0].supportRequirements!.multi,['qual','other-source']);assert.equal(selected[0].derivedText,'Derived qualifier');assert.ok(selected[0].spanIds.includes(part.spanIds[0]));assert.ok(selected[0].excerpts!.some(e=>e.byteStart===13&&e.byteEnd===23));
 const duplicate={...whole,supportGroupIds:['duplicate'],supportRequirements:{duplicate:['outside']}};const exact=selectCoherentEvidence([whole,duplicate],analyzeRecallQuery('quasar drift'));assert.equal(exact.length,1);assert.ok(exact[0].supportGroupIds.includes('duplicate'));
});
test('one local citation covers every byte of three adjacent evidence spans',()=>{const f=fixture();try{
 const text='quasar drift qualifier';const s=f.store.ingestSource({originKey:'document',text});const artifact=f.store.getEvidenceChunks(s.sourceId)[0].artifactId;const spans=[[0,7],[7,13],[13,text.length]].map(([a,b])=>f.store.createEvidenceSpan(s.sourceId,artifact,a,b));const c:EvidenceCandidate={...candidate(text,0),sourceId:s.sourceId,spanIds:spans.map(x=>x.spanId),artifactIds:[artifact],excerpts:spans,trace:{structuralUnits:[{byteStart:0,byteEnd:text.length,symbolPath:'document',artifactId:artifact}]}};
 const rendered=renderAttributedEvidence(f.store,c,analyzeRecallQuery('quasar'));const id=/\[span:([a-f0-9]+)\]/.exec(rendered)![1];assert.equal(f.store.readEvidenceSpan(id).text,text);assert.ok(c.spanIds.includes(f.store.readEvidenceSpan(id).spanId));
}finally{f.clean();}});

test('routed oversized signature discloses incompleteness next to the partial quote',()=>{const f=fixture();try{
 const text='export function huge('+Array.from({length:1100},(_,i)=>'parameter'+i).join(',')+') {\n  return rareWitness;\n}\n';f.store.ingestSource({originKey:'huge.ts',text});new ContextForgeCompiler(f.store).compile();const p=planContext({store:f.store,query:'rareWitness',sessionId:'partial',admissionId:'p',rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:32000,hostTokenBudget:12000,hostBudgetScope:'history_only',input:['text']}});const wire=JSON.stringify(p.messages);assert.match(wire,/rareWitness/);assert.match(wire,/header incomplete/);
}finally{f.clean();}});
test('generic line routes cannot reintroduce a same-clue distractor tail after coherent unit selection',()=>{const f=fixture();try{
 const text='def quasar_reconcile(drift_limit):\n    return drift_limit + 29\n\n'+Array.from({length:400},(_,i)=>`def irrelevant_${i}(drift_limit):\n    return drift_limit + ${i}\n`).join('\n');f.store.ingestSource({originKey:'core.py',text});new ContextForgeCompiler(f.store).compile();
 const p=planContext({store:f.store,query:'Explain quasar_reconcile drift_limit',sessionId:'coherence',admissionId:'tail',rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:32000,hostTokenBudget:12000,hostBudgetScope:'history_only',input:['text']}});const wire=JSON.stringify(p.messages);assert.match(wire,/quasar_reconcile/);assert.ok((wire.match(/def irrelevant_/g)??[]).length<=2,'same-source generic routes must not bypass coherent selection');
}finally{f.clean();}});
