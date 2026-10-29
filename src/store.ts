import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, readSync, fstatSync, writeFileSync, fsyncSync, renameSync, readFileSync, unlinkSync, existsSync, constants } from 'node:fs';
import { resolve, dirname, join, parse } from 'node:path';
import { analyzeRecallQuery, tokenizeRecallText, buildFtsQuery, lexicalProjectionTitle, canonicalRecallTitle, LEXICAL_VERSION } from './retrieval.ts';
import { getLanguageGrammar } from './code-decomposer.ts';
import { structuralUnits, isDocumentationDocument } from './structure.ts';
import { configureDatabase, migrate } from './schema.ts';
import type { AcceptedMessage, ArtifactKind, ArtifactRecord, BlobRecord, ContextForgeConfig, DerivedNodeRecord, IngestSourceInput, JsonValue, MemoryStatus, ProvenanceRecord, PublishNodeInput, SearchOptions, SearchResult, SourceRecord } from './types.ts';

export const COMPILER_VERSION = 'deterministic-v1';
export const INLINE_THRESHOLD = 64 * 1024;
/** Maximum indexed quote size; boundaries never split UTF-8 codepoints. */
export const EVIDENCE_CHUNK_BYTES = 2048;
/** Shared, mutable discovery allowance. Reuse across lanes/facets and hydration. */
export interface StoreReadBudget { maxInspected:number; maxBytes:number; deadlineAt:number; inspected:number; bytes:number }
export function createStoreReadBudget(options:{maxInspected?:number;maxBytes?:number;deadlineAt?:number}={}):StoreReadBudget {
  const b={maxInspected:options.maxInspected??4096,maxBytes:options.maxBytes??8*1024*1024,deadlineAt:options.deadlineAt??Infinity,inspected:0,bytes:0};
  if(!Number.isSafeInteger(b.maxInspected)||b.maxInspected<0||!Number.isSafeInteger(b.maxBytes)||b.maxBytes<0||Number.isNaN(b.deadlineAt))throw new Error('Invalid read budget');
  return b;
}
export interface BoundedReadOptions { maxInspected?:number; maxBytes?:number; deadlineAt?:number; budget?:StoreReadBudget }
export interface BoundedSearchOptions extends SearchOptions,BoundedReadOptions { afterRowid?:number; maxStatisticsInspected?:number; maxRowBytes?:number }
function available(b:StoreReadBudget):boolean {return b.inspected<b.maxInspected&&b.bytes<b.maxBytes&&Date.now()<b.deadlineAt;}
function readBudget(options:BoundedReadOptions):StoreReadBudget {return options.budget??createStoreReadBudget({deadlineAt:options.deadlineAt});}
function readMetadata<T,M extends {inspected:number;bytes:number;truncated:boolean}>(rows:T[],metadata:M):T[]&M {
  return Object.defineProperties(rows,Object.fromEntries(Object.entries(metadata).map(([k,value])=>[k,{value,enumerable:false}]))) as T[]&M;
}
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
  private readonly recallStatistics = new Map<string,{generation:number;sourceCount:number;df:Map<string,number>;truncated?:boolean}>();
  constructor(config: ContextForgeConfig | string) {
    if (typeof config === 'string') config = { dbPath: config };
    if (config.dbPath === ':memory:') throw new Error('Use a file-backed database: WAL durability is required');
    const path = resolve(config.dbPath); secureDirectory(dirname(path)); safeFile(path);
    this.blobRoot = secureDirectory(config.blobRoot ?? join(dirname(path), 'contextforge', 'blobs', 'sha256'));
    this.ownerId = config.ownerId ?? 'local-owner';
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      chmodSync(path, 0o600); configureDatabase(this.db); migrate(this.db);
      // Incoming one-hop traversal must not scan the complete edge table.
      this.db.exec('CREATE INDEX IF NOT EXISTS cf_edges_child ON derivation_edges(child_node_id,parent_node_id,relation)');
      this.db.exec('CREATE INDEX IF NOT EXISTS cf_spans_artifact_range ON spans(artifact_id,byte_start,span_id)');
      this.db.exec('CREATE INDEX IF NOT EXISTS cf_chunks_span ON chunks(span_id,chunk_id)');
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
      const inserted=this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,source.sourceId,input.kind,blob.sha256,mime,input.text??null,producer,version,config,fidelity,source.observedAt,canonicalJson(input.metadata??{}));
      let changed=Number(inserted.changes)>0;
      if(input.parentSpanId) {
        const parent=this.db.prepare('SELECT artifact_id,source_id FROM spans WHERE span_id=?').get(input.parentSpanId);
        if(!parent || parent.source_id!==source.sourceId || parent.artifact_id===id) throw new Error('Invalid artifact lineage');
        const lineage=this.db.prepare('INSERT OR IGNORE INTO artifact_lineage VALUES(?,?,?)').run(id,input.parentSpanId,canonicalJson({producer,version,config}));
        changed=changed||Number(lineage.changes)>0;
      }
      if(input.asset) {
        const a=input.asset;
        const asset=this.db.prepare('INSERT OR IGNORE INTO asset_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,a.widthPx??null,a.heightPx??null,a.durationMs??null,a.sampleRateHz??null,a.channels??null,a.pageCount??null,a.frameRateNum??null,a.frameRateDen??null,a.codec??null,a.language??null,canonicalJson(a));
        changed=changed||Number(asset.changes)>0;
      }
      const bytes=Buffer.from(input.bytes??Buffer.from(input.text??''));
      this.insertSpan(source.sourceId,id,0,bytes.length,bytes,source.observedAt,input.text!==undefined);
      if(input.text!==undefined) {
        if(!Buffer.from(input.text).equals(bytes)) throw new Error('Text artifact bytes differ from indexed text');
        let offset=0, ordinal=0;
        // Include whitespace lines: ordinal adjacency alone is not byte adjacency.
        for(const line of input.text.split(/(?<=\n)/u)) {
          const lineEnd=offset+Buffer.byteLength(line);
          while(offset<lineEnd) {
            let end=Math.min(lineEnd,offset+EVIDENCE_CHUNK_BYTES);
            while(end<lineEnd&&(bytes[end]&0xc0)===0x80)end--;
            const text=bytes.subarray(offset,end).toString('utf8');
            const span=this.insertSpan(source.sourceId,id,offset,end,bytes,source.observedAt,true);
            const chunk=stableId('cf-chunk-v1',span,COMPILER_VERSION);
            this.db.prepare('INSERT OR IGNORE INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?)').run(chunk,source.namespaceId,span,null,ordinal++,'paragraph','',text,canonicalJson({byteStart:offset,byteEnd:end,lineContinues:end<lineEnd}),COMPILER_VERSION);
            const projection=this.db.prepare('INSERT OR IGNORE INTO retrieval_documents(namespace_id,chunk_id,title,body) VALUES(?,?,?,?)').run(source.namespaceId,chunk,lexicalProjectionTitle('',text),text);
            changed=changed||Number(projection.changes)>0;
            offset=end;
          }
        }
      }
      if(changed)this.bumpGeneration(source.namespaceId);
      this.queueCompile(source.sourceId);
      return {artifactId:id,sourceId:source.sourceId,kind:input.kind,blobSha256:blob.sha256,mimeType:mime,textContent:input.text??null,producer,producerVersion:version,configSha256:config,fidelity,observedAt:source.observedAt,metadata:input.metadata??{}};
    });
  }
  /** Structural coordinates are a regenerable view; immutable L0 is never rewritten. */
  getStructuralUnits(sourceId:string, artifactId?:string, maxBlockBytes?:number) {
    const source=this.getSource(sourceId);if(!source||source.status!=='active')return [];
    const artifact=artifactId?this.db.prepare('SELECT * FROM artifacts WHERE source_id=? AND artifact_id=?').get(sourceId,artifactId):this.db.prepare("SELECT * FROM artifacts WHERE source_id=? AND text_content IS NOT NULL AND kind<>'normalized_message' ORDER BY CASE kind WHEN 'raw' THEN 0 WHEN 'text' THEN 1 ELSE 2 END,artifact_id LIMIT 1").get(sourceId);
    if(!artifact||artifact.text_content===null)return [];
    if(!getLanguageGrammar(source.originKey)&&!isDocumentationDocument(source.originKey)&&!/^\[start of [^\]]+\]/m.test(String(artifact.text_content)))return [];
    const bytes=this.readBlob(String(artifact.blob_sha256));
    return structuralUnits(bytes.toString('utf8'),source.originKey,maxBlockBytes).map(unit=>({...unit,sourceId,artifactId:String(artifact.artifact_id)}));
  }
  createSpan(sourceId:string, artifactId:string, start:number, end:number): string {
    const source=this.getSource(sourceId); if(!source) throw new Error('Unknown source'); this.assertNamespace(source.namespaceId,'write');
    const artifact=this.db.prepare('SELECT * FROM artifacts WHERE artifact_id=? AND source_id=?').get(artifactId,sourceId);
    if(!artifact) throw new Error('Span source mismatch');
    const bytes=this.readBlobUnchecked(artifact.blob_sha256 as string);
    return this.insertSpan(sourceId,artifactId,start,end,bytes,source.observedAt,artifact.text_content!==null);
  }
  /** Create/reuse a quote using bounded range IO, never a hidden whole-artifact read. */
  createEvidenceSpan(sourceId:string,artifactId:string,start:number,end:number,options:BoundedReadOptions&{namespaceId?:string}={}) {
    const ns=options.namespaceId??this.namespaceId;this.assertNamespace(ns,'write');
    const budget=options.budget??createStoreReadBudget({maxBytes:options.maxBytes??8*1024*1024,deadlineAt:options.deadlineAt});
    if(!available(budget)||options.maxInspected===0||Date.now()>=(options.deadlineAt??Infinity)||end-start>(options.maxBytes??Infinity))throw new Error('EvidenceReadBudgetExceeded');
    const row=this.db.prepare(`SELECT a.blob_sha256,a.text_content IS NOT NULL AS is_text,s.observed_at,b.byte_length FROM artifacts a JOIN sources s USING(source_id) JOIN source_lifecycle l USING(source_id) JOIN blobs b ON b.sha256=a.blob_sha256 WHERE a.artifact_id=? AND s.source_id=? AND s.namespace_id=? AND l.status='active'`).get(artifactId,sourceId,ns);
    if(!row||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>Number(row.byte_length))throw new Error('Span bounds invalid');
    const id=stableId('cf-span-v1',artifactId,start,end);
    if(!this.db.prepare('SELECT 1 FROM spans WHERE span_id=?').get(id)){
      const length=end-start;if(length>budget.maxBytes-budget.bytes)throw new Error('EvidenceReadBudgetExceeded');
      const bytes=this.readBlobRange(String(row.blob_sha256),start,end);budget.bytes+=bytes.length;budget.inspected++;
      if(row.is_text&&!Buffer.from(bytes.toString('utf8')).equals(bytes))throw new Error('Span splits UTF-8 codepoint');
      this.db.prepare('INSERT OR IGNORE INTO spans(span_id,source_id,artifact_id,byte_start,byte_end,selector_json,quote_sha256,observed_at) VALUES(?,?,?,?,?,?,?,?)').run(id,sourceId,artifactId,start,end,'{}',sha256(bytes),row.observed_at);
      return {spanId:id,sourceId,artifactId,byteStart:start,byteEnd:end,text:bytes.toString('utf8')};
    }
    return this.readEvidenceSpan(id,{...options,namespaceId:ns,budget});
  }
  private insertSpan(sourceId:string,artifactId:string,start:number,end:number,bytes:Buffer,observedAt:number,isText:boolean):string {
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>bytes.length) throw new Error('Span bounds invalid');
    if(isText && ((start<bytes.length&&(bytes[start]&0xc0)===0x80)||(end<bytes.length&&(bytes[end]&0xc0)===0x80))) throw new Error('Span splits UTF-8 codepoint');
    const id=stableId('cf-span-v1',artifactId,start,end);
    this.db.prepare('INSERT OR IGNORE INTO spans(span_id,source_id,artifact_id,byte_start,byte_end,selector_json,quote_sha256,observed_at) VALUES(?,?,?,?,?,?,?,?)').run(id,sourceId,artifactId,start,end,'{}',sha256(bytes.subarray(start,end)),observedAt); return id;
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
  bumpGeneration(ns:string): number { this.recallStatistics.delete(ns); this.db.prepare('UPDATE namespaces SET generation=generation+1 WHERE namespace_id=?').run(ns); return Number(this.db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(ns)!.generation); }
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
      this.db.prepare('INSERT INTO retrieval_documents(namespace_id,node_id,title,body) VALUES(?,?,?,?)').run(input.namespaceId,id,lexicalProjectionTitle(input.title,input.body),input.body);
      this.bumpGeneration(input.namespaceId);
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
      } if(rows.length)this.bumpGeneration(String(node.namespace_id));
      this.retireEpochs(node.namespace_id as string,reason);
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
  search(query:string, options:BoundedSearchOptions={}) {
    const ns=options.namespaceId??this.namespaceId; this.assertNamespace(ns);
    const recall=analyzeRecallQuery(query),match=buildFtsQuery(recall);
    const limit=options.limit??100, offset=options.offset??0,maxInspected=options.maxInspected??Math.max(256,limit+offset),maxBytes=options.maxBytes??2*1024*1024,maxRowBytes=options.maxRowBytes??16384,after=options.afterRowid??0;
    for(const n of [limit,offset,maxInspected,maxBytes,maxRowBytes,after,options.maxStatisticsInspected??1024])if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid search bounds');
    if(limit<1||maxRowBytes<1)throw new Error('Invalid search bounds');
    const budget=readBudget(options),startWork=budget.inspected,startBytes=budget.bytes,deadline=Math.min(options.deadlineAt??Infinity,budget.deadlineAt);
    let inspected=0,bytes=0,nextRowid=after,truncated=false,statisticsInspected=0;
    const rows:Row[]=[];
    const done=()=>readMetadata(rows.map(r=>({namespaceId:r.namespace_id as string,sourceId:r.resolved_source_id as string|null,nodeId:r.node_id as string|null,chunkId:r.chunk_id as string|null,title:canonicalRecallTitle(String(r.canonical_title)),body:r.body as string,score:r.score as number,spanId:r.span_id as string,artifactId:r.artifact_id as string,byteStart:r.byte_start as number,byteEnd:r.byte_end as number,layer:r.layer as number,status:r.lifecycle_status as MemoryStatus,logicalKey:r.logical_key as string})),{inspected,bytes,truncated,nextRowid,statisticsInspected,workInspected:budget.inspected-startWork,workBytes:budget.bytes-startBytes});
    if(!match)return done();
    if(!available(budget)||Date.now()>=deadline||!maxInspected||!maxBytes){truncated=true;return done();}
    const statistics=this.activeSourceStatistics(ns,{...options,budget,deadlineAt:deadline,maxInspected:options.maxStatisticsInspected??1024});
    statisticsInspected=statistics.inspected;truncated=statistics.truncated;
    if(!available(budget)||Date.now()>=deadline){truncated=true;return done();}
    const terms=new Set(recall.facets.flatMap(f=>f.aliases));
    const rowAllowance=Math.min(maxBytes,budget.maxBytes-budget.bytes),titleCap=Math.min(2048,Math.floor(rowAllowance/4)),bodyCap=Math.min(maxRowBytes,rowAllowance-titleCap);
    const statement=this.db.prepare(`SELECT d.rowid AS discovery_rowid,d.namespace_id,d.node_id,d.chunk_id,d.source_id,substr(CAST(d.body AS BLOB),1,?) AS bounded_body,length(CAST(d.body AS BLOB)) AS body_bytes,coalesce(d.source_id,sp.source_id) AS resolved_source_id,sp.span_id,sp.artifact_id,sp.byte_start,sp.byte_end,coalesce(n.layer,0) AS layer,coalesce(n.status,sl.status) AS lifecycle_status,n.logical_key,substr(CAST(coalesce(n.title,c.title,d.title,'') AS BLOB),1,?) AS bounded_title,length(CAST(coalesce(n.title,c.title,d.title,'') AS BLOB)) AS title_bytes,0 AS score FROM retrieval_fts JOIN retrieval_documents d ON d.rowid=retrieval_fts.rowid
      LEFT JOIN chunks c ON c.chunk_id=d.chunk_id LEFT JOIN spans sp ON sp.span_id=c.span_id LEFT JOIN artifacts search_artifact ON search_artifact.artifact_id=sp.artifact_id
      LEFT JOIN sources s ON s.source_id=coalesce(d.source_id,sp.source_id) LEFT JOIN source_lifecycle sl ON sl.source_id=s.source_id
      LEFT JOIN derived_nodes n ON n.node_id=d.node_id
      WHERE retrieval_fts MATCH ? AND d.namespace_id=?
      AND (search_artifact.kind IS NULL OR search_artifact.kind<>'normalized_message')
      AND (? IS NULL OR coalesce(n.layer,0) IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR (n.kind IN (SELECT value FROM json_each(?)) OR c.chunk_kind IN (SELECT value FROM json_each(?)) OR s.kind IN (SELECT value FROM json_each(?))))
      AND (? OR (coalesce(sl.status,n.status)='active' AND NOT EXISTS(SELECT 1 FROM provenance p JOIN spans ps USING(span_id) JOIN source_lifecycle pl ON pl.source_id=ps.source_id WHERE p.node_id=n.node_id AND pl.status<>'active')))
      AND (? IS NULL OR coalesce(s.observed_at,n.observed_at)>=?) AND (? IS NULL OR coalesce(s.observed_at,n.observed_at)<?)
      AND d.rowid>? ORDER BY retrieval_fts.rowid LIMIT ?
      `);
    const rowCap=Math.min(maxInspected,budget.maxInspected-budget.inspected);
    const rowCeiling=bodyCap+titleCap;
    const iterator=statement.iterate(bodyCap,titleCap,match,ns,options.layers?JSON.stringify(options.layers):null,options.layers?JSON.stringify(options.layers):null,options.kinds?JSON.stringify(options.kinds):null,options.kinds?JSON.stringify(options.kinds):null,options.kinds?JSON.stringify(options.kinds):null,options.kinds?JSON.stringify(options.kinds):null,options.includeHistory?1:0,options.observedFrom??null,options.observedFrom??null,options.observedTo??null,options.observedTo??null,after,rowCap);
    let exhausted=false;
    try {while(inspected<rowCap&&maxBytes-bytes>=rowCeiling&&budget.maxBytes-budget.bytes>=rowCeiling&&available(budget)&&Date.now()<deadline){
      const next=iterator.next();if(next.done){exhausted=true;break;}
      const r=next.value;inspected++;budget.inspected++;nextRowid=Math.max(nextRowid,Number(r.discovery_rowid));
      const body=Buffer.from((r.bounded_body??new Uint8Array()) as Uint8Array),title=Buffer.from((r.bounded_title??new Uint8Array()) as Uint8Array),cost=body.length+title.length;
      r.canonical_title=title.toString('utf8');if(Number(r.title_bytes)>title.length)truncated=true;
      // Account fetched bytes even when a row cannot fit the remaining allowance.
      bytes+=cost;budget.bytes+=cost;
      if(bytes>maxBytes||budget.bytes>budget.maxBytes){truncated=true;break;}
      r.body=body.toString('utf8');if(Number(r.body_bytes)>body.length)truncated=true;
      const tokens=new Set(tokenizeRecallText(String(r.canonical_title)+' '+r.body));
      if(![...tokens].some(t=>terms.has(t)))continue;
      let relevance=0;
      for(const facet of recall.facets){let best=0;for(const term of facet.aliases)if(tokens.has(term)){
        const df=statistics.df.get(term)??0;
        const idf=Math.log(1+(statistics.sourceCount-df+0.5)/(df+0.5));
        best=Math.max(best,idf);
      }relevance+=facet.weight*best;}
      r.score=-relevance/(1+0.05*Math.log1p(tokens.size));rows.push(r);
    }} finally {iterator.return?.();}
    if(!exhausted)truncated=true;
    const key=(r:Row)=>String(r.node_id??r.chunk_id??r.resolved_source_id??r.discovery_rowid);
    rows.sort((a,b)=>a.score-b.score||key(a).localeCompare(key(b)));
    if(rows.length>offset+limit)truncated=true;
    rows.splice(0,offset);rows.splice(limit);
    return done();
  }
  private activeSourceStatistics(ns:string,options:BoundedReadOptions={}) {
    const budget=readBudget(options),deadline=Math.min(options.deadlineAt??Infinity,budget.deadlineAt),cap=options.maxInspected??1024,maxBytes=options.maxBytes??2*1024*1024;
    let inspected=0,bytes=0,truncated=false;
    const generation=Number(this.db.prepare('SELECT generation FROM namespaces WHERE namespace_id=?').get(ns)!.generation);
    const cached=this.recallStatistics.get(ns);if(cached?.generation===generation)return {...cached,inspected,truncated:cached.truncated??false};
    const bySource=new Map<string,Set<string>>();
    if(!available(budget)||Date.now()>=deadline||!cap||!maxBytes)return {generation,sourceCount:0,df:new Map<string,number>(),inspected,truncated:true};
    // Never count/scan the whole source table first. Complete scans retain exact
    // distinct-source DF; bounded samples use only their own source population.
    const iterator=this.db.prepare(`SELECT p.source_id,substr(CAST(c.body AS BLOB),1,2048) AS body,length(CAST(c.body AS BLOB)) AS body_bytes FROM chunks c JOIN spans p USING(span_id) JOIN sources s ON s.source_id=p.source_id JOIN source_lifecycle l ON l.source_id=s.source_id WHERE s.namespace_id=? AND l.status='active' LIMIT ?`).iterate(ns,Math.min(cap,budget.maxInspected-budget.inspected));
    let exhausted=false;
    try {while(inspected<cap&&maxBytes-bytes>=2048&&budget.maxBytes-budget.bytes>=2048&&available(budget)&&Date.now()<deadline){
      const next=iterator.next();if(next.done){exhausted=true;break;}const row=next.value;
      inspected++;budget.inspected++;const body=Buffer.from((row.body??new Uint8Array()) as Uint8Array);bytes+=body.length;budget.bytes+=body.length;
      if(bytes>maxBytes||budget.bytes>budget.maxBytes){truncated=true;break;}
      if(Number(row.body_bytes)>body.length)truncated=true;
      const id=String(row.source_id),tokens=bySource.get(id)??new Set<string>();
      for(const token of tokenizeRecallText(body.toString('utf8')))tokens.add(token);bySource.set(id,tokens);
    }}finally{iterator.return?.();}
    if(!exhausted)truncated=true;
    const df=new Map<string,number>();for(const tokens of bySource.values())for(const token of tokens)df.set(token,(df.get(token)??0)+1);
    const result={generation,sourceCount:bySource.size,df,truncated};if(!truncated||cap===1024&&inspected===cap&&Date.now()<deadline)this.recallStatistics.set(ns,result);
    return {...result,inspected,truncated};
  }
  readEvidenceSpan(spanIdOrPrefix:string, options:BoundedReadOptions&{namespaceId?:string;allowSupersededSource?:boolean}={}) {
    const ns=options.namespaceId??this.namespaceId;this.assertNamespace(ns);
    const budget=options.budget??(options.deadlineAt!==undefined||options.maxBytes!==undefined||options.maxInspected!==undefined?readBudget(options):undefined);
    if(budget&&(!available(budget)||Date.now()>=(options.deadlineAt??Infinity)||options.maxInspected===0))throw new Error('EvidenceReadBudgetExceeded');
    if(budget)budget.inspected++;
    const clean=String(spanIdOrPrefix).trim().toLowerCase();
    let row=this.db.prepare(`SELECT p.*,a.blob_sha256,a.kind AS artifact_kind,a.fidelity,s.namespace_id,s.origin_revision,l.status FROM spans p JOIN artifacts a USING(artifact_id) JOIN sources s ON s.source_id=p.source_id JOIN source_lifecycle l ON l.source_id=s.source_id WHERE p.span_id=? AND s.namespace_id=?`).get(clean,ns);
    if(!row && /^[a-f0-9]{8,63}$/.test(clean)) {
      const matches=this.db.prepare(`SELECT p.*,a.blob_sha256,a.kind AS artifact_kind,a.fidelity,s.namespace_id,s.origin_revision,l.status FROM spans p JOIN artifacts a USING(artifact_id) JOIN sources s ON s.source_id=p.source_id JOIN source_lifecycle l ON l.source_id=s.source_id WHERE p.span_id LIKE ? AND s.namespace_id=? LIMIT 2`).all(`${clean}%`,ns);
      if(matches.length===1) row=matches[0];
    }
    if(!row||row.status==='withdrawn'||row.status!=='active'&&!options.allowSupersededSource)throw new Error('EvidenceSpanUnavailable');
    const fullSpanId=String(row.span_id);
    const start=Number(row.byte_start),end=Number(row.byte_end);
    if(budget&&(end-start>Math.min(options.maxBytes??Infinity,budget.maxBytes-budget.bytes)||Date.now()>=Math.min(options.deadlineAt??Infinity,budget.deadlineAt)))throw new Error('EvidenceReadBudgetExceeded');
    const bytes=budget?this.readBlobRange(String(row.blob_sha256),start,end):this.readBlobUnchecked(String(row.blob_sha256)).subarray(start,end);
    if(budget)budget.bytes+=bytes.length;
    if(sha256(bytes)!==row.quote_sha256)throw new Error('EvidenceQuoteMismatch');
    return {spanId:fullSpanId,sourceId:String(row.source_id),namespaceId:ns,sourceRevision:String(row.origin_revision),artifactId:String(row.artifact_id),artifactKind:String(row.artifact_kind),fidelity:String(row.fidelity),byteStart:Number(row.byte_start),byteEnd:Number(row.byte_end),text:bytes.toString('utf8'),bytes,status:String(row.status)};
  }
  /**
   * Git-style deterministic short span ID (`>= 8` hex chars) for LLM wire rendering:
   * Returns an 8-char prefix of the immutable SHA-256 `span_id` (100% stable for cloud KV-caching),
   * automatically extending to 10/12/16 chars if another span in the namespace shares the prefix.
   */
  formatShortSpanId(spanId:string, namespaceId=this.namespaceId):string {
    const clean=String(spanId).toLowerCase();
    for(const len of [8,10,12,16,64]){
      if(len>=clean.length)return clean;
      const prefix=clean.slice(0,len);
      const conflict=this.db.prepare('SELECT p.span_id FROM spans p JOIN sources s USING(source_id) WHERE s.namespace_id=? AND p.span_id LIKE ? AND p.span_id<>? LIMIT 1').get(namespaceId,`${prefix}%`,clean);
      if(!conflict)return prefix;
    }
    return clean;
  }
  /** Range hydration verifies each immutable quote, without reading/hashing the
   * complete artifact. Whole-artifact audits remain the readBlob API's job. */
  private readBlobRange(hash:string,start:number,end:number):Buffer {
    if(!/^[a-f0-9]{64}$/.test(hash))throw new Error('Invalid SHA-256');
    const row=this.db.prepare('SELECT byte_length,storage_kind,relative_path,state FROM blobs WHERE sha256=?').get(hash);
    if(!row||row.state!=='ready'||start<0||end<start||end>Number(row.byte_length))throw new Error('BlobUnavailable');
    if(row.storage_kind==='inline')return Buffer.from(this.db.prepare('SELECT substr(inline_bytes,?,?) AS bytes FROM blobs WHERE sha256=?').get(start+1,end-start,hash)!.bytes as Uint8Array);
    const expected=join(hash.slice(0,2),hash.slice(2,4),hash);if(row.relative_path!==expected)throw new Error('Unsafe CAS path');
    const path=join(this.blobRoot,expected);secureDirectory(dirname(path));safeFile(path);
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      if(fstatSync(fd).size!==Number(row.byte_length))throw new Error('Blob hash mismatch');
      const bytes=Buffer.alloc(end-start);let offset=0;
      while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,start+offset);if(!n)throw new Error('BlobUnavailable');offset+=n;}
      return bytes;
    }finally{closeSync(fd);}
  }
  getEvidenceChunks(sourceId:string, options:BoundedReadOptions&{namespaceId?:string;allowSupersededSource?:boolean;afterByteStart?:number;byteStart?:number;byteEnd?:number}={}) {
    const ns=options.namespaceId??this.namespaceId;this.assertNamespace(ns);
    const budget=readBudget(options),deadline=Math.min(options.deadlineAt??Infinity,budget.deadlineAt),cap=options.maxInspected??512,maxBytes=options.maxBytes??1024*1024;
    const after=options.afterByteStart??-1,from=options.byteStart??0,to=options.byteEnd??Number.MAX_SAFE_INTEGER;
    for(const n of [cap,maxBytes,from,to])if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid evidence bounds');
    if(!Number.isSafeInteger(after)||after< -1||to<from)throw new Error('Invalid evidence bounds');
    const result:{spanId:string;sourceId:string;namespaceId:string;sourceRevision:string;artifactId:string;artifactKind:string;fidelity:string;byteStart:number;byteEnd:number;text:string;bytes:Buffer;status:MemoryStatus;chunkId:string;ordinal:number}[]=[];
    let inspected=0,bytes=0,truncated=false,nextByteStart=after;
    const done=()=>readMetadata(result,{inspected,bytes,truncated,nextByteStart});
    if(!available(budget)||Date.now()>=deadline||!cap||!maxBytes){truncated=true;return done();}
    const source=this.getSource(sourceId);
    if(!source||source.namespaceId!==ns||source.status==='withdrawn'||source.status!=='active'&&!options.allowSupersededSource)return done();
    const preferred=this.db.prepare(`SELECT a.artifact_id,a.blob_sha256,a.kind,a.fidelity FROM artifacts a WHERE a.source_id=? AND EXISTS(SELECT 1 FROM spans p JOIN chunks c USING(span_id) WHERE p.artifact_id=a.artifact_id)
      ORDER BY CASE WHEN a.kind=? THEN -1 WHEN a.kind='text' THEN 0 WHEN a.kind='raw' THEN 1 WHEN a.kind='transcript' THEN 2 WHEN a.kind='ocr' THEN 3 WHEN a.kind='caption' THEN 4 WHEN a.kind='normalized_message' THEN 10 ELSE 9 END,a.artifact_id LIMIT 1`).get(sourceId,source.kind==='turn'||source.kind==='tool_result'?'text':'raw');
    if(!preferred)return done();
    // Index order avoids sorting/materializing every chunk before the first row.
    const iterator=this.db.prepare(`SELECT c.chunk_id,c.ordinal,p.* FROM spans p INDEXED BY cf_spans_artifact_range JOIN chunks c INDEXED BY cf_chunks_span USING(span_id) WHERE p.artifact_id=? AND p.byte_start>? AND p.byte_end>? AND p.byte_start<? ORDER BY p.byte_start,p.span_id LIMIT ?`).iterate(preferred.artifact_id,after,from,to,Math.min(cap,budget.maxInspected-budget.inspected));
    let exhausted=false;
    try{while(inspected<cap&&bytes<maxBytes&&available(budget)&&Date.now()<deadline){
      const next=iterator.next();if(next.done){exhausted=true;break;}const r=next.value;inspected++;budget.inspected++;
      const start=Number(r.byte_start),end=Number(r.byte_end),size=end-start;
      // Do not hydrate an oversized legacy quote just to discard it afterwards.
      // The cursor remains before it, so callers may request a smaller exact span.
      if(start<0||end<start)throw new Error('EvidenceQuoteMismatch');
      if(size>maxBytes-bytes||size>budget.maxBytes-budget.bytes){truncated=true;break;}
      if(Date.now()>=deadline){truncated=true;break;}
      const quote=this.readBlobRange(String(preferred.blob_sha256),start,end);bytes+=quote.length;budget.bytes+=quote.length;
      if(sha256(quote)!==r.quote_sha256)throw new Error('EvidenceQuoteMismatch');
      nextByteStart=start;
      result.push({spanId:String(r.span_id),sourceId,namespaceId:ns,sourceRevision:source.originRevision,artifactId:String(preferred.artifact_id),artifactKind:String(preferred.kind),fidelity:String(preferred.fidelity),byteStart:start,byteEnd:end,text:quote.toString('utf8'),bytes:quote,status:source.status,chunkId:String(r.chunk_id),ordinal:Number(r.ordinal)});
    }}finally{iterator.return?.();}
    if(!exhausted)truncated=true;
    return done();
  }
  getRelatedNodes(seedIds:string[], options:{namespaceId?:string;limit?:number;includeSuperseded?:boolean;maxInspected?:number;deadlineAt?:number}={}) {
    const ns=options.namespaceId??this.namespaceId;this.assertNamespace(ns);
    const limit=options.limit??64,maxInspected=options.maxInspected??256,deadlineAt=options.deadlineAt??Infinity;
    if(!Number.isSafeInteger(limit)||limit<0||!Number.isSafeInteger(maxInspected)||maxInspected<0||Number.isNaN(deadlineAt))throw new Error('Invalid relation bounds');
    const result:{seedNodeId:string;node:DerivedNodeRecord;relation:string;direction:string}[]=[];
    let inspected=0,truncated=false;const seen=new Set<string>();
    const stop=()=>{if(result.length>=limit||inspected>=maxInspected||Date.now()>=deadlineAt){truncated=true;return true;}return false;};
    const valid=(row:Row)=>row.namespace_id===ns&&(row.status==='active'||options.includeSuperseded&&row.status==='superseded');
    function* boundedRows(iterator:IterableIterator<Row>) {
      try {while(!stop()){const next=iterator.next();if(next.done)return;inspected++;yield next.value;}}
      finally {iterator.return?.();}
    }
    const current=(row:Row)=>{
      const iterator=this.db.prepare(`SELECT l.status FROM provenance p JOIN spans s USING(span_id) JOIN source_lifecycle l USING(source_id) WHERE p.node_id=?`).iterate(row.node_id);
      for(const p of boundedRows(iterator))if(p.status!=='active')return false;
      return !truncated;
    };
    const add=(seed:Row,row:Row,relation:string,direction:string)=>{
      const key=seed.node_id+'\0'+row.node_id+'\0'+relation;
      if(seen.has(key)||!valid(row)||!current(row))return;
      seen.add(key);result.push({seedNodeId:String(seed.node_id),node:nodeRecord(row),relation,direction});
    };
    const keys=(row:Row)=>{const c=JSON.parse(String(row.canonical_json));return [c.entity,...(Array.isArray(c.entityKeys)?c.entityKeys:[]),...(Array.isArray(c.entries)?c.entries:[]).flatMap((e:any)=>Array.isArray(e.entityKeys)?e.entityKeys:[])].filter((x:any)=>typeof x==='string'&&!/^(record|fact|timeline|status|sample)$/i.test(x));};
    // SQL iterators stream from bounded index ranges. No sort/materialization of
    // all edges or derived nodes is performed before the work/deadline guard.
    const seedSeen=new Set<string>();
    for(const id of seedIds){
      if(stop())break;inspected++;
      if(seedSeen.has(id))continue;seedSeen.add(id);
      const seed=this.db.prepare('SELECT * FROM derived_nodes WHERE node_id=? AND namespace_id=?').get(id,ns);
      if(!seed||!valid(seed)||!current(seed))continue;
      for(const direction of ['outgoing','incoming']){
        if(stop())break;
        const outgoing=direction==='outgoing';
        const sql=outgoing?`SELECT e.relation,n.* FROM derivation_edges e JOIN derived_nodes n ON n.node_id=e.child_node_id WHERE e.parent_node_id=?`:`SELECT e.relation,n.* FROM derivation_edges e INDEXED BY cf_edges_child JOIN derived_nodes n ON n.node_id=e.parent_node_id WHERE e.child_node_id=?`;
        for(const row of boundedRows(this.db.prepare(sql).iterate(id))){
          add(seed,row,String(row.relation),direction);
        }
      }
      if(stop())break;
      const shared=new Set(keys(seed));if(!shared.size)continue;
      for(const row of boundedRows(this.db.prepare("SELECT * FROM derived_nodes INDEXED BY derived_lookup WHERE namespace_id=?").iterate(ns))){
        if(row.status==='active'&&row.node_id!==seed.node_id&&keys(row).some(k=>shared.has(k)))add(seed,row,'shared_key','shared_key');
      }
    }
    // Non-enumerable metadata keeps legacy array equality/serialization intact.
    return Object.defineProperties(result,{inspected:{value:inspected,enumerable:false},truncated:{value:truncated,enumerable:false}}) as typeof result & {inspected:number;truncated:boolean};
  }
  rebuildRecallProjection(namespaceId=this.namespaceId):{updated:number;lexicalVersion:string} {
    this.assertNamespace(namespaceId,'write');return this.transaction(()=>{
      let updated=0;
      for(const row of this.db.prepare(`SELECT d.rowid,d.title,d.body,coalesce(n.title,c.title,'') AS canonical_title FROM retrieval_documents d LEFT JOIN derived_nodes n USING(node_id) LEFT JOIN chunks c USING(chunk_id) WHERE d.namespace_id=? ORDER BY d.rowid`).all(namespaceId)){
        const title=lexicalProjectionTitle(String(row.canonical_title),String(row.body));if(title!==row.title){this.db.prepare('UPDATE retrieval_documents SET title=? WHERE rowid=?').run(title,row.rowid);updated++;}
      }
      const row=this.db.prepare('SELECT policy_json FROM namespaces WHERE namespace_id=?').get(namespaceId)!;const policy=JSON.parse(String(row.policy_json));
      if(policy.lexicalVersion!==LEXICAL_VERSION){policy.lexicalVersion=LEXICAL_VERSION;this.db.prepare('UPDATE namespaces SET policy_json=? WHERE namespace_id=?').run(canonicalJson(policy),namespaceId);updated++;}
      if(updated)this.bumpGeneration(namespaceId);return {updated,lexicalVersion:LEXICAL_VERSION};
    });
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
