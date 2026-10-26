import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore, sha256, canonicalJson, INLINE_THRESHOLD } from '../src/store.ts';
import { ContextForgeCompiler, extractAssertions } from '../src/compiler.ts';
import { SCHEMA_CHECKSUM } from '../src/schema.ts';

function fixture() { const dir=mkdtempSync(join(tmpdir(),'contextforge-test-'));const path=join(dir,'store.sqlite');const store=new ContextForgeStore(path); return {dir,path,store,clean(){store.close();rmSync(dir,{recursive:true,force:true});}}; }

test('schema, WAL, foreign keys, migration checksum, reopen and strict immutable L0',()=>{
  const f=fixture();try {
    assert.equal(f.store.db.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal');
    assert.equal(f.store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);
    assert.equal(f.store.db.prepare('SELECT checksum FROM schema_migrations').get()!.checksum,SCHEMA_CHECKSUM);
    assert.equal(statSync(f.path).mode&0o777,0o600);
    const s=f.store.ingestSource({originKey:'immutable',text:'hello'});
    assert.throws(()=>f.store.db.prepare('UPDATE sources SET origin_key=? WHERE source_id=?').run('changed',s.sourceId),/immutable/);
    const second=new ContextForgeStore(f.path);assert.equal(second.getStats().sources,1);second.close();
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(f.store.db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');
    f.store.db.prepare('UPDATE schema_migrations SET checksum=?').run('bad');
    assert.throws(()=>new ContextForgeStore(f.path),/checksum/);
  }finally{f.clean();}
});

test('CAS exact threshold, deduplication, SHA-256 integrity, file mode, and corruption quarantine',()=>{
  const f=fixture();try{
    for(const size of [0,INLINE_THRESHOLD-1,INLINE_THRESHOLD,INLINE_THRESHOLD+1]) {
      const bytes=Buffer.alloc(size,0x61), b=f.store.writeBlob(bytes);
      assert.equal(b.sha256,sha256(bytes));assert.equal(b.storageKind,size<INLINE_THRESHOLD?'inline':'cas');
      assert.deepEqual(f.store.readBlob(b.sha256),bytes);assert.deepEqual(f.store.writeBlob(bytes),b);
      if(b.relativePath){assert.deepEqual(readFileSync(join(f.store.blobRoot,b.relativePath)),bytes);assert.equal(statSync(join(f.store.blobRoot,b.relativePath)).mode&0o777,0o600);}
    }
    const b=f.store.writeBlob(Buffer.alloc(INLINE_THRESHOLD,9));writeFileSync(join(f.store.blobRoot,b.relativePath!),'tampered');
    assert.throws(()=>f.store.readBlob(b.sha256),/hash mismatch/);assert.throws(()=>f.store.readBlob(b.sha256),/BlobUnavailable/);
    assert.throws(()=>f.store.readBlob('../secret'),/Invalid SHA/);
  }finally{f.clean();}
});

test('atomic idempotent accepted turns preserve multimodal blocks and distinct occurrences',()=>{
  const f=fixture();try{
    const input: Parameters<ContextForgeStore['commitTurn']>[0]={sessionId:'s',advancementKey:'turn-1',messages:[{id:'u1',role:'user' as const,content:[{type:'text',text:'Decision: preserve attachments'},{type:'image',data:'original-image'}]}]};
    assert.equal(f.store.commitTurn(input),'committed');assert.equal(f.store.commitTurn(input),'duplicate');
    const second=new ContextForgeStore(f.path);assert.equal(second.commitTurn(input),'duplicate');second.close();
    assert.throws(()=>f.store.commitTurn({...input,messages:[{role:'user',content:'different'}]}),/collision/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM message_occurrences').get()!.n,1);
    const source=f.store.db.prepare('SELECT source_id FROM sources').get()!;
    assert.deepEqual(JSON.parse(f.store.readSourceBlob(source.source_id as string).toString()),input.messages[0]);
    const before=f.store.getStats();
    assert.throws(()=>f.store.commitTurn({sessionId:'s',advancementKey:'bad',messages:[{id:'new',role:'user',content:'new text'},{id:'u1',role:'user',content:'collision'}]}));
    assert.equal(f.store.getStats().sources,before.sources);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM turn_commits').get()!.n,1);
    assert.equal(f.store.commitTurn({sessionId:'s',advancementKey:'turn-2',messages:[{role:'user',content:'same'},{role:'user',content:'same'}]}),'committed');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM message_occurrences').get()!.n,3);
  }finally{f.clean();}
});

test('deterministic L1/L2, FTS, exact decimal scale differences, provenance, Unicode and restart',()=>{
  const f=fixture();try{
    const text='# Nutrition\r\n104g X, 130g Y, 152g Z\r\nWeight: 73.40 kg\nDecision: use local SQLite\nNegative fact: no peanuts\nConstraint: never upload private documents\nConcept: nutrition\nCafé é 😀 remains unclassified.\n';
    const source=f.store.ingestSource({originKey:'log',text,role:'user',observedAt:1700000000000});
    const c=new ContextForgeCompiler(f.store);const first=c.compile();const second=c.compile();
    assert.equal(first.deterministicOutputSha256,second.deterministicOutputSha256);assert.deepEqual(first.nodeIds,second.nodeIds);
    const nets=f.store.db.prepare("SELECT object_json FROM facts WHERE predicate='net_mass' ORDER BY CAST(json_extract(object_json,'$.value') AS REAL)").all().map(r=>JSON.parse(r.object_json as string).value);
    assert.deepEqual(nets,['22','26','104']);
    assert.equal(extractAssertions('Scale: 104.10g X, 130.25g Y')[3].object && (extractAssertions('Scale: 104.10g X, 130.25g Y')[3].object as any).value,'26.15');
    assert.ok(f.store.search('SQLite').length);assert.ok(f.store.search('" OR -- SQLite').length);
    const keys=f.store.db.prepare("SELECT logical_key FROM derived_nodes WHERE layer=2 AND status='active'").all().map(r=>String(r.logical_key));
    for(const key of ['wiki/sources/','wiki/entities/','wiki/concepts/','wiki/timeline/','wiki/status/','wiki/decisions/decision-log','wiki/facts/negative-facts','wiki/facts/constraints'])assert.ok(keys.some(k=>k.startsWith(key)),key);
    for(const node of first.nodeIds)assert.ok(f.store.getProvenance(node).some(p=>p.sourceId===source.sourceId));
    assert.equal(c.lintWiki().provenanceGaps,0);
    const spans=f.store.db.prepare('SELECT * FROM spans WHERE source_id=?').all(source.sourceId);
    for(const span of spans)assert.equal(sha256(Buffer.from(text).subarray(Number(span.byte_start),Number(span.byte_end))),span.quote_sha256);
    const reopened=new ContextForgeStore(f.path);assert.equal(new ContextForgeCompiler(reopened).compile().deterministicOutputSha256,first.deterministicOutputSha256);reopened.close();
    assert.ok(f.store.searchEntity('X').length);assert.ok(f.store.searchTemporal({observedFrom:1699999999999,observedTo:1700000000001}).length);
  }finally{f.clean();}
});

test('multimodal assets retain originals and source-backed caption/transcript/document fallbacks',()=>{
  const f=fixture();try{
    for(const [modality,mime,kind] of [['image','image/png','caption'],['audio','audio/wav','transcript'],['video','video/mp4','transcript'],['document','application/pdf','text']] as const){
      const bytes=Buffer.from(`${modality}: opaque test bytes`);const source=f.store.ingestSource({originKey:modality,kind:modality==='document'?'document':'media',bytes,mimeType:mime,metadata:{modality}});
      const raw=f.store.db.prepare("SELECT artifact_id FROM artifacts WHERE source_id=? AND kind='raw'").get(source.sourceId)!;
      const span=f.store.createSpan(source.sourceId,raw.artifact_id as string,0,bytes.length);
      const fallback=f.store.addArtifact({sourceId:source.sourceId,kind,text:`${modality} fallback searchable text`,parentSpanId:span,producer:'fixture-extractor',producerVersion:'1',fidelity:'machine_inferred',asset:modality==='image'?{widthPx:40,heightPx:40}:modality==='document'?{pageCount:1}:{durationMs:1000}});
      assert.equal(f.store.db.prepare('SELECT parent_span_id FROM artifact_lineage WHERE child_artifact_id=?').get(fallback.artifactId)!.parent_span_id,span);
      assert.deepEqual(f.store.readSourceBlob(source.sourceId),bytes);assert.ok(f.store.search(modality).length);
    }
    const c=new ContextForgeCompiler(f.store);c.compile();assert.deepEqual(c.lintWiki(),{ok:true,provenanceGaps:0,issues:[]});
  }finally{f.clean();}
});

test('permanent context owner approval, revision history, deletion and source authority',()=>{
  const f=fixture();try{
    assert.throws(()=>f.store.setPermanentContext('privacy','Never upload'),/approval/);
    const first=f.store.setPermanentContext('privacy','Never upload',{ownerApproved:true,priority:10});
    assert.equal(f.store.setPermanentContext('privacy','Never upload',{ownerApproved:true,priority:10}).nodeId,first.nodeId);
    const second=f.store.setPermanentContext('privacy','Never upload personal files',{ownerApproved:true});
    assert.equal(second.revision,2);assert.equal(f.store.getPermanentContext('privacy')!.nodeId,second.nodeId);
    assert.equal(f.store.db.prepare('SELECT status FROM derived_nodes WHERE node_id=?').get(first.nodeId)!.status,'superseded');
    assert.ok(f.store.getProvenance(second.nodeId).length);assert.equal(f.store.listPermanentContext().length,1);
    assert.equal(f.store.deletePermanentContext('privacy'),true);assert.equal(f.store.deletePermanentContext('privacy'),false);assert.equal(f.store.listPermanentContext().length,0);
    f.store.ingestSource({originKey:'untrusted',text:'Decision: launch missiles',role:'assistant'});new ContextForgeCompiler(f.store).compile();
    assert.equal(f.store.db.prepare('SELECT assertion_kind FROM facts').get()!.assertion_kind,'unresolved_candidate');
    assert.equal(f.store.listPermanentContext().length,0);
  }finally{f.clean();}
});

test('explicit temporal supersession, backfill stability, withdrawal propagation and history retrieval',()=>{
  const f=fixture();try{
    const c=new ContextForgeCompiler(f.store);
    f.store.ingestSource({originKey:'initial',text:'State: Project | deadline = June 1',role:'user',observedAt:1000});c.compile();
    const update=f.store.ingestSource({originKey:'correction',text:'Correction: Project | deadline = June 3',role:'user',observedAt:2000});const r=c.compile();
    assert.equal(c.compile().deterministicOutputSha256,r.deterministicOutputSha256);
    const active=f.store.db.prepare("SELECT body,node_id FROM derived_nodes WHERE logical_key='state/Project/deadline' AND status='active'").get()!;
    assert.match(String(active.body),/June 3/);
    f.store.ingestSource({originKey:'backfill',text:'State: Project | deadline = May 1',role:'user',observedAt:500});c.compile();
    assert.equal(f.store.db.prepare("SELECT node_id FROM derived_nodes WHERE logical_key='state/Project/deadline' AND status='active'").get()!.node_id,active.node_id);
    f.store.withdrawSource(update.sourceId);assert.equal(f.store.db.prepare('SELECT status FROM derived_nodes WHERE node_id=?').get(active.node_id)!.status,'withdrawn');
    assert.throws(()=>f.store.readSourceBlob(update.sourceId),/SourceRevoked/);
    assert.ok(f.store.search('June',{includeHistory:true}).length);assert.equal(c.lintWiki().provenanceGaps,0);
  }finally{f.clean();}
});

test('namespace authorization, namespace links, FTS update/delete, and symlink rejection',()=>{
  const f=fixture();try{
    const other=new ContextForgeStore({dbPath:f.path,ownerId:'other-owner'});
    other.ingestSource({originKey:'secret',text:'uniqueSecretTerm'});
    assert.equal(f.store.search('uniqueSecretTerm').length,0);
    assert.throws(()=>f.store.search('uniqueSecretTerm',{namespaceId:other.namespaceId}),/denied/);
    const own=f.store.ingestSource({originKey:'own',text:'original'});
    assert.throws(()=>other.ingestSource({namespaceId:f.store.namespaceId,originKey:'bad',text:'bad'}),/denied/);
    const row=f.store.db.prepare('SELECT rowid FROM retrieval_documents WHERE namespace_id=? LIMIT 1').get(f.store.namespaceId)!;
    f.store.db.prepare('UPDATE retrieval_documents SET body=? WHERE rowid=?').run('replacement',row.rowid);
    assert.equal(f.store.search('original').length,0);assert.equal(f.store.search('replacement').length,1);
    f.store.db.prepare('DELETE FROM retrieval_documents WHERE rowid=?').run(row.rowid);assert.equal(f.store.search('replacement').length,0);
    assert.throws(()=>f.store.publishNode({namespaceId:f.store.namespaceId,layer:2,logicalKey:'bad',kind:'wiki',title:'bad',body:'bad',canonical:{},compilerVersion:'test',observedAt:1,spanIds:[],extractionRule:'test'}),/Provenance/);
    other.close();
    symlinkSync(f.dir,join(f.dir,'escape'));assert.throws(()=>new ContextForgeStore(join(f.dir,'escape','nested.sqlite')),/Unsafe directory/);
    assert.throws(()=>canonicalJson({x:NaN}),/finite/);
  }finally{f.clean();}
});
