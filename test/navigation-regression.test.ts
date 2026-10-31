import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { buildEvidenceWindow, renderStructuralNavigation, STRUCTURAL_NAVIGATION_CHARS } from '../src/evidence.ts';
import { analyzeRecallQuery } from '../src/retrieval.ts';
import { planContext } from '../src/planner.ts';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-navigation-'));const store=new ContextForgeStore(join(dir,'db'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
const wire=(p:any)=>p.messages.map((m:any)=>typeof m.content==='string'?m.content:m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')).join('\n');
test('many required anchors record each structural unit once and full delivery suppresses part navigation',()=>{const f=fixture();try{
 const text='def long_operation(value):\n'+Array.from({length:220},(_,i)=>`    value_${i} = value + ${i}\n`).join('')+'    return value\n';
 const source=f.store.ingestSource({originKey:'operations.py',text});const spans=f.store.getEvidenceChunks(source.sourceId).map(c=>c.spanId);
 const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('long_operation value'),spans)!;
 const units=hit.trace.structuralUnits??[];assert.ok(units.length>0);assert.equal(units.length,new Set(units.map((u:any)=>`${u.byteStart}:${u.byteEnd}:${u.partIndex??'whole'}`)).size);
 assert.equal(hit.text,text);assert.equal(hit.derivedText,undefined);
 const p=planContext({store:f.store,query:'long_operation',sessionId:'navigation',admissionId:'full',rawSystemPrompt:'Be precise.',sourceIds:[source.sourceId],requiredSpansBySource:{[source.sourceId]:spans},strictExplicitObligationsOnly:true,envelope:{nativeContextTokens:16000,hostTokenBudget:9500,hostBudgetScope:'history_only',input:['text']}});
 assert.ok(wire(p).includes(text));assert.ok(!wire(p).includes('Structural navigation'));
}finally{f.clean();}});
test('partial hydration renders a repeated part and its signature just once',()=>{const f=fixture();try{
 const text='def operation(value):\n'+Array.from({length:650},(_,i)=>`    value_${i} = '${i>=280&&i<290?'rareNavigationWitness':'padding'}'\n`).join('')+'    return value\n';
 const source=f.store.ingestSource({originKey:'operations.py',text});const seeds=f.store.getEvidenceChunks(source.sourceId).filter(c=>c.text.includes('rareNavigationWitness')).map(c=>c.spanId);
 const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('rareNavigationWitness'),seeds)!;
 assert.ok(hit.derivedText);const lines=hit.derivedText.split('\n');assert.equal(lines.length,new Set(lines).size);assert.equal((hit.derivedText.match(/enclosing signature bytes/g)??[]).length,1);assert.ok(hit.derivedText.length<=STRUCTURAL_NAVIGATION_CHARS);assert.ok(hit.text.includes('def operation(value):'));
}finally{f.clean();}});
test('navigation has an independent hard bound and deduplicates immutable ranges',()=>{
 const units=Array.from({length:100},(_,i)=>({unitId:String(i),byteStart:i*100,byteEnd:i*100+100,partIndex:i+1,totalParts:100,symbolPath:'x'.repeat(1000),startLine:i,endLine:i+1,headerByteStart:0,headerByteEnd:20}));
 const text=renderStructuralNavigation([...units,...units]);assert.ok(text.length<=STRUCTURAL_NAVIGATION_CHARS);assert.equal((text.match(/enclosing signature bytes/g)??[]).length,1);assert.ok(text.includes('part-1 of 100'));
});
