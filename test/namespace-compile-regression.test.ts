import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import type { RoutingEntry } from '../src/compiler.ts';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'cf-namespace-compile-'));
  const path=join(dir,'store.sqlite'),store=new ContextForgeStore(path);
  return {path,store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function structuralEntries(store:ContextForgeStore,namespaceId=store.namespaceId):RoutingEntry[] {
  return store.db.prepare("SELECT canonical_json FROM derived_nodes WHERE namespace_id=? AND layer=2 AND status='active' AND logical_key LIKE 'wiki/structure/%'").all(namespaceId)
    .flatMap(row=>JSON.parse(String(row.canonical_json)).entries);
}
function ordinarySources(store:ContextForgeStore) {
  return [
    {originKey:'caller.py',text:'from library import transform\ndef execute(value):\n    return transform(value)\n'},
    {originKey:'library.py',text:'def transform(value):\n    return value + 1\n'},
    {originKey:'other.py',text:'def separate(value):\n    return value * 2\n'},
  ].map((source,i)=>store.ingestSource({...source,observedAt:1700000000000+i}));
}

test('compileSource(first) already compiles all three sources and persists cross-source structure',()=>{
  const f=fixture();try {
    const sources=ordinarySources(f.store),compiler=new ContextForgeCompiler(f.store);
    // Regenerable source units exist before compilation; persisted L2 pages do not.
    assert.equal(structuralEntries(f.store).length,0);
    for(const source of sources)assert.ok(f.store.getStructuralUnits(source.sourceId).length);
    const result=compiler.compileSource(sources[0].sourceId);
    assert.deepEqual(result.sourceIds,sources.map(s=>s.sourceId).sort());
    assert.deepEqual(result.unprocessedSourceIds,[]);
    const entries=structuralEntries(f.store);
    for(const source of sources) {
      const own=entries.filter(entry=>entry.sourceId===source.sourceId);
      assert.ok(own.length,`persisted structure for ${source.originKey}`);
      for(const entry of own)for(const spanId of entry.spanIds) {
        const span=f.store.readEvidenceSpan(spanId);
        assert.equal(span.sourceId,source.sourceId);
        assert.equal(span.text,f.store.readSourceBlob(source.sourceId).subarray(span.byteStart,span.byteEnd).toString());
      }
    }
    // The target was never passed to compileSource, but is compiled and linked.
    const caller=entries.find(entry=>entry.structural?.symbolName==='execute')!;
    const link=caller.structuralLinks?.find(link=>link.sourceId===sources[1].sourceId);
    assert.ok(link);assert.equal(link.relation,'lexical_reference');
    for(const spanId of link.spanIds)assert.equal(f.store.readEvidenceSpan(spanId).sourceId,sources[1].sourceId);
    assert.deepEqual(compiler.lintWiki(),{ok:true,provenanceGaps:0,issues:[]});
    // Explicit alias changes no output, node identity, or lifecycle state.
    for(const repeated of [compiler.compileNamespace(),compiler.compileNamespace(f.store.namespaceId),compiler.compile()]) {
      assert.equal(repeated.deterministicOutputSha256,result.deterministicOutputSha256);
      assert.deepEqual(repeated.nodeIds,result.nodeIds);
      assert.deepEqual(repeated.createdNodeIds,[]);assert.deepEqual(repeated.revisedNodeIds,[]);assert.deepEqual(repeated.retiredNodeIds,[]);
    }
    const reopened=new ContextForgeStore(f.path);try {
      assert.equal(structuralEntries(reopened).length,entries.length);
      const c=new ContextForgeCompiler(reopened);
      assert.equal(c.compileNamespace().deterministicOutputSha256,result.deterministicOutputSha256);
      assert.equal(c.lintWiki().ok,true);
    } finally {reopened.close();}
  } finally {f.clean();}
});

test('compileNamespace delegates once to the existing implementation owner',()=>{
  const f=fixture();try {
    ordinarySources(f.store);const compiler=new ContextForgeCompiler(f.store);
    const compile=compiler.compile.bind(compiler),calls:string[]=[];
    compiler.compile=(namespaceId=f.store.namespaceId)=>{calls.push(namespaceId);return compile(namespaceId);};
    const result=compiler.compileNamespace();
    assert.deepEqual(calls,[f.store.namespaceId]);assert.equal(result.sourceIds.length,3);
  } finally {f.clean();}
});

test('namespace compilation preserves withdrawal, authorization and source isolation',()=>{
  const f=fixture();const other=new ContextForgeStore({dbPath:f.path,ownerId:'other-owner'});
  try {
    const sources=ordinarySources(f.store),compiler=new ContextForgeCompiler(f.store);
    const foreign=other.ingestSource({originKey:'foreign.py',text:'def foreign_only():\n    return 99\n'});
    const foreignCompiler=new ContextForgeCompiler(other),foreignResult=foreignCompiler.compileNamespace();
    const foreignBefore=JSON.stringify(structuralEntries(other));
    compiler.compileSource(sources[0].sourceId);
    f.store.withdrawSource(sources[1].sourceId);
    const added=f.store.ingestSource({originKey:'new.py',text:'def newly_added():\n    return 3\n'});
    const result=compiler.compileNamespace();
    assert.deepEqual(result.sourceIds,[sources[0].sourceId,sources[2].sourceId,added.sourceId].sort());
    const entries=structuralEntries(f.store);
    assert.ok(entries.some(entry=>entry.sourceId===added.sourceId));
    assert.ok(entries.every(entry=>entry.sourceId!==sources[1].sourceId&&entry.sourceId!==foreign.sourceId));
    assert.ok(entries.every(entry=>(entry.structuralLinks??[]).every(link=>link.sourceId!==sources[1].sourceId&&link.sourceId!==foreign.sourceId)));
    assert.equal(f.store.getSource(sources[1].sourceId)!.status,'withdrawn');
    assert.throws(()=>f.store.readSourceBlob(sources[1].sourceId),/SourceRevoked/);
    assert.equal(JSON.stringify(structuralEntries(other)),foreignBefore);
    assert.equal(foreignCompiler.compileNamespace().deterministicOutputSha256,foreignResult.deterministicOutputSha256);
    assert.throws(()=>compiler.compileNamespace(other.namespaceId),/Namespace access denied/);
    assert.throws(()=>compiler.compileSource(foreign.sourceId),/Namespace access denied/);
    assert.throws(()=>compiler.compileSource('missing-source'),/Unknown source/);
    // Existing behavior: even a withdrawn source is a namespace selector, not a source-only compile.
    assert.equal(compiler.compileSource(sources[1].sourceId).deterministicOutputSha256,result.deterministicOutputSha256);
    assert.deepEqual(compiler.lintWiki(),{ok:true,provenanceGaps:0,issues:[]});
  } finally {other.close();f.clean();}
});

test('processed text with no recognized structure is not an uncompiled source',()=>{
  const f=fixture();try {
    const source=f.store.ingestSource({originKey:'plain-record',text:'ordinary words without code declarations'});
    const compiler=new ContextForgeCompiler(f.store),result=compiler.compileSource(source.sourceId);
    assert.deepEqual(result.sourceIds,[source.sourceId]);assert.deepEqual(result.unprocessedSourceIds,[]);
    assert.equal(f.store.getStructuralUnits(source.sourceId).length,0);
    assert.equal(structuralEntries(f.store).length,0);
    assert.ok(f.store.db.prepare("SELECT node_id FROM derived_nodes WHERE status='active' AND logical_key=?").get(`wiki/sources/${source.sourceId}`));
    assert.equal(compiler.lintWiki().ok,true);
  } finally {f.clean();}
});
