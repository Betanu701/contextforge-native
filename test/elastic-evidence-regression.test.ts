import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ContextForgeStore} from '../src/store.ts';import {ContextForgeCompiler} from '../src/compiler.ts';import {resolveEvidenceWindowPolicy,selectEvidenceAnchors,buildEvidenceWindow,discoverEvidenceCandidates,focusCursorEvidence} from '../src/evidence.ts';import {analyzeRecallQuery} from '../src/retrieval.ts';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-elastic-'));const store=new ContextForgeStore(join(dir,'db'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
test('source window share scales with model budget and competing source count, never unbounded',()=>{
 const single=resolveEvidenceWindowPolicy(9500,1),many=resolveEvidenceWindowPolicy(9500,16),small=resolveEvidenceWindowPolicy(2000,1);
 assert.ok(single.maxAnchors>=10);assert.ok(single.maxWindowBytes>20000);assert.ok(single.maxSourceBytes<=32768);assert.ok(single.maxSourceBytes>many.maxSourceBytes);assert.ok(single.maxSourceBytes>small.maxSourceBytes);
 assert.ok(resolveEvidenceWindowPolicy(1000000,1).maxSourceBytes<=32768);
});
test('anchor selection diversifies exact clues rather than taking twelve repeated first-clue hits',()=>{
 const q=analyzeRecallQuery('NeedleAlpha NeedleBeta NeedleGamma NeedleDelta NeedleEpsilon');const hits=[...Array.from({length:20},(_,i)=>({spanId:'a'+i,body:'NeedleAlpha'})),...['NeedleBeta','NeedleGamma','NeedleDelta','NeedleEpsilon'].map(body=>({spanId:body,body}))];
 const selected=selectEvidenceAnchors(hits,q,5);assert.equal(selected.length,5);assert.equal(new Set(selected.map(x=>x.body)).size,5);
});
test('single-source retrieval expands beyond four atomic definitions while preserving exact UTF8 quotes',()=>{const f=fixture();try{
 const names=Array.from({length:8},(_,i)=>'NeedleUnit'+i);const text=names.map(name=>`def ${name}(value):\n${'    value += 1 # supporting context\n'.repeat(65)}    return value\n\n`).join('')+'# irrelevant\n'.repeat(7000);const s=f.store.ingestSource({originKey:'single.py',text});new ContextForgeCompiler(f.store).compileNamespace();
 const q=analyzeRecallQuery(names.join(' '));const hits=f.store.search(names.join(' '),{layers:[0],limit:128});const anchors=selectEvidenceAnchors(hits,q,8).map(x=>x.spanId!);const p=resolveEvidenceWindowPolicy(9500,1);const win=buildEvidenceWindow(f.store,s.sourceId,q,anchors,f.store.namespaceId,Infinity,undefined,p)!;
 assert.ok(names.every(name=>win.text.includes(`def ${name}`)));assert.ok(Buffer.byteLength(win.text)>8192);assert.ok(Buffer.byteLength(win.text)<=p.maxWindowBytes);for(const id of win.spanIds){const e=f.store.readEvidenceSpan(id);assert.equal(e.text,Buffer.from(text).subarray(e.byteStart,e.byteEnd).toString());}
}finally{f.clean();}});
test('uncompiled bounded code source hydrates whole definitions without requiring namespace compilation',()=>{const f=fixture();try{
 const text='# preamble\n'+'# background\n'.repeat(5500)+'def NeedleLate(value):\n    answer = value + 37\n    return answer\n';const s=f.store.ingestSource({originKey:'raw.py',text});const q=analyzeRecallQuery('NeedleLate');const hit=f.store.search('NeedleLate',{layers:[0],limit:1})[0];const win=buildEvidenceWindow(f.store,s.sourceId,q,[hit.spanId!])!;assert.match(win.text,/answer = value \+ 37/);assert.match(win.text,/return answer/);assert.equal(f.store.readSourceBlob(s.sourceId).toString(),text);
}finally{f.clean();}});
test('cursor-local definitions suppress weak cross-file distractors but preserve usage and dependency companions',()=>{
 const q=analyzeRecallQuery('Complete the next line:\n```python\nfrom adapters import TargetAdapter\ndef run(value):\n    result = TargetAdapter(value)\n    result.\n```');assert.ok(q.cursorContext);
 const make=(sourceId:string,text:string,utility:number,symbolName?:string)=>({sourceId,text,utility,spanIds:[sourceId],artifactIds:[sourceId],matchedFacetIds:[],supportGroupIds:[],reasons:[],trace:{structuralUnits:symbolName?[{symbolName,symbolPath:sourceId+'::'+symbolName}]:[]}});
 const target=make('target','class TargetAdapter:\n    pass',1,'TargetAdapter'),noise=make('noise','old copyright helper unrelated',0.1),usage=make('usage','value = TargetAdapter(config)',0.2),dependency={...make('dependency','Companion premise',0.01),reasons:['dependency']};
 const selected=focusCursorEvidence([target,noise,usage,dependency],q);assert.ok(selected.includes(target));assert.ok(selected.includes(usage));assert.ok(selected.includes(dependency));assert.ok(!selected.includes(noise));
});
test('invalid elastic resource inputs reject; zero read budget grants no source bytes',()=>{
 assert.throws(()=>resolveEvidenceWindowPolicy(NaN,1));assert.throws(()=>resolveEvidenceWindowPolicy(-1,1));assert.throws(()=>resolveEvidenceWindowPolicy(1000,-1));assert.equal(resolveEvidenceWindowPolicy(1000,1,0).maxSourceBytes,0);
});
