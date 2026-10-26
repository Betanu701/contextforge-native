import { createHash } from 'node:crypto';
export const SCHEMA_VERSION = 1;
export const SCHEMA_V1 = String.raw`CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
) STRICT;
CREATE TABLE namespaces (
  namespace_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('personal','agent','project','session','shared')),
  scope_key TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, scope_kind, scope_key)
) STRICT;
CREATE TABLE namespace_grants (
  namespace_id TEXT NOT NULL REFERENCES namespaces ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read','write','admin')),
  PRIMARY KEY(namespace_id, principal_id, permission)
) STRICT;
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  storage_kind TEXT NOT NULL CHECK(storage_kind IN ('inline','cas')),
  inline_bytes BLOB,
  relative_path TEXT,
  state TEXT NOT NULL CHECK(state IN ('ready','quarantined','missing')),
  created_at INTEGER NOT NULL,
  CHECK((storage_kind='inline' AND inline_bytes IS NOT NULL AND relative_path IS NULL)
     OR (storage_kind='cas' AND inline_bytes IS NULL AND relative_path IS NOT NULL)),
  CHECK(inline_bytes IS NULL OR length(inline_bytes)=byte_length)
) STRICT;
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  host_session_key TEXT NOT NULL,
  cursor_json TEXT CHECK(cursor_json IS NULL OR json_valid(cursor_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(namespace_id, host_session_key)
) STRICT;
CREATE TABLE turn_commits (
  session_id TEXT NOT NULL REFERENCES sessions,
  advancement_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, advancement_key)
) STRICT;
CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  session_id TEXT REFERENCES sessions,
  kind TEXT NOT NULL CHECK(kind IN ('turn','document','media','tool_result','external_snapshot','policy')),
  origin_system TEXT NOT NULL,
  origin_key TEXT NOT NULL,
  origin_revision TEXT NOT NULL,
  role TEXT CHECK(role IN ('user','assistant','tool','system','developer')),
  trust_class TEXT NOT NULL CHECK(trust_class IN ('owner_instruction','user_statement','assistant_output','tool_output','external_untrusted')),
  observed_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(namespace_id, origin_system, origin_key, origin_revision)
) STRICT;
CREATE INDEX sources_session_time ON sources(session_id, observed_at, source_id);
CREATE INDEX sources_namespace_time ON sources(namespace_id, observed_at, source_id);
CREATE TABLE source_lifecycle (
  source_id TEXT PRIMARY KEY REFERENCES sources,
  status TEXT NOT NULL CHECK(status IN ('active','superseded','withdrawn')),
  superseded_by TEXT REFERENCES sources,
  changed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  CHECK(superseded_by IS NULL OR superseded_by<>source_id)
) STRICT;
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources,
  kind TEXT NOT NULL CHECK(kind IN ('raw','text','ocr','transcript','caption','thumbnail','page_image','audio_segment','video_clip','keyframe','normalized_message')),
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  mime_type TEXT NOT NULL,
  text_content TEXT,
  producer TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  config_sha256 TEXT NOT NULL,
  fidelity TEXT NOT NULL CHECK(fidelity IN ('exact','deterministic_transform','lossy','machine_inferred','human_annotated')),
  observed_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  UNIQUE(source_id,kind,producer,producer_version,config_sha256,blob_sha256)
) STRICT;
CREATE INDEX artifacts_source ON artifacts(source_id,kind);
CREATE TABLE asset_metadata (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts,
  width_px INTEGER CHECK(width_px>0),
  height_px INTEGER CHECK(height_px>0),
  duration_ms INTEGER CHECK(duration_ms>=0),
  sample_rate_hz INTEGER CHECK(sample_rate_hz>0),
  channels INTEGER CHECK(channels>0),
  page_count INTEGER CHECK(page_count>0),
  frame_rate_num INTEGER CHECK(frame_rate_num>0),
  frame_rate_den INTEGER CHECK(frame_rate_den>0),
  codec TEXT,
  language TEXT,
  extra_json TEXT NOT NULL CHECK(json_valid(extra_json))
) STRICT;
CREATE TABLE spans (
  span_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources,
  artifact_id TEXT NOT NULL REFERENCES artifacts,
  byte_start INTEGER CHECK(byte_start>=0),
  byte_end INTEGER CHECK(byte_end>=byte_start),
  page_start INTEGER CHECK(page_start>=1),
  page_end INTEGER CHECK(page_end>=page_start),
  time_start_ms INTEGER CHECK(time_start_ms>=0),
  time_end_ms INTEGER CHECK(time_end_ms>=time_start_ms),
  region_json TEXT CHECK(region_json IS NULL OR json_valid(region_json)),
  selector_json TEXT NOT NULL CHECK(json_valid(selector_json)),
  quote_sha256 TEXT,
  observed_at INTEGER NOT NULL,
  CHECK((byte_start IS NULL)=(byte_end IS NULL)),
  CHECK((page_start IS NULL)=(page_end IS NULL)),
  CHECK((time_start_ms IS NULL)=(time_end_ms IS NULL))
) STRICT;
CREATE INDEX spans_source ON spans(source_id,artifact_id);
CREATE TABLE artifact_lineage (
  child_artifact_id TEXT NOT NULL REFERENCES artifacts,
  parent_span_id TEXT NOT NULL REFERENCES spans,
  transform_json TEXT NOT NULL CHECK(json_valid(transform_json)),
  PRIMARY KEY(child_artifact_id,parent_span_id)
) STRICT;
CREATE TABLE message_occurrences (
  session_id TEXT NOT NULL REFERENCES sessions,
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  source_id TEXT NOT NULL REFERENCES sources,
  host_message_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  tool_call_id TEXT,
  protocol_group_id TEXT NOT NULL,
  PRIMARY KEY(session_id,sequence),
  UNIQUE(session_id,host_message_id)
) STRICT;
CREATE INDEX message_groups ON message_occurrences(session_id,protocol_group_id,sequence);
CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  span_id TEXT NOT NULL REFERENCES spans,
  parent_chunk_id TEXT REFERENCES chunks,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  chunk_kind TEXT NOT NULL CHECK(chunk_kind IN ('document','section','paragraph','table','code','page','transcript_segment','frame','scene')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  layout_json TEXT NOT NULL CHECK(json_valid(layout_json)),
  compiler_version TEXT NOT NULL,
  UNIQUE(span_id,compiler_version,chunk_kind,ordinal)
) STRICT;
CREATE INDEX chunks_namespace ON chunks(namespace_id,chunk_kind);
CREATE INDEX chunks_parent ON chunks(parent_chunk_id,ordinal);
CREATE TABLE chunk_edges (
  from_chunk_id TEXT NOT NULL REFERENCES chunks ON DELETE CASCADE,
  to_chunk_id TEXT NOT NULL REFERENCES chunks ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('next','previous','references','table_header','caption_of','aligned_audio','aligned_video','continuation')),
  PRIMARY KEY(from_chunk_id,to_chunk_id,relation)
) STRICT;
CREATE TABLE entities (
  entity_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  entity_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK(json_valid(aliases_json)),
  UNIQUE(namespace_id,entity_key)
) STRICT;
CREATE TABLE derived_nodes (
  node_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  layer INTEGER NOT NULL CHECK(layer IN (1,2,3)),
  logical_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  compiler_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','superseded','withdrawn')),
  valid_from INTEGER,
  valid_to INTEGER,
  superseded_by TEXT REFERENCES derived_nodes,
  CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_to>valid_from),
  CHECK(superseded_by IS NULL OR superseded_by<>node_id),
  UNIQUE(namespace_id,logical_key,revision)
) STRICT;
CREATE UNIQUE INDEX derived_one_active_revision ON derived_nodes(namespace_id,logical_key) WHERE status='active';
CREATE INDEX derived_lookup ON derived_nodes(namespace_id,layer,status,kind);
CREATE INDEX derived_temporal ON derived_nodes(namespace_id,valid_from,valid_to);
CREATE TABLE facts (
  node_id TEXT PRIMARY KEY REFERENCES derived_nodes,
  entity_id TEXT REFERENCES entities,
  predicate TEXT NOT NULL,
  object_json TEXT NOT NULL CHECK(json_valid(object_json)),
  polarity INTEGER NOT NULL CHECK(polarity IN (-1,1)),
  assertion_kind TEXT NOT NULL CHECK(assertion_kind IN ('explicit','parsed_measurement','derived_calculation','unresolved_candidate')),
  unit TEXT,
  state_key TEXT,
  authority TEXT NOT NULL,
  confidence REAL CHECK(confidence>=0 AND confidence<=1)
) STRICT;
CREATE INDEX facts_predicate ON facts(entity_id,predicate,state_key);
CREATE TABLE provenance (
  node_id TEXT NOT NULL REFERENCES derived_nodes,
  span_id TEXT NOT NULL REFERENCES spans,
  relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','withdraws','supersedes','instructs')),
  extraction_rule TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(node_id,span_id,relation)
) STRICT;
CREATE TABLE derivation_edges (
  parent_node_id TEXT NOT NULL REFERENCES derived_nodes,
  child_node_id TEXT NOT NULL REFERENCES derived_nodes,
  relation TEXT NOT NULL CHECK(relation IN ('compiles','depends_on','contradicts','supersedes')),
  PRIMARY KEY(parent_node_id,child_node_id,relation),
  CHECK(parent_node_id<>child_node_id)
) STRICT;
CREATE TABLE lifecycle_events (
  event_id TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  source_id TEXT REFERENCES sources,
  node_id TEXT REFERENCES derived_nodes,
  from_status TEXT CHECK(from_status IN ('active','superseded','withdrawn')),
  to_status TEXT NOT NULL CHECK(to_status IN ('active','superseded','withdrawn')),
  cause_span_id TEXT NOT NULL REFERENCES spans,
  occurred_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  CHECK((source_id IS NOT NULL)+(node_id IS NOT NULL)=1)
) STRICT;
CREATE INDEX lifecycle_node_time ON lifecycle_events(node_id,occurred_at,event_id);
CREATE TABLE compile_jobs (
  job_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources,
  compiler_version TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','leased','done','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  available_at INTEGER NOT NULL,
  error_code TEXT,
  UNIQUE(source_id,compiler_version,input_sha256)
) STRICT;
CREATE INDEX jobs_ready ON compile_jobs(state,available_at);
CREATE TABLE compile_receipts (
  receipt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES compile_jobs,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  input_sha256 TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  output_manifest_json TEXT NOT NULL CHECK(json_valid(output_manifest_json)),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  committed_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE token_estimates (
  content_sha256 TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  modality TEXT NOT NULL,
  tokens INTEGER NOT NULL CHECK(tokens>=0),
  estimate_kind TEXT NOT NULL CHECK(estimate_kind IN ('exact','provider','upper_bound','heuristic')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  PRIMARY KEY(content_sha256,model_fingerprint,renderer_version,modality)
) STRICT;
CREATE TABLE epochs (
  epoch_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions,
  scope_fingerprint TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL,
  tools_sha256 TEXT NOT NULL,
  prefix_sha256 TEXT NOT NULL,
  prefix_blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','retired')),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  reason TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX epochs_active ON epochs(session_id,model_fingerprint,scope_fingerprint) WHERE state='active';
CREATE TABLE planner_receipts (
  receipt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions,
  admission_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  epoch_id TEXT REFERENCES epochs,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id,admission_id,attempt)
) STRICT;
CREATE TABLE retrieval_documents (
  rowid INTEGER PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces,
  source_id TEXT REFERENCES sources,
  chunk_id TEXT UNIQUE REFERENCES chunks ON DELETE CASCADE,
  node_id TEXT UNIQUE REFERENCES derived_nodes ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  CHECK((source_id IS NOT NULL)+(chunk_id IS NOT NULL)+(node_id IS NOT NULL)=1)
) STRICT;
CREATE INDEX retrieval_namespace ON retrieval_documents(namespace_id,rowid);
CREATE UNIQUE INDEX retrieval_source ON retrieval_documents(source_id) WHERE source_id IS NOT NULL;
CREATE VIRTUAL TABLE retrieval_fts USING fts5(
  title, body, content='retrieval_documents', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);
CREATE TRIGGER retrieval_ai AFTER INSERT ON retrieval_documents BEGIN
  INSERT INTO retrieval_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
END;
CREATE TRIGGER retrieval_ad AFTER DELETE ON retrieval_documents BEGIN
  INSERT INTO retrieval_fts(retrieval_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
END;
CREATE TRIGGER retrieval_au AFTER UPDATE ON retrieval_documents BEGIN
  INSERT INTO retrieval_fts(retrieval_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
  INSERT INTO retrieval_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
END;
CREATE TRIGGER source_payload_immutable BEFORE UPDATE ON sources BEGIN
  SELECT RAISE(ABORT,'L0 sources are immutable; create a new revision');
END;
CREATE TRIGGER artifact_payload_immutable BEFORE UPDATE ON artifacts BEGIN
  SELECT RAISE(ABORT,'artifacts are immutable; create a new artifact');
END;
CREATE TRIGGER span_payload_immutable BEFORE UPDATE ON spans BEGIN
  SELECT RAISE(ABORT,'spans are immutable');
END;
CREATE TRIGGER span_source_check BEFORE INSERT ON spans BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM artifacts a WHERE a.artifact_id=new.artifact_id AND a.source_id=new.source_id)
    THEN RAISE(ABORT,'span source/artifact mismatch') END;
END;
CREATE TRIGGER facts_layer_check BEFORE INSERT ON facts BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM derived_nodes n WHERE n.node_id=new.node_id AND n.layer=1)
    THEN RAISE(ABORT,'facts require L1 node') END;
END;
CREATE TRIGGER provenance_namespace_check BEFORE INSERT ON provenance BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM derived_nodes n JOIN spans p ON p.span_id=new.span_id
    JOIN sources s ON s.source_id=p.source_id
    WHERE n.node_id=new.node_id AND n.namespace_id=s.namespace_id)
    THEN RAISE(ABORT,'cross-namespace provenance forbidden') END;
END;
PRAGMA user_version = 1;
`;
export const SCHEMA_CHECKSUM = createHash('sha256').update(SCHEMA_V1).digest('hex');
export function configureDatabase(db) {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA temp_store=MEMORY;
    PRAGMA cache_size=-32768;`);
    if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Foreign keys unavailable');
    if (db.prepare("SELECT json_valid('{}') AS ok").get()?.ok !== 1) throw new Error('SQLite JSON unavailable');
}
export function migrate(db) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (version === 0) {
            db.exec(SCHEMA_V1);
            db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(SCHEMA_VERSION, SCHEMA_CHECKSUM, Date.now());
        } else if (version !== SCHEMA_VERSION) throw new Error(`Unsupported schema version ${version}`);
        const rows = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
        if (rows.length !== 1 || rows[0].version !== SCHEMA_VERSION || rows[0].checksum !== SCHEMA_CHECKSUM) throw new Error('Schema migration checksum/ledger mismatch');
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}


//# sourceURL=src/schema.ts