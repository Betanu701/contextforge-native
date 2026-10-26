# ContextForge v2 — SQLite Storage and Multimodal Schema

**Status:** review-ready specification; not an implemented engine. **Date:** 2026-10-25. **Package:** `contextforge-native`. **Runtime:** TypeScript, Node 24, built-in `node:sqlite` `DatabaseSync`. Companion: [03 — Elastic planner and cache](03-ELASTIC-CONTEXT-PLANNER-AND-KV-CACHE.md).

## 1. Decisions, evidence, and ownership

The new implementation replaces transcript replay as the *model context selection strategy*, not the host's durable transcript/audit facility. It replaces the Python HTTP bridge entirely. L0 is authoritative; L1–L3 are reproducible, source-backed projections. No LLM, embedding service, Python process, or HTTP server is required on ingestion or assembly's critical path.

Evidence inspected: installed `/app/package.json` reports OpenClaw `2026.10.4`; `/app/docs/concepts/context-engine.md` documents native engine registration, accepted-turn fences, atomic `commitTurn`, background maintenance, and model-facing `assemble`. `/app/docs/plugins/hooks/prompt-and-session.md` documents prompt replacement and restrictive tool policy. Node `v24.21.0` here reports SQLite `3.53.4`; an actual `fts5` table creation succeeded. These are local baseline checks, not integration certification. Historical ContextForge hierarchy/permanent-context designs were located through memory/wiki search; their old summary compaction and advertised cache performance are **historical**, not inherited proof. This specification adopts the user's fresh-native decision and source-authority invariants, not old implementation claims.

Existing-solutions preflight: OpenClaw already supplies the context-engine slot, memory-core, memory-wiki, and transcript lifecycle. Reuse them; do not implement another host or memory authority. SQLite supplies transactions, WAL, JSON functions, and FTS5. Native custom storage/planning is explicitly requested. No vector database is necessary for v1; an optional offline embedding index must remain a replaceable projection.

Ownership:
- `contextforge-native` owns its DB, blobs, compiler, selection receipts, and context-engine slot (`contextforge`).
- `plugins.slots.memory = "memory-core"` remains unchanged. `memory-wiki` remains the owner of its vault and mutation APIs. ContextForge never writes their internal SQLite tables or Markdown behind their backs.
- Explicit imports of memory/wiki versions become L0 *external-source snapshots* with origin IDs, hashes, ACLs, and import receipts. Imports do not turn machine-generated text into verified human statements. Exporting a compiled page is opt-in, through the existing owner API, with an idempotency key; exported artifacts are marked derived to prevent import feedback loops.
- No access to `health_journal/` is needed or authorized by this specification.

## 2. Storage, threading, and durability

Default database: `~/.openclaw/state/contextforge.sqlite`; blob root: `~/.openclaw/state/contextforge/blobs/sha256/`. A per-agent alternative is `<agentStateDir>/contextforge.sqlite` with sibling blob directory; do not confuse the agent's configuration directory with a writable state directory. The resolved root and mode are explicit configuration, not environment-variable string interpolation.

Use a dedicated **worker_thread in the same Node process** for the single write connection and expensive synchronous queries. `DatabaseSync` is synchronous: wrapping calls in `async` does not prevent event-loop blocking. Engine instances borrow a process-level store service keyed by canonical DB path, with reference counting; disposal of one invocation must not close another's connection. A bounded worker queue applies backpressure. Large ingest jobs yield between transaction batches; accepted-turn persistence has priority. Read-only connections may execute bounded snapshot queries in reader workers. No synchronous filesystem/SQLite scan on the Gateway event loop.

Create directories mode `0700`, DB/blob files `0600`, and reject symlink escapes. Keep WAL on local disk, not network filesystems. Configure and verify every connection as applicable:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -32768;
```

`journal_mode` is set by the writer before readers open; read-only connections verify it. Cache size is a per-connection KiB target, not a context cap. A 5-second busy timeout must not stall the Gateway thread. All SQL values use bound parameters; whitelist identifiers. Disable extension loading. Avoid attaching untrusted DBs. Startup probes check foreign keys, JSON, STRICT tables, FTS5 and SQLite version, then run schema migrations. `trusted_schema=OFF` is recommended only after testing this schema's FTS triggers against the shipped SQLite build; do not silently disable functional triggers. Reader connections use `query_only=ON`.

One writer, `BEGIN IMMEDIATE` for a mutation, explicit `COMMIT`/`ROLLBACK`, no awaited I/O inside transactions. Long document parsing precedes short commits. Default FULL durability favors turn survival; changing to NORMAL requires an explicit durability setting and documented power-loss tradeoff. Backups use `node:sqlite` backup capability where available or a quiesced SQLite-consistent snapshot—not copying the main file while WAL is active. Back up referenced blobs plus a manifest; verify restore in tests. Online passive checkpoints are opportunistic; truncating checkpoints only while readers permit. Never run VACUUM in a foreground turn.

## 3. Complete version-1 DDL

This block is an executable new-database migration. Application invariants supplement SQL constraints below; notably arbitrary polymorphic citations are intentionally avoided. IDs are opaque strings (UUIDv7 or deterministic SHA-256 IDs where specified), timestamps integer Unix milliseconds, intervals half-open. Text spans are **UTF-8 byte offsets into an immutable artifact**, never JavaScript UTF-16 indexes. JSON is canonicalized before hashing using one versioned canonical JSON encoder; SHA-256 input domain tags prevent cross-object ambiguity.

```sql
BEGIN IMMEDIATE;
CREATE TABLE schema_migrations (
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
COMMIT;
```

The migration runner inserts the exact migration checksum and timestamp into `schema_migrations` in the **same transaction**, immediately before COMMIT; the above portable test block omits runtime-bound values. Never overwrite an existing migration to hide drift. `PRAGMA user_version` and the ledger must agree. The application enforces immutable factual payloads on `derived_nodes` (only lifecycle fields may change), namespace equality on every session/source/chunk/entity/edge link, layer-specific kinds, acyclic containment/derivation/lineage, blob hashes, MIME validity, selector bounds, and at least one valid L0 provenance span for every published L1/L2/L3 node **before transaction commit**. SQL triggers are defense in depth, not a complete authorization system. No arbitrary SQL endpoint is exposed.

Atomic mutation APIs build unpublished rows within a transaction, attach provenance, validate the graph, then commit; readers never observe a provenance-free published node. Namespace-crossing references must use an explicitly authorized import snapshot into the destination namespace, retaining original custody metadata. App-level ACLs apply before all reads, writes, snippets, exports and hydration. Physical CAS deduplication never authorizes retrieval by a guessed hash.

## 4. L0 ingestion and exactly-once accepted turns

The authoritative payload is the exact original bytes or canonical serialization of the host's structured message, including content blocks, tool-call IDs, attachments, and ordering. Do not flatten images to `[image]` or tool calls to prose. Keep original bytes and normalized adapter output as separate artifacts; explicitly excluded host-private reasoning or secrets must not be reconstructed or acquired from hidden channels.

`commitTurn({sessionId, advancementKey, messages})` must perform one transaction:
1. Hash the canonical accepted payload. If `(session_id, advancement_key)` exists with the same hash, return `{status:'duplicate'}`; if the hash differs, raise an idempotency collision, never silently accept it.
2. Ensure all referenced blobs are durable and validated. Allocate message sequence ranges monotonically under the writer lock. Insert L0 sources, initial lifecycle rows, normalized message artifacts, occurrence/protocol-group records and compiler outbox jobs with stable origin IDs. A repeated content hash deduplicates *bytes*, not distinct utterance occurrences or observations.
3. Insert `turn_commits`, increment the namespace generation, and commit; only then return `{status:'committed'}`. A failed acknowledgment is retryable by the host using the same key.
4. Compile cheap structured records in the same transaction only within a measured foreground work allowance. Otherwise source+job are committed together. Assembly reads the raw tail and pending-source text index even when derived compilation lags. A source is never temporarily lost because compilation is deferred.

Declare host transcript fences and advancement idempotency exactly as documented. In this host, `assemble` receives history **before the admitted current turn** and the host subsequently appends pending user/tool messages. Do not ingest pending drafts as accepted L0 or duplicate the current message in returned history. Bootstrap/import uses the host transcript cursor API and stable origin IDs; no rewrite of the transcript is necessary. Failed/aborted assistant drafts remain host-owned unless a separately labeled diagnostic import is explicitly enabled. `ingest`/`ingestBatch` and bootstrap share source idempotency; they do not fabricate advancement keys. A durable worker job table is required because host background `maintain()` scheduling alone is best-effort.

### Blob write protocol and retention

Stream input to a same-filesystem temporary file while hashing; validate file size, sniffed MIME and parser limits; fsync; rename atomically to `<first2>/<next2>/<sha256>`; fsync the parent directory; then reference the ready blob in a DB transaction. Existing destination bytes must match hash and size. Small values may use inline BLOBs; threshold is an I/O tuning setting, not a model-context cap. Crash before DB commit leaves an unreferenced file, not a broken committed reference. Missing or corrupt files are quarantined, and hydration fails explicitly.

Garbage collection is mark-and-sweep from DB artifact/source/epoch references plus active ingest leases and backup manifests, with a grace interval longer than the maximum ingest lease. Blob reference counts are not trusted as the sole GC authority. Workers pin files while hydration streams them. File URLs and signed provider upload handles are not durable blob identity; refresh handles from authorized local blobs when they expire.

Logical withdrawal hides a source and its derived dependents immediately, invalidates affected epochs/receipts, and records a causal event. Legal deletion is a separate privileged, recoverable workflow: remove relevant FTS/projections and provenance-bearing descendants, purge payload references, sweep unreferenced shared blobs, account for backups, and document WAL/free-page recovery limits. `secure_delete` cannot retroactively erase remote caches or historical backups. Never promise physical erasure from a status flag.

## 5. Deterministic ingestion-time compiler

### 5.1 What it can and cannot know

“Deterministic” means identical authoritative bytes, parser configuration, compiler version, namespace policy and dependency snapshot produce identical output manifests. It does **not** mean a regex system can reliably infer arbitrary natural-language facts, resolve pronouns, detect every contradiction, or summarize unrestricted documents semantically. The zero-LLM fast path is deliberately conservative:

- Parse typed tool submissions, explicit `cf_remember` records, structured JSON/CSV/frontmatter, dated logs and controlled declarative forms into L1.
- Extract document headings, exact quotations, links, tables, code symbols and timestamps structurally, producing L0 chunks and extractive L2 indexes even when **no** semantic L1 fact is justified.
- Recognize natural-language candidate facts with versioned grammars, but mark ambiguous output `unresolved_candidate`, preserve exact quote, and exclude it from authoritative status registers/L3. Queries can still retrieve its L0 evidence.
- Treat assistant conclusions as assistant claims. Repetition never converts them into human observations. An optional off-path semantic enrichment provider may propose separately labeled nodes, but is not part of the deterministic promise and never blocks a turn.

OCR/ASR/caption generation may require installed native tooling or model inference and is **not** a guaranteed sub-5ms deterministic operation. Store producer/version/config/seed where available, actual output hash and `machine_inferred` fidelity. The downstream compiler is deterministic *given* that output. Ingestion status distinguishes `raw_ready`, `text_ready`, and `derived_ready` through source metadata plus job receipts; report unavailable extraction rather than inventing text.

### 5.2 Pipeline and output rules

1. **Decode with fidelity:** retain original bytes; construct a normalized text artifact and byte-offset mapping back to raw text. Record encoding, line-ending transformations and parser version. A normalizer must not claim direct raw offsets after stripping Markdown, ligatures or OCR layout.
2. **Chunk by structure:** paragraphs/headings, table cells with repeated headers, AST symbols when a supported parser is installed, PDF pages/regions, transcript speaker/time segments. Overlap only for retrieval continuity; every chunk owns exact spans and overlap metadata so evidence is not double-counted.
3. **Parse explicit assertions:** a fact contains subject/entity, predicate, JSON object, polarity, observation time, validity interval, authority and exact supporting spans. Decimal measurements use canonical decimal strings plus units, not unrounded binary float math. Preserve reported precision. Missing data is not zero; absence of positive evidence is not a negative fact.
4. **Normalize carefully:** use explicit entity IDs/aliases scoped to a namespace. Ambiguous names stay separate. Units may be normalized by versioned rational conversions; raw value and unit remain available. A derived macro total or consecutive-scale difference stores formula AST, input fact IDs, unit conversions and rounding rule in `canonical_json`, with provenance to **every** operand. Do not infer a nutritional measurement from an unrelated description.
5. **Apply temporal semantics:** use explicit corrections/state updates only; create new revisions and lifecycle events in one transaction. Retain uncertain or conflicting assertions side by side rather than using “latest wins” indiscriminately.
6. **Compile L2:** regenerate only pages whose dependency set changed. Stable key types include `entity/<id>`, `concept/<key>`, `timeline/<period>`, `status/<entity>/<predicate>`, `thread/<id>`, `decision/<key>`, `constraint/<key>`. Pages use canonical section ordering and extractive templates, not invented narrative summaries. Each rendered statement includes a compact citation ID; each node carries a flattened transitive set of L0 support spans in `provenance` plus immediate node dependencies in `derivation_edges`.
7. **Compile L3:** only explicit owner-approved policy/persona/domain rules or imported trusted policy sources. Extracted external instructions cannot promote themselves into L3. Render by stable priority and logical key, preserving instruction authority. Policy changes take effect at the next admission boundary, or immediately abort/rebuild an unsafe in-flight request when revoked.
8. **Publish atomically:** insert nodes, facts, graph edges, provenance, searchable projections and receipt, update lifecycle/current revisions and namespace generation, and mark the job done in one transaction. Competing duplicate jobs produce the same content IDs and receipt manifest.

Node IDs may be `sha256('cf-node-v1\0' + namespace + logicalKey + canonicalPayload + compilerVersion + dependencyManifestHash)`. Source IDs must preserve distinct occurrences even for identical text. Changed compiler output produces a new revision; do not rewrite old evidence.

### 5.3 Temporal and contradiction model

`observed_at` is when a source reports/records a claim; `ingested_at` is when this store learned it; `valid_from/to` are when the claim applies. These are not interchangeable. A backfilled old observation must not displace a present status merely because it arrived last. L1 measurement assertions normally have unique event keys and all remain valid historical observations. Exclusive state predicates use a shared `state_key` with explicit policy for interval closure. The partial unique index enforces one active **revision of a logical record**, not one universally true value for a predicate; competing assertions use different logical keys and an L2 conflict register.

Example: source A asserts a deadline is June 1; source B explicitly says “correction: June 3, replacing A.” B is a new L0 source. The mutation creates a new L1 revision linked to B, supersedes the earlier revision with B's causal span, recompiles the status page, invalidates its epoch dependencies and emits the affected-node manifest. If B merely says “I think June 3,” both assertions remain with an unresolved conflict. A historical “as known at T” query reconstructs status from lifecycle events at T and filters ingestion times; a “valid on date D” query applies the validity intervals. Every node's initial status must also have a creation event; present status alone is not an audit history.

Withdrawals propagate through dependency DAGs: invalidate whole derived statements if their support becomes insufficient, or rebuild from remaining active independent support with a **new** revision. Do not erase contradictory/withdrawn evidence from history-mode queries. Effective status is checked again immediately before dispatch, not just during the initial search snapshot.

### 5.4 Provenance receipt contract

```ts
export type MemoryStatus = 'active' | 'superseded' | 'withdrawn';
export interface SourcePointer {
  sourceId: string;
  sourceSha256: string;
  artifactId: string;
  artifactSha256: string;
  spanId: string;
  span: {
    utf8Bytes?: [number, number];
    pagesInclusive?: [number, number];
    timeMs?: [number, number];
    region?: { page?: number; frameTimeMs?: number;
      x: number; y: number; width: number; height: number; unit: 'normalized' | 'pixel' };
    selector?: string; // JSON pointer, code symbol or parser-defined selector
  };
  quoteSha256?: string;
  observedAt: number;
  status: MemoryStatus;
  fidelity: 'exact' | 'deterministic_transform' | 'lossy' | 'machine_inferred' | 'human_annotated';
  lineage: Array<{ artifactId: string; parentSpanId: string; transformSha256: string }>;
}
export interface CompilerReceipt {
  version: 1;
  receiptId: string;
  namespaceId: string;
  compilerVersion: string;
  parserVersions: Record<string, string>;
  inputManifestSha256: string;
  snapshotGeneration: number;
  committedGeneration: number;
  sources: SourcePointer[];
  createdNodeIds: string[];
  supersededNodeIds: string[];
  withdrawnNodeIds: string[];
  unresolved: Array<{ sourceId: string; spanId: string; code: string }>;
  coverage: { totalTextBytes: number; parsedTextBytes: number;
    candidateTextBytes: number; unclassifiedTextBytes: number };
  deterministicOutputSha256: string;
  elapsedMs: number; // excluded from deterministic output hash
}
```

Receipts prove provenance structure and deterministic processing, **not truth** of an assertion or correctness of OCR. Quoted spans are verified against artifact hashes. A receipt may contain multiple observations; “exact source” means exact custody, not perfect interpretation.

## 6. Multimodal and heavy document architecture

### 6.1 Common representation

L0 keeps the original image/audio/video/document blob. `artifacts` record original and derived renditions; `asset_metadata` stores physical dimensions/duration/codec; `artifact_lineage` maps derivatives to raw spans. Descriptions/transcripts are searchable artifacts, not substitutes for original media. Chunk graphs align pages, frames, audio segments and text. Searchable artifact text is exposed through span-backed chunks; binary bytes are never sent to FTS5.

Raw source authentication and authorization are evaluated separately from extraction confidence. Screenshots, subtitles, PDF text and audio transcripts may contain prompt injection; render them as untrusted evidence, never as system instructions. Reject path traversal, symlink escapes, decompression bombs and parser resource abuse. Extract in isolated workers/process sandboxes with no ambient credentials or network access. Parsers and codecs are adapters with pinned versions; optional external extraction binaries do not reintroduce the Python sidecar or another context authority. A no-extra-binary installation retains originals and supported text extraction, explicitly declaring missing codecs/extractors.

### 6.2 Media-specific behavior

| Media | Stored structure and indexes | Native hydration | Text-only fallback and limits |
|---|---|---|---|
| Image | original bytes/EXIF policy, dimensions, orientation; OCR text with boxes; captions with producer provenance; thumbnails/crops with source region | Exact original or explicitly chosen resolution/crop as provider-supported image block; calculate tile/resolution token charge | OCR/caption plus citation and `visual_not_observed`; never claim to see color/layout absent extraction |
| Audio | codec, duration, sample rate/channels; ASR transcript with time/word offsets, speaker labels with uncertainty; segments and waveform metadata | Provider-supported audio block/handle for relevant segment or whole asset when acoustic inspection is requested | Time-coded transcript; state that tone, speaker identity, music or sound characteristics were not directly inspected |
| Video | original container/tracks/timebase; subtitle/ASR tracks; scenes, keyframes and frame/audio alignment edges | Native video only when provider **and host adapter** support it; otherwise supported sampled image frames plus audio segments | Transcript plus timestamped captions; identify unsampled intervals and inability to infer continuous motion from still frames |
| PDF/document | immutable original; page hierarchy; extracted text/layout; tables, images, footnotes, references; scanned pages/regions; parser warnings | Native document block only if provider/host support that MIME; otherwise selected page images and text | Exact extracted passages/table headers; unreadable scanned pages are missing evidence, not blank pages |
| Code/repository | file blob/revision/path, encoding, symbol/section tree, imports/references, line mappings | Text blocks for selected files/symbols and dependencies | Same text; do not confuse a snapshot with a live file or claim all files examined |

PDF is a container capability, not necessarily a `model.input` modality. `model.input` is a first filter; a provider-specific capability registry also resolves MIME support, request byte limits, image count/dimensions, audio/video duration, token accounting, host message schema and whether URLs/uploads/base64 are accepted. Never invent a universal OpenClaw `audio` or `video` message shape. A native block must pass the actual installed SDK/provider adapter validator. Unsupported capability results in an explicit fallback/missing-modality receipt, not a synthetic text block labeled as native media.

### 6.3 On-demand hydration

The planner selects **references and renditions first**, estimates costs, then hydrates only selected assets through `MediaAdapter`:

```ts
export type InputModality = 'text' | 'image' | 'audio' | 'video';
export interface HydrationRequest {
  source: SourcePointer;
  renditionArtifactId: string;
  requestedModality: InputModality | 'document';
  purpose: 'semantic_recall' | 'visual_inspection' | 'acoustic_inspection' | 'motion_inspection' | 'exact_document';
  required: boolean;
  allowedMimeTypes: string[];
}
export interface HydrationReceipt {
  sourceId: string;
  artifactId: string;
  modality: InputModality | 'document';
  mode: 'native' | 'text_fallback' | 'unavailable';
  fidelity: string;
  wireBytes: number;
  estimatedInputTokens: number;
  tokenEstimateKind: 'exact' | 'provider' | 'upper_bound' | 'heuristic';
  coveredPages?: Array<[number, number]>;
  coveredTimeMs?: Array<[number, number]>;
  uncoveredReason?: string;
  adapterVersion: string;
}
export interface MediaAdapter<ValidatedHostContentBlock> {
  supports(request: HydrationRequest): boolean;
  estimate(request: HydrationRequest): Promise<HydrationReceipt>;
  hydrate(request: HydrationRequest, signal: AbortSignal): Promise<{
    blocks: ValidatedHostContentBlock[];
    receipt: HydrationReceipt;
  }>;
}
```

The generic parameter is bound to an imported SDK content-block type at implementation, not `any`. Hydration rechecks principal access, source status, blob hash, provider destination policy and format support. Private media cannot be uploaded to a cloud provider solely because a search found it; destination policy comes from the user's configured permissions. Cache upload handles by provider account/tenant/asset/expiry; never persist bearer URLs inside prompt or audit text. Logs record hashes and opaque IDs rather than raw images or credentials.

Current pending attachments are host-owned and appended once. Historical attachment recall must hydrate its selected source only once per request; deduplicate identical rendition hashes while retaining all citations. Keep media with its explanatory text and provenance as an atomic selection unit. Replayed historical tool results retain complete protocol groups or are rendered as clearly labeled quoted evidence—not orphan `tool` messages.

Large assets stream from disk and are bounded by transport memory/backpressure. Frame/page sampling is query-aware: inspect explicitly requested pages/times first; expand to neighboring context, tables/headers, and more frames when demand warrants. Sampling never supports an “examined every frame/page” claim. Whole-document requests require full coverage or an explicit coverage failure. If one request cannot carry a document, schedule a task-visible multi-pass plan outside `assemble`; do not secretly summarize away omitted pages or start model calls from the planner.

## 7. Retrieval, transactions, and recovery

FTS5 is a candidate generator, not a source of truth. Use a parameterized MATCH expression generated by an escaping query builder; literal user quotes/operators are not executed as SQL. Join FTS row IDs to `retrieval_documents`, filter authorized namespaces and active source/node lifecycle **before returning any snippets**, then rerank by BM25, explicit entity/time matches, source authority, temporal applicability, conflict relevance and exact-reference priority. Tenant/namespace partitioning prevents unauthorized top-K starvation; retrieval must continue paging authorized results rather than truncate a mixed tenant result list then filter. FTS global term statistics can create a side channel in multi-tenant deployments: use separate DBs/FTS partitions for mutually untrusted tenants.

L2 routes to L1/L0; it does not replace evidence when the task asks for quotations, numbers, contradictions or media inspection. Selection expands graph neighbors and dependency closure. Candidate pagination may stop on satisfied demand or physical request capacity, never a hidden `LIMIT 20` product ceiling. Broad scans have cancellable work batches and measured deadlines; incomplete retrieval is disclosed with a continuation cursor.

A read snapshot records namespace generation vector. Do not hold a WAL read transaction during remote hydration or tokenization: materialize immutable IDs/hashes, release it, then revalidate lifecycle/ACL generation before dispatch. If revoked or superseded evidence affects the plan, rebuild. Ordinary unrelated writes need not invalidate a compatible plan. FTS updates are atomic with projection mutation. Full rebuild derives retrieval documents from active schema objects, runs `INSERT INTO retrieval_fts(retrieval_fts) VALUES('rebuild')`, then integrity checks in a maintenance window.

Recovery: leased jobs expire and retry deterministically; failed parser jobs expose error codes and raw evidence remains available. `PRAGMA quick_check`, foreign-key checks, FTS integrity, provenance closure checks and CAS sampling run at controlled startup/maintenance intervals. Corruption never triggers dropping/reinitializing the DB automatically. Fail the affected context plan with a typed store error or explicitly enter host-degraded mode; do not quietly claim ContextForge guarantees while using legacy replay.

## 8. Acceptance gates and counterarguments

Required tests:
1. Execute the DDL on actual Node 24 `DatabaseSync`; reopen in WAL mode, assert FK/FTS support, insert/update/delete FTS projections, and verify migration checksums/rollback.
2. Replay identical accepted turns concurrently and after crash; exactly one advancement and one occurrence per host message. Same key/different payload must fail.
3. Crash at every blob/DB write boundary; no committed missing blob; orphan collection respects active leases/backups.
4. Compile deterministic fixtures twice and after restart; byte-identical semantic manifests; ambiguous free text never becomes authoritative L1/L3.
5. Test UTF-8 multibyte spans, CRLF normalization, Unicode combining characters, scanned PDF OCR offsets, video timestamps and every provenance tamper failure.
6. Supersede/withdraw through real mutation APIs; active, historical-valid-time and as-known-at queries agree; cache invalidation removes revoked data before next dispatch.
7. Permission-denied data never appears in ranking output, snippets, receipts, tool fallback, cloud uploads or exported pages; test same-hash blobs owned by different users.
8. Native image/audio/video/document adapters tested against real accepted host/provider payloads; text-only fallback names unobserved modalities and missing coverage.
9. Heavy corpus ingestion, retrieval and hydration remain cancellable with measured Gateway event-loop delay. Publish p50/p95/p99 latency and memory, not an unverified universal `<5ms` promise.
10. Backup/restore and compiler-version rebuild preserve L0 bytes, citations, historical states and idempotency keys. Memory-core/wiki continue their ordinary tests unchanged.

Strongest counterargument: this schema and provenance machinery can exceed the value of a simple FTS transcript store. Mitigation is staged implementation: accepted-turn L0+CAS+FTS first; typed L1 and extractive L2 second; L3 policy and temporal transitions third; media adapters and specialized extraction afterward. All stages share this single authority model; do not deploy placeholder semantic claims. Generic natural-language understanding still requires model reasoning at answer time. Historical records retained forever also consume disk—“no compaction” refers to blocking **model transcript summarization**, not zero storage maintenance or infinite capacity.

## 9. Specification verification record (2026-10-25)

The two SQL blocks above were extracted and executed verbatim with Node `v24.21.0` / SQLite `3.53.4`: schema creation passed (32 tables including FTS5 internals), `integrity_check` and `quick_check` returned `ok`, and `foreign_key_check` returned no violations. FTS5 insert/update/delete triggers were exercised with a valid namespace/source fixture; old terms disappeared and new terms were searchable. The immutable-source trigger rejected an UPDATE. A file-backed database reopened with `journal_mode=wal` and `user_version=1`. All TypeScript fenced blocks in documents 02 and 03 passed `tsc --strict --noEmit --target ES2022 --lib ES2022,DOM` using the installed TypeScript `7.1.0-dev.20260920.1` compiler. These checks validate DDL/type syntax and the named mechanics only; compiler semantics, concurrency, native host integration, provider hydration, authorization and performance remain implementation acceptance work.
