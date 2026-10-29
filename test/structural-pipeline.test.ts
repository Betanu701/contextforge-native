import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { ContextForgeStore, createStoreReadBudget } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { buildEvidenceWindow } from '../src/evidence.ts';
import { analyzeRecallQuery } from '../src/retrieval.ts';
import { planContext } from '../src/planner.ts';
import { SCHEMA_VERSION, SCHEMA_CHECKSUM } from '../src/schema.ts';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-structure-'));const store=new ContextForgeStore(join(dir,'db'));return {store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}
let admission=0;
function plan(store:ContextForgeStore,query:string){return planContext({store,query,sessionId:'structural-test',admissionId:String(admission++),rawSystemPrompt:'Be precise.',envelope:{nativeContextTokens:64000,hostTokenBudget:16000,hostBudgetScope:'history_only',input:['text']}});}
const wire=(p:any)=>p.messages.map((m:any)=>typeof m.content==='string'?m.content:m.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n')).join('\n');

test('clean schema baseline, lowercase definitions route through ordinary ingest compile search and plan',()=>{const f=fixture();try{
 assert.equal(SCHEMA_VERSION,1);assert.equal(f.store.db.prepare('SELECT checksum FROM schema_migrations').get()!.checksum,SCHEMA_CHECKSUM);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('lexicon_priors','symbol_bm25_index')").get()!.n,0);
 const text=['library','load','write','state','value'].map(name=>`def ${name}(arg):\n    marker = '${name} implementation'\n    return arg\n`).join('\n');
 const s=f.store.ingestSource({originKey:'pkg/core.py',text});const c=new ContextForgeCompiler(f.store);c.compile();
 assert.equal(f.store.readSourceBlob(s.sourceId).toString(),text);assert.equal(c.lintWiki().ok,true);
 for(const name of ['library','load','write','state','value']){assert.ok(f.store.search(name,{layers:[2]}).length,name);assert.ok(wire(plan(f.store,name)).includes(`def ${name}(arg):`),name);}
 const first=c.compile().deterministicOutputSha256;assert.equal(c.compile().deterministicOutputSha256,first);
}finally{f.clean();}});

test('ordinary retrieval hydrates a whole decorated function and exact support spans',()=>{const f=fixture();try{
 const body='@logged\ndef load(value):\n'+Array.from({length:35},(_,i)=>`    item_${i} = value + ${i}\n`).join('')+'    result = "uniqueWitness"\n    return result\n';
 const text='# preamble\nimport os\n'+body+'\n'+Array.from({length:300},(_,i)=>`def spare_${i}():\n    return ${i}\n`).join('\n');
 const s=f.store.ingestSource({originKey:'pkg/service.py',text});new ContextForgeCompiler(f.store).compile();
 const candidate=buildEvidenceWindow(f.store,s.sourceId,analyzeRecallQuery('uniqueWitness'))!;
 assert.ok(candidate.text.includes(body));assert.ok(candidate.trace.structuralUnits.some((u:any)=>u.whole&&u.symbolPath.endsWith('::load')));
 for(const id of candidate.spanIds){const p=f.store.readEvidenceSpan(id);assert.equal(p.text,Buffer.from(text).subarray(p.byteStart,p.byteEnd).toString());}
 assert.ok(wire(plan(f.store,'uniqueWitness')).includes(body));
}finally{f.clean();}});

test('oversized function hydrates matched part plus signature with persisted continuation metadata',()=>{const f=fixture();try{
 const text='@logged\ndef processPayload(value):\n'+Array.from({length:700},(_,i)=>`    item_${i} = '${i===420?'rareContinuityWitness':'🙂 padding'}'\n`).join('')+'    return value\n';
 const s=f.store.ingestSource({originKey:'pkg/huge.py',text});const c=new ContextForgeCompiler(f.store);c.compile();
 const units=f.store.getStructuralUnits(s.sourceId);const part=units.find(u=>u.kind==='part'&&Buffer.from(text).subarray(u.byteStart,u.byteEnd).includes(Buffer.from('rareContinuityWitness')))!;
 assert.ok(part);assert.ok(part.previousPartId);assert.ok(part.nextPartId);
 const pages=f.store.db.prepare("SELECT canonical_json FROM derived_nodes WHERE layer=2 AND logical_key LIKE 'wiki/structure/%' AND status='active'").all().map(r=>JSON.parse(String(r.canonical_json)));
 assert.ok(pages.some(p=>p.entries.some((e:any)=>e.structural?.unitId===part.unitId&&e.structural.previousPartId===part.previousPartId)));
 const hit=buildEvidenceWindow(f.store,s.sourceId,analyzeRecallQuery('rareContinuityWitness'))!;
 assert.match(hit.text,/@logged\ndef processPayload\(value\):/);assert.match(hit.text,/rareContinuityWitness/);assert.match(hit.derivedText!,/part-\d+ of \d+/);assert.ok(Buffer.byteLength(hit.text)<10000);assert.ok(!hit.text.includes('�'));
 assert.match(wire(plan(f.store,'rareContinuityWitness')),/part-\d+ of \d+/);
 const strict=planContext({store:f.store,query:'rareContinuityWitness',sessionId:'strict',admissionId:'parts',rawSystemPrompt:'Be precise.',sourceIds:[s.sourceId],strictExplicitObligationsOnly:true,envelope:{nativeContextTokens:16000,hostTokenBudget:3000,hostBudgetScope:'history_only',input:['text']}});assert.match(wire(strict),/part-\d+ of \d+/);assert.equal(c.lintWiki().ok,true);
}finally{f.clean();}});

test('README fenced examples stay orientation and stream coordinates bind unchanged raw bytes',()=>{const f=fixture();try{
 const text='outside🙂\n[start of README.md]\n# Architecture\nOverview of ZebraEngine.\n```python\nclass Example:\n    pass\n```\n[end of README.md]\nbetween\n[start of src/code.py]\ndef ZebraEngine():\n    return 7\n[end of src/code.py]\nafter\n';
 const s=f.store.ingestSource({originKey:'repository.dump',text});new ContextForgeCompiler(f.store).compile();const units=f.store.getStructuralUnits(s.sourceId);
 assert.ok(units.some(u=>u.originKey==='README.md'&&u.orientation));assert.ok(!units.some(u=>u.originKey==='README.md'&&u.kind==='block'));
 const fn=units.find(u=>u.symbolName==='ZebraEngine')!;assert.equal(fn.startLine,12);assert.equal(Buffer.from(text).subarray(fn.byteStart,fn.byteEnd).toString(),'def ZebraEngine():\n    return 7\n');assert.equal(f.store.readSourceBlob(s.sourceId).toString(),text);
}finally{f.clean();}});

test('oversized brace-language symbol with nested control blocks retains parent signature and part routing',()=>{const f=fixture();try{
 const text='export function loadPayload(x) {\n'+Array.from({length:400},(_,i)=>`  if (x) { x += ${i}; ${i===280?'/* hiddenBraceWitness */':''} }\n`).join('')+'  return x;\n}\n';
 const source=f.store.ingestSource({originKey:'load.ts',text});new ContextForgeCompiler(f.store).compile();const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('hiddenBraceWitness'))!;
 assert.match(hit.text,/export function loadPayload/);assert.match(hit.text,/hiddenBraceWitness/);assert.match(hit.derivedText!,/loadPayload: part-/);
}finally{f.clean();}});

test('oversized Markdown section hydrates bounded linked documentation with its heading',()=>{const f=fixture();try{
 const text='# Architecture\n'+Array.from({length:500},(_,i)=>`${i===300?'OrientationWitness':'Documentation'} line ${i} describes behavior.\n`).join('');
 const source=f.store.ingestSource({originKey:'README.md',text});new ContextForgeCompiler(f.store).compile();const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('OrientationWitness'))!;
 assert.match(hit.text,/# Architecture/);assert.match(hit.text,/OrientationWitness/);assert.match(hit.derivedText!,/part-/);assert.ok(Buffer.byteLength(hit.text)<10000);
}finally{f.clean();}});

test('cross-file lexical references persist target spans without claiming semantic resolution',()=>{const f=fixture();try{
 const target=f.store.ingestSource({originKey:'lib.py',text:'def load(value):\n    return value\n'});f.store.ingestSource({originKey:'use.py',text:'from lib import load\ndef run(x):\n    return load(x)\n'});
 const compiler=new ContextForgeCompiler(f.store);compiler.compile();const pages=f.store.db.prepare("SELECT canonical_json FROM derived_nodes WHERE layer=2 AND status='active' AND logical_key LIKE 'wiki/structure/%'").all().map(r=>JSON.parse(String(r.canonical_json)));
 const links=pages.flatMap(p=>p.entries).flatMap(e=>e.structuralLinks??[]).filter(l=>l.sourceId===target.sourceId);assert.ok(links.length);for(const l of links){assert.equal(l.relation,'lexical_reference');for(const id of l.spanIds)assert.equal(f.store.readEvidenceSpan(id).sourceId,target.sourceId);}
 assert.equal(compiler.lintWiki().ok,true);
}finally{f.clean();}});

test('structural hydration accounts all range reads and never commits orphan parts under budget exhaustion',()=>{const f=fixture();try{
 const text='def big(x):\n'+Array.from({length:400},(_,i)=>`    item_${i} = '${i===280?'rareWitness':'padding'}'\n`).join('')+'    return x\n';const source=f.store.ingestSource({originKey:'test.py',text});
 const full=(f.store as any).readBlobUnchecked;(f.store as any).readBlobUnchecked=()=>{throw new Error('unbudgeted full-artifact read');};
 for(const maxBytes of [13999,14015,18000]){const budget=createStoreReadBudget({maxBytes,maxInspected:10000});const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('rareWitness'),[],f.store.namespaceId,Infinity,budget)!;
  assert.ok(budget.bytes<=maxBytes);if(hit.trace.structuralUnits?.some((u:any)=>u.partIndex))assert.match(hit.text,/def big/);else assert.equal(hit.trace.structuralIncomplete,true);
 }
 (f.store as any).readBlobUnchecked=full;
}finally{f.clean();}});

test('oversized signatures have bounded exact header support and explicit incompleteness metadata',()=>{const f=fixture();try{
 const text='export function huge('+Array.from({length:1100},(_,i)=>'parameter'+i).join(',')+') {\n  return rareWitness;\n}\n';const source=f.store.ingestSource({originKey:'huge.ts',text});new ContextForgeCompiler(f.store).compile();const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('rareWitness'))!;
 assert.match(hit.text,/export function huge/);assert.match(hit.text,/return rareWitness/);assert.match(hit.derivedText!,/header incomplete/);assert.ok(Buffer.byteLength(hit.text)<10000);
}finally{f.clean();}});

test('compiler upgrades preserve existing dictionary-era databases without seeding or writing obsolete tables',()=>{const f=fixture();try{
 f.store.db.exec("CREATE TABLE lexicon_priors(term TEXT PRIMARY KEY); INSERT INTO lexicon_priors VALUES('legacy'); CREATE TABLE symbol_bm25_index(symbol TEXT);");
 const s=f.store.ingestSource({originKey:'library.py',text:'def library():\n    return 1\n'});new ContextForgeCompiler(f.store).compile();
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM lexicon_priors').get()!.n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM symbol_bm25_index').get()!.n,0);assert.ok(f.store.search('library').length);assert.match(f.store.readSourceBlob(s.sourceId).toString(),/def library/);
}finally{f.clean();}});

test('pre-compile ordinary hydration creates bounded structural spans using explicit schema columns',()=>{const f=fixture();try{
 const body='@logged\ndef load(value):\n    answer = "beforeCompileWitness"\n    return answer\n';const source=f.store.ingestSource({originKey:'early.py',text:'# preamble\n'+body+'\n'+Array.from({length:300},(_,i)=>`def spare_${i}():\n    return ${i}\n`).join('')});
 const full=(f.store as any).readBlobUnchecked;(f.store as any).readBlobUnchecked=()=>{throw new Error('unbudgeted full-artifact read');};const budget=createStoreReadBudget({maxBytes:200000,maxInspected:10000});const hit=buildEvidenceWindow(f.store,source.sourceId,analyzeRecallQuery('beforeCompileWitness'),[],f.store.namespaceId,Infinity,budget)!;
 assert.ok(hit.text.includes(body));assert.ok(hit.trace.structuralUnits.some((u:any)=>u.whole));(f.store as any).readBlobUnchecked=full;
}finally{f.clean();}});

test('packaged entry point and every compiled source are exact build projections',async()=>{
 for(const rel of ['index.ts',...readdirSync(new URL('../src/',import.meta.url)).filter(f=>f.endsWith('.ts')).map(f=>'src/'+f)]){
  const code=readFileSync(new URL('../'+rel,import.meta.url),'utf8');const expected=stripTypeScriptTypes(code,{mode:'transform',sourceUrl:rel}).replace(/(from\s+["']\.?\.\/[^"']+)\.ts(["'])/g,'$1.js$2');
  assert.equal(readFileSync(new URL('../dist/'+rel.replace(/\.ts$/,'.js'),import.meta.url),'utf8'),expected,rel);
 }
 const packaged=await import('../dist/index.js');const source=await import('../index.ts');assert.deepEqual(Object.keys(packaged).sort(),Object.keys(source).sort());
});
