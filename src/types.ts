export type Modality = 'text' | 'image' | 'audio' | 'video';
export interface CapabilityEnvelope {
  providerId: string;
  modelId: string;
  modelFingerprint: string; // revision + tokenizer + chat template + adapter
  input: Modality[];
  nativeContextTokens: number;
  deploymentContextTokens: number; // actual n_ctx/provider route allocation
  hostTokenBudget: number;
  hostBudgetScope: 'history_only' | 'total_input';
  outputReserveTokens: number;
  reasoningReserveTokens: number; // zero if already included in output reserve
  systemTokens: number;
  toolSchemaTokens: number;
  framingTokens: number;
  pendingInputTokens: number;
  safetyMarginTokens: number; // calibrated uncertainty, not an arbitrary recall cap
  providerMaxInputTokens?: number;
  maxRequestBytes?: number;
  maxImages?: number;
  maxAudioDurationMs?: number;
  maxVideoDurationMs?: number;
  nativeDocumentMimeTypes: string[];
  reservationAccounting: Array<{
    component: 'output' | 'reasoning' | 'system' | 'tools' | 'framing' | 'pending' | 'safety';
    alreadyExcludedFromHostBudget: boolean;
  }>;
}

export type Layer = 'L0' | 'L1' | 'L2' | 'L3';
export type DemandClass = 'conversational' | 'analytical' | 'heavy_rag' | 'multimodal_inspection';
export type EstimateKind = 'exact' | 'provider' | 'upper_bound' | 'heuristic';
export type SelectionReason =
  | 'mandatory_policy' | 'explicit_reference' | 'continuity'
  | 'current_state' | 'semantic_match' | 'lexical_match'
  | 'provenance_support' | 'contradiction' | 'dependency'
  | 'coverage_expansion' | 'native_modality' | 'epoch_anchor';
export type ExclusionReason =
  | 'irrelevant' | 'redundant' | 'superseded' | 'withdrawn'
  | 'low_marginal_gain' | 'unsupported_modality' | 'physical_token_limit'
  | 'transport_limit' | 'extraction_pending' | 'source_unavailable'
  | 'retrieval_deadline' | 'corpus_not_enumerated';
export interface TokenCharge {
  text: number;
  media: number;
  framing: number;
  total: number; // text + media + framing
  estimateKind: EstimateKind;
  estimatorVersion: string;
}
export interface SelectionItem {
  selectionId: string;
  bundleId: string;
  namespaceId: string;
  layer: Layer;
  nodeId?: string;
  sourceId: string; // primary support; complete support in provenanceSpanIds
  artifactIds: string[];
  provenanceSpanIds: string[];
  contentSha256: string;
  status: 'active' | 'superseded' | 'withdrawn'; // history mode may select non-active
  observedAt: number;
  validInterval?: [number | null, number | null];
  role: 'system_policy' | 'quoted_evidence' | 'verbatim_history';
  required: boolean;
  reasons: SelectionReason[];
  obligationIds: string[];
  utility: number;
  costs: TokenCharge;
  renderedMessageIndexes: number[];
  epochSegment: 'stable' | 'dynamic';
}
export interface DemandObligation {
  obligationId: string;
  kind: 'source' | 'entity' | 'time_range' | 'comparison' | 'calculation'
    | 'contradiction' | 'citation' | 'modality' | 'exhaustive_coverage';
  required: boolean;
  requestedSourceIds: string[];
  requestedModality?: Modality | 'document';
  status: 'satisfied' | 'partial' | 'unresolved' | 'unavailable';
  selectedIds: string[];
  coverage?: {
    unit: 'documents' | 'pages' | 'chunks' | 'milliseconds' | 'regions';
    requested: number | null; // null means inventory is not proven complete
    covered: number;
    inventoryComplete: boolean;
  };
  reason?: string;
}
export interface ExpansionStage {
  index: number;
  tranche: number;
  trancheOptionalTokens: number;
  fraction: 0.25 | 0.5 | 0.75 | 1;
  allowedHistoryTokens: number;
  selectedHistoryTokens: number;
  candidatesVisited: number;
  candidatesRemaining: number | null;
  addedSelectionIds: string[];
  removedSelectionIds: string[];
  satisfiedObligationIds: string[];
  unresolvedObligationIds: string[];
  marginalUtility: number;
  action: 'expand_stage' | 'expand_tranche' | 'stop';
  reason: string;
  durationMs: number;
}
export interface ColdStorageReceipt {
  // Authorized considered candidates only; do not leak denied IDs/counts.
  exclusions: Array<{ id: string; layer: Layer; reason: ExclusionReason;
    estimatedTokens?: number; obligationIds: string[] }>;
  excludedManifest: { sha256: string; blobRef?: string; itemCount: number };
  unvisited: {
    authorizedCorpusCount: number | null;
    reason: 'demand_satisfied' | 'physical_limit' | 'deadline' | 'not_enumerated' | 'none';
    snapshotGeneration: Record<string, number>;
    continuationCursor?: string; // opaque, scoped and expiring; not an auth token
  };
}
export interface TokenBreakdown {
  // Disjoint ownership: these seven fields sum to serializedInputTokens.
  systemPolicy: number;
  toolSchemas: number;
  historicalTextByLayer: Record<Layer, number>;
  historicalMedia: number;
  pendingText: number;
  pendingMedia: number;
  protocolFraming: number;
  serializedInputTokens: number;
  reservedOutput: number;
  reservedReasoning: number;
  uncertaintyMargin: number;
  physicalWindow: number;
  admissibleHistory: number;
  selectedHistory: number;
  remainingHistoryCapacity: number;
  estimateKind: EstimateKind;
  providerObservedInputTokens?: number;
}
export interface CacheReceipt {
  epochId: string;
  mode: 'surgical' | 'anchored_burst' | 'disabled';
  prefixSha256: string;
  toolsSha256: string;
  eligibleStableTokens: number;
  measuredCommonPrefixTokens?: number;
  providerCachedTokens?: number;
  stablePrefixReuseRatio?: number;
  totalInputCacheRatio?: number;
  measurement: 'provider' | 'server' | 'token_comparison' | 'unknown';
  cacheState: 'cold' | 'warm' | 'evicted' | 'unsupported' | 'unknown';
  rolloverReason?: string;
  predictedColdPrefillMs?: number;
  observedPrefillMs?: number;
}
export interface MediaSelectionReceipt {
  selectionId: string;
  sourceId: string;
  artifactId: string;
  requestedModality: Modality | 'document';
  deliveredModality: Modality | 'document' | 'none';
  hydration: 'native' | 'text_fallback' | 'unavailable';
  mimeType: string;
  wireBytes: number;
  inputTokens: number;
  estimateKind: EstimateKind;
  adapterVersion: string;
  coverage: Array<{ pages?: [number, number]; timeMs?: [number, number]; regionId?: string }>;
  omittedCoverage: Array<{ reason: string; pages?: [number, number]; timeMs?: [number, number] }>;
  fidelityWarning?: string;
}
export interface ContextForgePlanReceipt {
  version: 1;
  receiptId: string;
  sessionId: string;
  admissionId: string;
  attempt: number;
  createdAt: number;
  engineId: 'contextforge';
  pluginId: 'contextforge-native';
  engineVersion: string;
  plannerVersion: string;
  rendererVersion: string;
  modelFingerprint: string;
  capabilityEnvelope: CapabilityEnvelope;
  namespaceGeneration: Record<string, number>;
  scopePolicySha256: string;
  authorizedInputManifestSha256: string;
  querySha256: string;
  demand: { primary: DemandClass; secondary: DemandClass[];
    signals: string[]; initialDesiredInputTokens: number; obligations: DemandObligation[] };
  profile: { promptMode: 'passthrough' | 'hybrid-stable' | 'slim-domain';
    requestedTools: string[] | null; effectiveTools: string[];
    systemReplacementVerified: boolean; hostCompatibility: string };
  selections: SelectionItem[];
  stages: ExpansionStage[];
  coldStorage: ColdStorageReceipt;
  media: MediaSelectionReceipt[];
  tokens: TokenBreakdown;
  cache: CacheReceipt;
  disposition: 'admitted' | 'partial' | 'blocked' | 'cancelled' | 'degraded';
  stopReason: 'sufficient_evidence' | 'corpus_exhausted' | 'physical_limit'
    | 'transport_limit' | 'modality_unavailable' | 'mandatory_overflow'
    | 'retrieval_deadline' | 'cancelled' | 'host_incompatible' | 'store_error';
  warnings: string[];
  compilerLagSourceIds: string[];
  exactWireManifestSha256?: string; // canonical logical wire content, no expiring credentials
  receiptSha256: string;
}

export type MemoryStatus = 'active' | 'superseded' | 'withdrawn';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SourceRole = 'user' | 'assistant' | 'tool' | 'toolResult' | 'system' | 'developer';
export type SourceKind = 'turn' | 'document' | 'media' | 'tool_result' | 'external_snapshot' | 'policy';
export type TrustClass = 'owner_instruction' | 'user_statement' | 'assistant_output' | 'tool_output' | 'external_untrusted';
export interface ContextForgeConfig {
  dbPath: string;
  blobRoot?: string;
  ownerId?: string;
  namespaceId?: string;
  scopeKind?: 'personal' | 'agent' | 'project' | 'session' | 'shared';
  scopeKey?: string;
}
export interface SourceRecord {
  sourceId: string; namespaceId: string; sessionId: string | null; kind: SourceKind;
  originSystem: string; originKey: string; originRevision: string; role: SourceRole | null;
  trustClass: TrustClass; observedAt: number; ingestedAt: number; contentSha256: string;
  metadata: JsonValue; status: MemoryStatus;
}
export type ArtifactKind = 'raw' | 'text' | 'ocr' | 'transcript' | 'caption' | 'thumbnail' | 'page_image' | 'audio_segment' | 'video_clip' | 'keyframe' | 'normalized_message';
export interface ArtifactRecord {
  artifactId: string; sourceId: string; kind: ArtifactKind; blobSha256: string; mimeType: string;
  textContent: string | null; producer: string; producerVersion: string; configSha256: string;
  fidelity: 'exact' | 'deterministic_transform' | 'lossy' | 'machine_inferred' | 'human_annotated';
  observedAt: number; metadata: JsonValue;
}
export interface DerivedNodeRecord {
  nodeId: string; namespaceId: string; layer: 1 | 2 | 3; logicalKey: string; revision: number;
  kind: string; title: string; body: string; canonical: JsonValue; compilerVersion: string;
  contentSha256: string; createdAt: number; observedAt: number; status: MemoryStatus;
  validFrom: number | null; validTo: number | null; supersededBy: string | null;
}
export interface FactRecord extends DerivedNodeRecord {
  entityId: string | null; predicate: string; object: JsonValue; polarity: -1 | 1;
  assertionKind: 'explicit' | 'parsed_measurement' | 'derived_calculation' | 'unresolved_candidate';
  unit: string | null; stateKey: string | null; authority: string; confidence: number | null;
}
export interface ProvenanceRecord {
  nodeId: string; sourceId: string; spanId: string; artifactId: string;
  relation: 'supports' | 'contradicts' | 'withdraws' | 'supersedes' | 'instructs';
  extractionRule: string; observedAt: number; byteStart: number | null; byteEnd: number | null;
}
export interface EpochRecord {
  epochId: string; sessionId: string; scopeFingerprint: string; modelFingerprint: string;
  policySha256: string; toolsSha256: string; prefixSha256: string; prefixBlobSha256: string;
  generation: number; state: 'active' | 'retired'; createdAt: number; retiredAt: number | null; reason: string;
}
export interface SymbolicIrOptions {
  namespaceId?: string; includeProvenance?: boolean; includeHistory?: boolean;
  layers?: Array<1 | 2 | 3>; entityKeys?: string[]; observedFrom?: number; observedTo?: number;
}
export interface AcceptedMessage {
  id?: string; role: SourceRole; content: JsonValue; observedAt?: number;
  toolCallId?: string; protocolGroupId?: string; [key: string]: JsonValue | undefined;
}
export interface IngestSourceInput {
  namespaceId?: string; sessionId?: string; kind?: SourceKind; originSystem?: string;
  originKey: string; originRevision?: string; role?: SourceRole; trustClass?: TrustClass;
  observedAt?: number; bytes?: Uint8Array; text?: string; mimeType?: string; metadata?: JsonValue;
}
export interface BlobRecord { sha256: string; byteLength: number; storageKind: 'inline' | 'cas'; relativePath: string | null }
export interface SearchOptions {
  namespaceId?: string; limit?: number; offset?: number; includeHistory?: boolean;
  observedFrom?: number; observedTo?: number; asKnownAt?: number;
}
export interface SearchResult {
  namespaceId: string; sourceId: string | null; nodeId: string | null; chunkId: string | null;
  title: string; body: string; score: number;
}
export interface PublishNodeInput {
  namespaceId: string; layer: 1 | 2 | 3; logicalKey: string; kind: string; title: string;
  body: string; canonical: JsonValue; compilerVersion: string; observedAt: number;
  spanIds: string[]; dependencyNodeIds?: string[]; extractionRule: string;
  validFrom?: number; validTo?: number; replace?: boolean;
}
