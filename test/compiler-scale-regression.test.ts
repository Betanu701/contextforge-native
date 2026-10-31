import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore, sha256 } from '../src/store.ts';
import { ContextForgeCompiler, WIKI_COMPILER_VERSION } from '../src/compiler.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'cf-compiler-scale-'));const path=join(dir,'db');const store=new ContextForgeStore(path);return {dir,path,store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}};}

// Deliberately high-cardinality lexical/status hints, not controlled assertions.
// This formerly projected every row into many redundant entity/status pages.
function representativeText(){
  const lines=['Fact: Observatory | owner = Ada\r\n'];let size=Buffer.byteLength(lines[0]);
  for(let i=0;size<2*1024*1024+8192;i++){
    const line=`Instrument-${i} status changed only when Sensor-${i} reports anomaly; Café 🙂 measurement payload ${'abcdefghijklmnopqrstuvwxyz '.repeat(5)}\r\n`;
    lines.push(line);size+=Buffer.byteLength(line);
  }
  lines.push('State: Observatory | mode = ready\n');return lines.join('');
}

test('multi-MB compiler keeps lossless range coverage with bounded redundant projections and deterministic recompilation',()=>{
  const f=fixture();try{
    const text=representativeText(),bytes=Buffer.from(text),start=performance.now();
    const source=f.store.ingestSource({originKey:'telemetry.capture',text,role:'user',observedAt:1700000000000});
    const ingestMs=performance.now()-start;
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const support=String(f.store.db.prepare('SELECT span_id FROM spans WHERE source_id=? ORDER BY byte_start LIMIT 1').get(source.sourceId)!.span_id);
    const obsolete=f.store.publishNode({namespaceId:f.store.namespaceId,layer:2,logicalKey:'wiki/entities/obsolete-legacy-projection',kind:'wiki',title:'Legacy',body:'Legacy',canonical:{template:WIKI_COMPILER_VERSION},compilerVersion:WIKI_COMPILER_VERSION,observedAt:1700000000000,spanIds:[support],extractionRule:WIKI_COMPILER_VERSION});
    const compiler=new ContextForgeCompiler(f.store),compileStart=performance.now(),first=compiler.compile(),compileMs=performance.now()-compileStart;
    assert.ok(first.retiredNodeIds.includes(obsolete.nodeId),'obsolete compiler-owned projections retire during upgrade');
    const walBytes=statSync(f.path+'-wal').size;
    assert.deepEqual(f.store.readSourceBlob(source.sourceId),bytes);assert.equal(source.contentSha256,sha256(bytes));
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM facts').get()!.n,2);
    const pages=f.store.db.prepare("SELECT logical_key,canonical_json FROM derived_nodes WHERE layer=2 AND status='active' ORDER BY logical_key").all();
    const sourcePages=pages.filter(p=>String(p.logical_key).startsWith(`wiki/sources/${source.sourceId}`));
    const entries=sourcePages.flatMap(p=>JSON.parse(String(p.canonical_json)).entries).sort((a,b)=>a.ordinal-b.ordinal);
    assert.equal(entries.map(e=>e.text).join(''),text);
    assert.ok(entries.some(e=>e.spans.length>1),'grouping retains multiple exact support spans');
    let next=0;for(const entry of entries){assert.ok(Buffer.byteLength(entry.text)<=4096);assert.ok(entry.spans.length<=64);for(const span of entry.spans){assert.equal(span.byteStart,next);next=span.byteEnd;}}assert.equal(next,bytes.length);
    const sampled=pages.filter(p=>JSON.parse(String(p.canonical_json)).omission);
    assert.ok(sampled.length>0);for(const p of sampled){const c=JSON.parse(String(p.canonical_json));assert.equal(c.omission.includedEntries,c.entries.length);assert.equal(c.omission.totalEntries,entries.length);assert.ok(c.omission.omittedEntries>0);assert.equal(c.omission.complete,false);}
    assert.ok(pages.length<600,`unexpected projection fanout: ${pages.length}`);
    assert.ok(walBytes<96*1024*1024,`unexpected compile WAL: ${walBytes}`);
    // Generous CI guard; report real timings rather than treating this as a benchmark promise.
    assert.ok(compileMs<30000,`compile exceeded seconds-scale envelope: ${compileMs}`);
    const repeatStart=performance.now(),second=compiler.compile(),repeatMs=performance.now()-repeatStart;
    assert.equal(second.deterministicOutputSha256,first.deterministicOutputSha256);assert.equal(second.createdNodeIds.length,0);assert.equal(second.revisedNodeIds.length,0);
    // Lint must not hydrate full artifacts; range reader still checks quote hashes.
    const readBlob=f.store.readBlob;(f.store as any).readBlob=()=>{throw new Error('full artifact read during lint');};
    const lintStart=performance.now();assert.equal(compiler.lintWiki().ok,true);const lintMs=performance.now()-lintStart;f.store.readBlob=readBlob;
    console.log(JSON.stringify({fixtureBytes:bytes.length,ingestMs:Math.round(ingestMs),compileMs:Math.round(compileMs),repeatMs:Math.round(repeatMs),lintMs:Math.round(lintMs),walBytes,rssBytes:process.memoryUsage().rss,maxRssKiB:process.resourceUsage().maxRSS,l2Pages:pages.length,sourceEntries:entries.length}));
    f.store.withdrawSource(source.sourceId);compiler.compile();assert.equal(f.store.db.prepare("SELECT count(*) n FROM derived_nodes WHERE status='active'").get()!.n,0);assert.equal(compiler.lintWiki().ok,true);
  }finally{f.clean();}
});

test('bounded compiler lint still detects same-size CAS quote corruption',()=>{
  const f=fixture();try{
    const text='ordinary evidence '.repeat(5000),source=f.store.ingestSource({originKey:'opaque.capture',text});const compiler=new ContextForgeCompiler(f.store);compiler.compile();
    const blob=f.store.db.prepare('SELECT relative_path FROM blobs WHERE sha256=?').get(source.contentSha256)!;
    const fd=openSync(join(f.store.blobRoot,String(blob.relative_path)),'r+');try{writeSync(fd,Buffer.from('X'),0,1,7);}finally{closeSync(fd);}
    const lint=compiler.lintWiki();assert.equal(lint.ok,false);assert.ok(lint.issues.some(i=>i.code==='quote_hash_mismatch'));
  }finally{f.clean();}
});
