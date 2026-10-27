import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, unlinkSync, existsSync, constants } from 'node:fs';
import { resolve, dirname, join, parse } from 'node:path';
import { configureDatabase, migrate } from './schema.ts';
import type { AcceptedMessage, ArtifactKind, ArtifactRecord, BlobRecord, ContextForgeConfig, DerivedNodeRecord, IngestSourceInput, JsonValue, MemoryStatus, ProvenanceRecord, PublishNodeInput, SearchOptions, SearchResult, SourceRecord } from './types.ts';

export const COMPILER_VERSION = 'deterministic-v1';
export const INLINE_THRESHOLD = 64 * 1024;
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  throw new TypeError('Canonical JSON requires finite JSON values');
}
export function sha256(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function stableId(domain: string, ...parts: unknown[]): string { return sha256(domain + '\0' + canonicalJson(parts)); }
type Row = Record<string, any>;
function secureDirectory(path: string): string {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory path: ' + current);
  }
  return absolute;
}
function safeFile(path: string): void { if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Unsafe file path'); }
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function sourceRecord(r: Row): SourceRecord { return { sourceId:r.source_id, namespaceId:r.namespace_id, sessionId:r.session_id, kind:r.kind, originSystem:r.origin_system, originKey:r.origin_key, originRevision:r.origin_revision, role:r.role, trustClass:r.trust_class, observedAt:r.observed_at, ingestedAt:r.ingested_at, contentSha256:r.content_sha256, metadata:JSON.parse(r.metadata_json), status:r.status }; }
export function nodeRecord(r: Row): DerivedNodeRecord { return { nodeId:r.node_id, namespaceId:r.namespace_id, layer:r.layer, logicalKey:r.logical_key, revision:r.revision, kind:r.kind, title:r.title, body:r.body, canonical:JSON.parse(r.canonical_json), compilerVersion:r.compiler_version, contentSha256:r.content_sha256, createdAt:r.created_at, observedAt:r.observed_at, status:r.status, validFrom:r.valid_from, validTo:r.valid_to, supersededBy:r.superseded_by }; }

/** Synchronous storage core. Host integration MUST run this in its dedicated writer worker. */
export class ContextForgeStore {
  readonly db: DatabaseSync;
  readonly blobRoot: string;
  readonly namespaceId: string;
  readonly ownerId: string;
  private depth = 0;
  private readonly writtenBlobs = new Set<string>();
  constructor(config: ContextForgeConfig | string) {
    if (typeof config === 'string') config = { dbPath: config };
    if (config.dbPath === ':memory:') throw new Error('Use a file-backed database: WAL durability is required');
    const path = resolve(config.dbPath); secureDirectory(dirname(path)); safeFile(path);
    this.blobRoot = secureDirectory(config.blobRoot ?? join(dirname(path), 'contextforge', 'blobs', 'sha256'));
    this.ownerId = config.ownerId ?? 'local-owner';
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      chmodSync(path, 0o600); configureDatabase(this.db); migrate(this.db);
      if (this.db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') throw new Error('WAL unavailable');
      this.namespaceId = this.resolveNamespace({ namespaceId:config.namespaceId, scopeKind:config.scopeKind, scopeKey:config.scopeKey });
    } catch (e) { this.db.close(); throw e; }
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T {
    const savepoint = `cf_${this.depth}`; const outer = this.depth++ === 0;
    try {
      this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      const result = fn();
      if (result && typeof (result as any).then === 'function') throw new Error('Async transactions are forbidden');
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`); return result;
    } catch (e) { this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw e; }
    finally { this.depth--; }
  }
  resolveNamespace(options: { namespaceId?: string; scopeKind?: ContextForgeConfig['scopeKind']; scopeKey?: string } = {}): string {
    const kind = options.scopeKind ?? 'personal', key = options.scopeKey ?? 'default';
    const id = options.namespaceId ?? stableId('cf-namespace-v1', this.ownerId, kind, key);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM namespaces WHERE namespace_id=?').get(id);
      if (existing) { this.assertNamespace(id, 'write'); return id; }
      this.db.prepare('INSERT INTO namespaces(namespace_id,owner_id,scope_kind,scope_key,policy_json,created_at) VALUES(?,?,?,?,?,?)').run(id,this.ownerId,kind,key,'{}',Date.now());
      return id;
    });
  }
  assertNamespace(id: string, permission: 'read' | 'write' = 'read'): void {
    const row = this.db.prepare(`SELECT 1 FROM namespaces n WHERE namespace_id=? AND (owner_id=? OR EXISTS
      (SELECT 1 FROM namespace_grants g WHERE g.namespace_id=n.namespace_id AND g.principal_id=? AND (g.permission='admin' OR g.permission=?)))`).get(id,this.ownerId,this.ownerId,permission);
    if (!row) throw new Error('Namespace access denied');
  }
  ensureSession(sessionId: string, namespaceId = this.namespaceId): void {
    this.assertNamespace(namespaceId,'write');
    const row = this.db.prepare('SELECT namespace_id FROM sessions WHERE session_id=?').get(sessionId);
    if (row && row.namespace_id !== namespaceId) throw new Error('Session namespace mismatch');
    this.db.prepare('INSERT OR IGNORE INTO sessions(session_id,namespace_id,host_session_key,created_at) VALUES(?,?,?,?)').run(sessionId,namespaceId,sessionId,Date.now());
  }
  writeBlob(input: Uint8Array | string): BlobRecord {
    const bytes = Buffer.from(input), hash = sha256(bytes);
    this.writtenBlobs.add(hash);
    const old = this.db.prepare('SELECT * FROM blobs WHERE sha256=?').get(hash);
    if (old) { this.readBlobUnchecked(hash); return { sha256:hash,byteLength:bytes.length,storageKind:old.storage_kind as 'inline'|'cas',relativePath:old.relative_path as string|null }; }
    const inline = bytes.length < INLINE_THRESHOLD;
    const relativePath = inline ? null : join(hash.slice(0,2),hash.slice(2,4),hash);
    if (relativePath) {
      const target = join(this.blobRoot,relativePath), dir = secureDirectory(dirname(target)); safeFile(target);
      if (existsSync(target)) {
        const current = readFileSync(target); if (current.length !== bytes.length || sha256(current) !== hash) throw new Error('CAS collision/corruption');
      } else {
        const temp = join(dir, '.' + randomUUID() + '.tmp'); let fd: number | undefined;
        try { fd = openSync(temp,'wx',0o600); writeFileSync(fd,bytes); fsyncSync(fd); closeSync(fd); fd=undefined; renameSync(temp,target); syncDirectory(dir); }
        finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO blobs VALUES(?,?,?,?,?,?,?)').run(hash,bytes.length,inline?'inline':'cas',inline?bytes:null,relativePath,'ready',Date.now());
    return { sha256:hash,byteLength:bytes.length,storageKind:inline?'inline':'cas',relativePath };
  }
  /** Blob hydration requires custody in an accessible namespace (not possession of a hash). */
  readBlob(hash: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid SHA-256');
    const authorized=this.db.prepare(`SELECT 1 FROM sources s JOIN namespaces n USING(namespace_id)
      LEFT JOIN artifacts a ON a.source_id=s.source_id WHERE (s.content_sha256=? OR a.blob_sha256=?)
      AND (n.owner_id=? OR EXISTS(SELECT 1 FROM namespace_grants g WHERE g.namespace_id=n.namespace_id AND g.principal_id=? AND g.permission IN ('read','admin'))) LIMIT 1`).get(hash,hash,this.ownerId,this.ownerId);
    if(!authorized && !this.writtenBlobs.has(hash)) throw new Error('Blob access denied');
    return this.readBlobUnchecked(hash);
  }
  private readBlobUnchecked(hash: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid SHA-256');
    const row = this.db.prepare('SELECT * FROM blobs WHERE sha256=?').get(hash);
    if (!row || row.state !== 'ready') throw new Error('BlobUnavailable');
    try {
      let bytes: Buffer;
      if (row.storage_kind === 'inline') bytes = Buffer.from(row.inline_bytes as Uint8Array);
      else {
        const expected = join(hash.slice(0,2),hash.slice(2,4),hash);
        if (row.relative_path !== expected) throw new Error('Unsafe CAS path');
        const path = join(this.blobRoot,expected); secureDirectory(dirname(path)); safeFile(path);
        const fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
        try { bytes=readFileSync(fd); } finally { closeSync(fd); }
      }
      if (bytes.length !== row.byte_length || sha256(bytes) !== hash) throw new Error('Blob hash mismatch');
      return bytes;
    } catch (error) { this.db.prepare("UPDATE blobs SET state='quarantined' WHERE sha256=?").run(hash); throw error; }
  }
  readSourceBlob(sourceId: string, includeHistory = false): Buffer {
    const source = this.getSource(sourceId); if (!source || (!includeHistory && source.status !== 'active')) throw new Error('SourceRevoked');
    return this.readBlobUnchecked(source.contentSha256);
  }
  getSource(id: string): SourceRecord | undefined {
    const row=this.db.prepare('SELECT s.*,l.status FROM sources s JOIN source_lifecycle l USING(source_id) WHERE source_id=?').get(id);
    if (!row) return undefined; this.assertNamespace(row.namespace_id as string); return sourceRecord(row);
  }
  ingestSource(input: IngestSourceInput): SourceRecord {
    return this.transaction(() => {
      const ns=input.namespaceId??this.namespaceId; this.assertNamespace(ns,'write');
      if (input.sessionId) this.ensureSession(input.sessionId,ns);
      const bytes=input.bytes??Buffer.from(input.text??''), blob=this.writeBlob(bytes);
      const origin=input.originSystem??'local', revision=input.originRevision??'1';
      const id=stableId('cf-source-v1',ns,origin,input.originKey,revision);
      const old=this.getSource(id); if(old) { if(old.contentSha256!==blob.sha256) throw new Error('Source idempotency collision'); return old; }
      const observed=input.observedAt??Date.now(), role=input.role??null;
      const trust=input.trustClass??(role==='user'?'user_statement':role==='assistant'?'assistant_output':role==='tool'?'tool_output':'external_untrusted');
      if (trust==='owner_instruction' && input.kind!=='policy') throw new Error('Owner instructions require explicit policy ingestion');
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,ns,input.sessionId??null,input.kind??'document',origin,input.originKey,revision,role,trust,observed,Date.now(),blob.sha256,canonicalJson(input.metadata??{}));
      this.db.prepare('INSERT INTO source_lifecycle VALUES(?,?,?,?,?)').run(id,'active',null,observed,'ingested');
      const mime=input.mimeType??(input.text!==undefined?'text/plain':'application/octet-stream');
      this.addArtifact({ sourceId:id,kind:'raw',bytes,mimeType:mime,text:input.text,fidelity:'exact' });
      const initialSpan=this.db.prepare('SELECT span_id FROM spans WHERE source_id=? ORDER BY span_id LIMIT 1').get(id)!.span_id;
      this.db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(stableId('cf-source-event-v1',id),ns,id,null,null,'active',initialSpan,Date.now(),'ingest','created');
      this.bumpGeneration(ns);
      this.queueCompile(id);
      return this.getSource(id)!;
    });
  }
  queueCompile(sourceId: string): void {
    const source=this.getSource(sourceId)!;
    const artifacts=this.db.prepare('SELECT artifact_id FROM artifacts WHERE source_id=? ORDER BY artifact_id').all(sourceId).map(x=>x.artifact_id);
    const input=stableId('cf-compile-input-v1',source.contentSha256,artifacts);
    this.db.prepare('INSERT OR IGNORE INTO compile_jobs(job_id,source_id,compiler_version,input_sha256,state,available_at) VALUES(?,?,?,?,?,?)').run(stableId('cf-job-v1',sourceId,COMPILER_VERSION,input),sourceId,COMPILER_VERSION,input,'queued',Date.now());
  }
  addArtifact(input: { sourceId:string; kind:ArtifactKind; bytes?:Uint8Array; text?:string; mimeType?:string; producer?:string; producerVersion?:string; config?:JsonValue; fidelity?:ArtifactRecord['fidelity']; parentSpanId?:string; metadata?:JsonValue; asset?:Record<string,number|string> }): ArtifactRecord {
    return this.transaction(() => {
      const source=this.getSource(input.sourceId); if(!source) throw new Error('Unknown source'); this.assertNamespace(source.namespaceId,'write');
      const blob=this.writeBlob(input.bytes??Buffer.from(input.text??''));
      const producer=input.producer??'contextforge', version=input.producerVersion??'1', config=sha256(canonicalJson(input.config??{}));
      const id=stableId('cf-artifact-v1',source.sourceId,input.kind,producer,version,config,blob.sha256);
      const mime=input.mimeType??'text/plain'; if(!/^[\w.+-]+\/[\w.+-]+(?:;[^\r\n]*)?$/.test(mime)) throw new Error('Invalid MIME');
      const fidelity=input.fidelity??(input.parentSpanId?'machine_inferred':'exact');
      this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,source.sourceId,input.kind,blob.sha256,mime,input.text??null,producer,version,config,fidelity,source.observedAt,canonicalJson(input.metadata??{}));
      if(input.parentSpanId) {
        const parent=this.db.prepare('SELECT artifact_id,source_id FROM spans WHERE span_id=?').get(input.parentSpanId);
        if(!parent || parent.source_id!==source.sourceId || parent.artifact_id===id) throw new Error('Invalid artifact lineage');
        this.db.prepare('INSERT OR IGNORE INTO artifact_lineage VALUES(?,?,?)').run(id,input.parentSpanId,canonicalJson({producer,version,config}));
      }
      if(input.asset) {
        const a=input.asset;
        this.db.prepare('INSERT OR IGNORE INTO asset_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,a.widthPx??null,a.heightPx??null,a.durationMs??null,a.sampleRateHz??null,a.channels??null,a.pageCount??null,a.frameRateNum??null,a.frameRateDen??null,a.codec??null,a.language??null,canonicalJson(a));
      }
      this.createSpan(source.sourceId,id,0,blob.byteLength);
      if(input.text!==undefined) {
        if(!Buffer.from(input.text).equals(this.readBlobUnchecked(blob.sha256))) throw new Error('Text artifact bytes differ from indexed text');
        let offset=0, ordinal=0;
        for(const line of input.text.split(/(?<=\n)/u)) {
          const end=offset+Buffer.byteLength(line); const span=this.createSpan(source.sourceId,id,offset,end);
          if(line.trim()) {
            const chunk=stableId('cf-chunk-v1',span,COMPILER_VERSION);
            this.db.prepare('INSERT OR IGNORE INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?)').run(chunk,source.namespaceId,span,null,ordinal++,'paragraph','',line,'{}',COMPILER_VERSION);
            this.db.prepare('INSERT OR IGNORE INTO retrieval_documents(namespace_id,chunk_id,title,body) VALUES(?,?,?,?)').run(source.namespaceId,chunk,'',line);
          } offset=end;
        }
      }
      this.queueCompile(source.sourceId);
      return {artifactId:id,sourceId:source.sourceId,kind:input.kind,blobSha256:blob.sha256,mimeType:mime,textContent:input.text??null,producer,producerVersion:version,configSha256:config,fidelity,observedAt:source.observedAt,metadata:input.metadata??{}};
    });
  }
  createSpan(sourceId:string, artifactId:string, start:number, end:number): string {
    const source=this.getSource(sourceId); if(!source) throw new Error('Unknown source'); this.assertNamespace(source.namespaceId,'write');
    const artifact=this.db.prepare('SELECT * FROM artifacts WHERE artifact_id=? AND source_id=?').get(artifactId,sourceId);
    if(!artifact) throw new Error('Span source mismatch');
    const bytes=this.readBlobUnchecked(artifact.blob_sha256 as string);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>bytes.length) throw new Error('Span bounds invalid');
    if(artifact.text_content!==null && ((start<bytes.length&&(bytes[start]&0xc0)===0x80)||(end<bytes.length&&(bytes[end]&0xc0)===0x80))) throw new Error('Span splits UTF-8 codepoint');
    const id=stableId('cf-span-v1',artifactId,start,end);
    this.db.prepare('INSERT OR IGNORE INTO spans(span_id,source_id,artifact_id,byte_start,byte_end,selector_json,quote_sha256,observed_at) VALUES(?,?,?,?,?,?,?,?)').run(id,sourceId,artifactId,start,end,'{}',sha256(bytes.subarray(start,end)),source.observedAt); return id;
  }
  commitTurn(input:{sessionId:string; advancementKey:string; messages:AcceptedMessage[]}): 'committed'|'duplicate' {
    const payload=canonicalJson(input.messages), hash=sha256(payload);
    return this.transaction(() => {
      this.ensureSession(input.sessionId);
      const previous=this.db.prepare('SELECT payload_sha256 FROM turn_commits WHERE session_id=? AND advancement_key=?').get(input.sessionId,input.advancementKey);
      if(previous) { if(previous.payload_sha256!==hash) throw new Error('Turn idempotency collision'); return 'duplicate'; }
      let sequence=Number(this.db.prepare('SELECT coalesce(max(sequence)+1,0) AS next FROM message_occurrences WHERE session_id=?').get(input.sessionId)!.next);
      input.messages.forEach((message,index) => {
        const hostId=message.id??`${input.advancementKey}:${index}`;
        const rawRole = String(message.role ?? 'user');
        const normalizedRole = (rawRole === 'toolResult' || rawRole === 'tool' ? 'tool' : ['user','assistant','system','developer'].includes(rawRole) ? rawRole : 'user') as AcceptedMessage['role'];
        const source=this.ingestSource({sessionId:input.sessionId,originSystem:'host',originKey:`${input.sessionId}/${hostId}`,role:normalizedRole,kind:normalizedRole==='tool'?'tool_result':'turn',bytes:Buffer.from(canonicalJson(message)),mimeType:'application/json',observedAt:message.observedAt});
        this.addArtifact({sourceId:source.sourceId,kind:'normalized_message',text:canonicalJson(message),mimeType:'application/json',fidelity:'deterministic_transform'});
        const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)&&x.type==='text'&&typeof x.text==='string').map(x=>(x as {text:string}).text).join('\n'):'';
        if(text) this.addArtifact({sourceId:source.sourceId,kind:'text',text,fidelity:'deterministic_transform'});
        this.db.prepare('INSERT INTO message_occurrences VALUES(?,?,?,?,?,?,?)').run(input.sessionId,sequence++,source.sourceId,hostId,input.advancementKey,message.toolCallId??null,message.protocolGroupId??input.advancementKey);
      });
      this.db.prepare('INSERT INTO turn_commits VALUES(?,?,?,?)').run(input.sessionId,input.advancementKey,hash,Date.now()); this.bumpGeneration(this.namespaceId); return 'committed';
    });
  }
  bumpGeneration(ns:string): number { this.db.prepare('UPDATE namespaces SET generation=generation+1 WHERE namespace_id=?').run(ns); return Number(this.db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(ns)!.generation); }
  publishNode(input:PublishNodeInput): DerivedNodeRecord {
    return this.transaction(() => {
      this.assertNamespace(input.namespaceId,'write');
      const spans=[...new Set(input.spanIds)].sort(); if(!spans.length) throw new Error('Provenance required');
      for(const spanId of spans) {
        const span=this.db.prepare('SELECT p.*,s.namespace_id,l.status FROM spans p JOIN sources s USING(source_id) JOIN source_lifecycle l USING(source_id) WHERE span_id=?').get(spanId);
        if(!span||span.namespace_id!==input.namespaceId||span.status!=='active') throw new Error('Invalid or revoked provenance');
        const a=this.db.prepare('SELECT blob_sha256 FROM artifacts WHERE artifact_id=?').get(span.artifact_id as string)!;
        if(span.byte_start!==null && sha256(this.readBlobUnchecked(a.blob_sha256 as string).subarray(Number(span.byte_start),Number(span.byte_end)))!==span.quote_sha256) throw new Error('Provenance quote mismatch');
      }
      const dependencies=[...new Set(input.dependencyNodeIds??[])].sort();
      for(const id of dependencies) {
        const dep=this.db.prepare('SELECT namespace_id,status FROM derived_nodes WHERE node_id=?').get(id);
        if(!dep||dep.namespace_id!==input.namespaceId||dep.status!=='active') throw new Error('Invalid dependency');
      }
      const semantic=canonicalJson({body:input.body,title:input.title,canonical:input.canonical,spans,dependencies,kind:input.kind,layer:input.layer,validFrom:input.validFrom??null,validTo:input.validTo??null});
      const hash=sha256(semantic);
      const old=this.db.prepare('SELECT * FROM derived_nodes WHERE namespace_id=? AND logical_key=? AND status=\'active\'').get(input.namespaceId,input.logicalKey);
      if(old&&old.content_sha256===hash&&old.compiler_version===input.compilerVersion) return nodeRecord(old);
      if(old&&input.replace===false) throw new Error('Explicit replacement required');
      const revision=Number(this.db.prepare('SELECT coalesce(max(revision),0)+1 AS next FROM derived_nodes WHERE namespace_id=? AND logical_key=?').get(input.namespaceId,input.logicalKey)!.next);
      const id=stableId('cf-node-v1',input.namespaceId,input.logicalKey,hash,input.compilerVersion,revision);
      if(old) this.db.prepare("UPDATE derived_nodes SET status='superseded' WHERE node_id=?").run(old.node_id);
      this.db.prepare('INSERT INTO derived_nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.namespaceId,input.layer,input.logicalKey,revision,input.kind,input.title,input.body,canonicalJson(input.canonical),input.compilerVersion,hash,Date.now(),input.observedAt,'active',input.validFrom??null,input.validTo??null,null);
      for(const span of spans) this.db.prepare('INSERT INTO provenance VALUES(?,?,?,?,?)').run(id,span,input.layer===3?'instructs':'supports',input.extractionRule,input.observedAt);
      for(const parent of dependencies) this.db.prepare('INSERT INTO derivation_edges VALUES(?,?,?)').run(parent,id,'compiles');
      this.db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(stableId('cf-event-v1',id,'active'),input.namespaceId,null,id,null,'active',spans[0],Date.now(),'compiler','created');
      if(old) {
        this.db.prepare('UPDATE derived_nodes SET superseded_by=? WHERE node_id=?').run(id,old.node_id);
        this.db.prepare('INSERT INTO derivation_edges VALUES(?,?,?)').run(old.node_id,id,'supersedes');
        this.db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(stableId('cf-event-v1',old.node_id,id),input.namespaceId,null,old.node_id,'active','superseded',spans[0],Date.now(),'compiler','explicit revision');
        if(input.layer===3) this.retireEpochs(input.namespaceId,'derived revision');
      }
      this.db.prepare('INSERT INTO retrieval_documents(namespace_id,node_id,title,body) VALUES(?,?,?,?)').run(input.namespaceId,id,input.title,input.body);
      return nodeRecord(this.db.prepare('SELECT * FROM derived_nodes WHERE node_id=?').get(id)!);
    });
  }
  getProvenance(nodeId:string): ProvenanceRecord[] {
    const node=this.db.prepare('SELECT namespace_id FROM derived_nodes WHERE node_id=?').get(nodeId); if(!node)return []; this.assertNamespace(node.namespace_id as string);
    return this.db.prepare('SELECT p.*,s.source_id,s.artifact_id,s.byte_start,s.byte_end FROM provenance p JOIN spans s USING(span_id) WHERE p.node_id=? ORDER BY span_id').all(nodeId).map(r=>({nodeId:r.node_id as string,sourceId:r.source_id as string,spanId:r.span_id as string,artifactId:r.artifact_id as string,relation:r.relation as ProvenanceRecord['relation'],extractionRule:r.extraction_rule as string,observedAt:r.observed_at as number,byteStart:r.byte_start as number|null,byteEnd:r.byte_end as number|null}));
  }
  setPermanentContext(key:string, body:string, options:{title?:string;namespaceId?:string;priority?:number;ownerApproved?:boolean}={}): DerivedNodeRecord {
    if(options.ownerApproved!==true) throw new Error('Explicit owner approval required for L3');
    const ns=options.namespaceId??this.namespaceId; this.assertNamespace(ns,'write');
    if(this.db.prepare('SELECT owner_id FROM namespaces WHERE namespace_id=?').get(ns)!.owner_id!==this.ownerId) throw new Error('Only namespace owner may approve L3');
    return this.transaction(() => {
      const old=this.getPermanentContext(key,ns); if(old?.body===body && (old.canonical as any).priority===(options.priority??0))return old;
      const revision=Number(this.db.prepare('SELECT coalesce(max(revision),0)+1 AS next FROM derived_nodes WHERE namespace_id=? AND logical_key=?').get(ns,'permanent/'+key)!.next);
      const source=this.ingestSource({namespaceId:ns,kind:'policy',originSystem:'owner-approved',originKey:key,originRevision:String(revision),role:'user',trustClass:'owner_instruction',text:body});
      const spans=this.db.prepare('SELECT span_id FROM spans WHERE source_id=? ORDER BY span_id').all(source.sourceId).map(r=>r.span_id as string);
      const node=this.publishNode({namespaceId:ns,layer:3,logicalKey:'permanent/'+key,kind:'policy',title:options.title??key,body,canonical:{priority:options.priority??0,ownerApproved:true},compilerVersion:COMPILER_VERSION,observedAt:source.observedAt,spanIds:spans,extractionRule:'owner-approved-policy-v1'});
      this.bumpGeneration(ns); this.retireEpochs(ns,'permanent context changed'); return node;
    });
  }
  getPermanentContext(key:string, namespaceId=this.namespaceId): DerivedNodeRecord|undefined { this.assertNamespace(namespaceId); const row=this.db.prepare("SELECT * FROM derived_nodes WHERE namespace_id=? AND layer=3 AND logical_key=? AND status='active'").get(namespaceId,'permanent/'+key); return row?nodeRecord(row):undefined; }
  listPermanentContext(namespaceId=this.namespaceId): DerivedNodeRecord[] { this.assertNamespace(namespaceId); return this.db.prepare("SELECT * FROM derived_nodes WHERE namespace_id=? AND layer=3 AND status='active' ORDER BY json_extract(canonical_json,'$.priority') DESC,logical_key").all(namespaceId).map(nodeRecord); }
  deletePermanentContext(key:string, namespaceId=this.namespaceId): boolean {
    return this.transaction(() => { const old=this.getPermanentContext(key,namespaceId); if(!old)return false;
      this.assertNamespace(namespaceId,'write'); if(this.db.prepare('SELECT owner_id FROM namespaces WHERE namespace_id=?').get(namespaceId)!.owner_id!==this.ownerId)throw new Error('Only namespace owner may revoke L3'); const source=this.ingestSource({namespaceId,kind:'policy',originSystem:'owner-approved',originKey:`withdraw/${key}/${old.nodeId}`,role:'user',trustClass:'owner_instruction',text:`Withdraw permanent context ${key}`});
      const span=this.db.prepare('SELECT span_id FROM spans WHERE source_id=? LIMIT 1').get(source.sourceId)!.span_id as string;
      this.withdrawNode(old.nodeId,span,'permanent context deleted'); this.bumpGeneration(namespaceId); return true;
    });
  }
  private retireEpochs(ns:string, reason:string): void { this.db.prepare("UPDATE epochs SET state='retired',retired_at=?,reason=? WHERE state='active' AND session_id IN (SELECT session_id FROM sessions WHERE namespace_id=?)").run(Date.now(),reason,ns); }
  withdrawNode(nodeId:string,causeSpanId:string,reason='withdrawn'): void {
    this.transaction(() => {
      const node=this.db.prepare('SELECT * FROM derived_nodes WHERE node_id=?').get(nodeId); if(!node)throw new Error('Unknown node'); this.assertNamespace(node.namespace_id as string,'write');
      const cause=this.db.prepare('SELECT s.namespace_id FROM spans p JOIN sources s USING(source_id) WHERE span_id=?').get(causeSpanId);
      if(!cause||cause.namespace_id!==node.namespace_id)throw new Error('Invalid lifecycle cause');
      const rows=this.db.prepare(`WITH RECURSIVE dependents(id) AS (SELECT ? UNION SELECT e.child_node_id FROM derivation_edges e JOIN dependents d ON e.parent_node_id=d.id WHERE e.relation IN ('compiles','depends_on')) SELECT n.* FROM dependents d JOIN derived_nodes n ON n.node_id=d.id WHERE n.status='active'`).all(nodeId);
      for(const row of rows) {
        this.db.prepare("UPDATE derived_nodes SET status='withdrawn' WHERE node_id=?").run(row.node_id);
        this.db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.namespace_id,null,row.node_id,'active','withdrawn',causeSpanId,Date.now(),'owner',reason);
      } this.retireEpochs(node.namespace_id as string,reason);
    });
  }
  withdrawSource(sourceId:string, causeSpanId?:string): void {
    this.transaction(() => {
      const source=this.getSource(sourceId); if(!source)throw new Error('Unknown source'); this.assertNamespace(source.namespaceId,'write');
      const span=causeSpanId??this.db.prepare('SELECT span_id FROM spans WHERE source_id=? LIMIT 1').get(sourceId)?.span_id as string;
      if(!span)throw new Error('Withdrawal requires cause');
      for(const row of this.db.prepare('SELECT DISTINCT node_id FROM provenance p JOIN spans s USING(span_id) WHERE s.source_id=?').all(sourceId))this.withdrawNode(row.node_id as string,span,'source withdrawn');
      this.db.prepare("UPDATE source_lifecycle SET status='withdrawn',changed_at=?,reason='withdrawn' WHERE source_id=?").run(Date.now(),sourceId);
      this.db.prepare('INSERT INTO lifecycle_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),source.namespaceId,sourceId,null,source.status,'withdrawn',span,Date.now(),'owner','source withdrawn');
      this.retireEpochs(source.namespaceId,'source withdrawn');this.bumpGeneration(source.namespaceId);
    });
  }
  search(query:string, options:SearchOptions={}): SearchResult[] {
    const ns=options.namespaceId??this.namespaceId; this.assertNamespace(ns);
    const words=query.match(/[\p{L}\p{N}_]+/gu); if(!words?.length)return [];
    const match=words.map(w=>'"'+w.replaceAll('"','""')+'"').join(' OR ');
    const limit=options.limit??100, offset=options.offset??0;
    if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid search pagination');
    const rows=this.db.prepare(`SELECT d.*,bm25(retrieval_fts) AS score FROM retrieval_fts JOIN retrieval_documents d ON d.rowid=retrieval_fts.rowid
      LEFT JOIN chunks c ON c.chunk_id=d.chunk_id LEFT JOIN spans sp ON sp.span_id=c.span_id
      LEFT JOIN sources s ON s.source_id=coalesce(d.source_id,sp.source_id) LEFT JOIN source_lifecycle sl ON sl.source_id=s.source_id
      LEFT JOIN derived_nodes n ON n.node_id=d.node_id
      WHERE retrieval_fts MATCH ? AND d.namespace_id=?
      AND (? OR (coalesce(sl.status,n.status)='active' AND NOT EXISTS(SELECT 1 FROM provenance p JOIN spans ps USING(span_id) JOIN source_lifecycle pl ON pl.source_id=ps.source_id WHERE p.node_id=n.node_id AND pl.status<>'active')))
      AND (? IS NULL OR coalesce(s.observed_at,n.observed_at)>=?) AND (? IS NULL OR coalesce(s.observed_at,n.observed_at)<?)
      ORDER BY score,d.rowid LIMIT ? OFFSET ?`).all(match,ns,options.includeHistory?1:0,options.observedFrom??null,options.observedFrom??null,options.observedTo??null,options.observedTo??null,limit,offset);
    return rows.map(r=>({namespaceId:r.namespace_id as string,sourceId:r.source_id as string|null,nodeId:r.node_id as string|null,chunkId:r.chunk_id as string|null,title:r.title as string,body:r.body as string,score:r.score as number}));
  }
  searchEntity(entityKey:string, options:SearchOptions={}): DerivedNodeRecord[] {
    const ns=options.namespaceId??this.namespaceId; this.assertNamespace(ns);
    return this.db.prepare(`SELECT n.* FROM entities e JOIN facts f USING(entity_id) JOIN derived_nodes n USING(node_id) WHERE e.namespace_id=? AND e.entity_key=? AND (? OR n.status='active') ORDER BY n.observed_at,n.node_id`).all(ns,entityKey,options.includeHistory?1:0).map(nodeRecord);
  }
  searchTemporal(options:SearchOptions & {validAt?:number}={}): DerivedNodeRecord[] {
    const ns=options.namespaceId??this.namespaceId; this.assertNamespace(ns);
    return this.db.prepare(`SELECT n.* FROM derived_nodes n WHERE namespace_id=?
      AND (? IS NULL OR observed_at>=?) AND (? IS NULL OR observed_at<?)
      AND (? IS NULL OR ((valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>?)))
      AND (? IS NULL OR created_at<=?)
      AND (? OR CASE WHEN ? IS NULL THEN status ELSE (SELECT to_status FROM lifecycle_events e WHERE e.node_id=n.node_id AND e.occurred_at<=? ORDER BY occurred_at DESC,rowid DESC LIMIT 1) END='active')
      ORDER BY observed_at,node_id`).all(ns,options.observedFrom??null,options.observedFrom??null,options.observedTo??null,options.observedTo??null,options.validAt??null,options.validAt??null,options.validAt??null,options.asKnownAt??null,options.asKnownAt??null,options.includeHistory?1:0,options.asKnownAt??null,options.asKnownAt??null).map(nodeRecord);
  }
  occurrenceCount(sessionId: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM message_occurrences WHERE session_id=?').get(sessionId)!.n);
  }
  getStats(): Record<string,number|string> {
    this.assertNamespace(this.namespaceId); const ns=this.namespaceId;
    const result:Record<string,number|string>={journalMode:String(this.db.prepare('PRAGMA journal_mode').get()!.journal_mode),schemaVersion:Number(this.db.prepare('PRAGMA user_version').get()!.user_version)};
    for(const table of ['sources','derived_nodes','chunks','sessions','entities'])result[table]=Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE namespace_id=?`).get(ns)!.n);
    result.facts=Number(this.db.prepare('SELECT count(*) AS n FROM facts f JOIN derived_nodes n USING(node_id) WHERE namespace_id=?').get(ns)!.n);
    result.artifacts=Number(this.db.prepare('SELECT count(*) AS n FROM artifacts a JOIN sources s USING(source_id) WHERE namespace_id=?').get(ns)!.n);
    result.generation=Number(this.db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(ns)!.generation);return result;
  }
}
