# ContextForge v2 — Elastic Context Planner and KV-Cache Epochs

**Status:** review-ready design, not a verified performance claim. **Date:** 2026-10-25. **Package ID:** `contextforge-native`. **Registered engine ID:** `contextforge`. **Storage contract:** [02 — SQLite and multimodal](02-SQLITE-STORAGE-AND-MULTIMODAL-SCHEMA.md).

## 1. Non-negotiable behavior and honest limits

The planner builds the model's working context afresh from exact recent conversation, scoped permanent rules, compiled routing records and relevant original evidence. Routine turns should often fit roughly 1,500–3,500 input tokens, **when mandatory policy, tools and current input permit**. Complex requests expand smoothly through tens or hundreds of thousands of tokens to the model/deployment's real usable window. There is no `maxRecallTokens=8000`, `maxSourceTokens=20000`, fixed top-K, fixed media-count product cap, or 100k ceiling masquerading as safety.

“No hard cap” means **no artificial context-policy ceiling**. Models, provider request bodies, configured local KV allocation, output reserves, transport media limits and memory are physical admission constraints and cannot be ignored. A 900k native window is not 900k available evidence tokens once output, system and pending content are reserved. `model.input` and actual provider capabilities must be discovered; model names in examples do not prove a 32k/64k/900k configuration or native audio/video support.

“No compaction” means no recurring blocking history-summary pass is necessary in ContextForge's supported route. It does not mean no retrieval, no storage maintenance, no errors, infinite context, zero cold prefill or perfect semantic recall. `ownsCompaction: true` and an immediate no-op `compact` eliminate the engine's summary operation, but host fallback/unsupported harnesses may still follow legacy behavior. The integration must detect those cases, not advertise guarantees it no longer controls.

## 2. Installed-host integration contract

Baseline evidence: `/app/docs/concepts/context-engine.md` and `/app/docs/plugins/hooks/prompt-and-session.md`, installed OpenClaw `2026.10.4`, inspected 2026-10-25. Bind implementation types to the actual SDK, with contract tests; the internal interfaces below are **not invented host signatures**.

Register `api.registerContextEngine('contextforge', factory)` from plugin `contextforge-native`; select `plugins.slots.contextEngine = 'contextforge'`, keep `plugins.slots.memory = 'memory-core'`. If package-owner selection differs in a host version, resolve it through a tested SDK adapter and show the final active engine ID; do not inconsistently use plugin and engine IDs.

Required engine declarations:

```ts
const info = {
  id: 'contextforge',
  name: 'ContextForge Native',
  ownsCompaction: true,
  acceptedHostParams: ['sessionKey', 'prompt', 'runtimeSettings', 'sessionTarget', 'runtimeContext', 'abortSignal'],
  transcriptSemantics: {
    currentTurnFence: 'before-current-turn-entry-v1',
    turnAdvancementIdempotency: 'atomic-idempotent-v1',
  },
  turnMaintenanceMode: 'background',
} as const;
// Implement the real SDK's ingest/assemble/commitTurn/maintain signatures.
// compact(): Promise<CompactResult> immediately returns:
const noCompaction = { ok: true, compacted: false };
```

On this host, the full fence/idempotency declaration and atomic `commitTurn` are necessary to keep the entire admitted turn on the selected engine. Without them, the host degrades the logical turn to legacy. A before-current-turn `assemble` sees prior history; the host appends pending user/tool messages and supplies a budget reserving their space. Consequently:
- Return only the selected **historical** projection, not a duplicate current user message/tool result.
- Use the hook's explicit `currentUserMessage` when present to classify demand; an explicit empty string is a legitimate image-only input, not a cue to parse stale history. Persist no fake admission identity from text hashes. Use host admission/run correlation and an attempt-scoped `RunPlan`.
- Inspect the exact SDK budget semantics for system/tools/output already accounted for. Normalize once into the envelope below; subtract every component **exactly once**. The host's numeric `tokenBudget` is an authoritative constraint, not a synonym for model native context capacity.
- Pending tool exchanges remain host-owned until accepted; historical tool groups are indivisible or rendered as quoted evidence. No orphan results/calls or forged assistant/tool history.
- Return `{messages, estimatedTokens, promptAuthority:'assembled'}` using installed SDK types. Do not request `preassembly_may_overflow`, which restores checks against the unwindowed archive. If `systemPromptAddition` is needed for memory-core's prepared guidance, use its real SDK helper and count it; do not inject the same L3/rules twice.

`before_prompt_build` replaces/slims the system prompt and narrows tools; `assemble` owns the history array. These are independent interception surfaces. Hooks receive detached snapshots, so mutating hook messages does not change the model history. First defined `systemPrompt` wins among hooks; tool restrictions intersect. A startup/runtime check must verify the winning prompt and final tool set, not assume hook registration is sufficient.

The hook and engine share an attempt-scoped planning coordinator, never a process-global mutable `lastPlan`. The coordinator holds authorized scope, actual provider/model envelope, policy/tool profile, admission key, immutable source-generation vector and reservations. Call ordering differs by harness: integration tests establish where system/tool preparation and assembly occur. If history assembly runs before final tools are known, reserve the full allowed catalog pessimistically and re-admit using final wire serialization. Do not rely on an undocumented hook ordering. Rebuilds are idempotent within one admission; a new attempt gets a new receipt.

## 3. Envelope and accounting

Normalize model/harness information to:

```ts
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
```

All integer token values must be finite, nonnegative and safe integers. Unknown native capacity is a **configuration error**, not permission to guess 900k. Distinguish context window, max output and provider max input. For a local server, inspect deployed context allocation per slot, not merely GGUF metadata. Reserve reasoning according to the provider's actual billing/context semantics; do not reserve it twice with completion output.

Let:
- `W = min(nativeContextTokens, deploymentContextTokens)`.
- `O = outputReserveTokens + reasoningReserveTokens` (non-overlapping).
- `F = systemTokens + toolSchemaTokens + framingTokens`.
- `P = pendingInputTokens` and `U = safetyMarginTokens`.
- `Rphysical = max(0, min(W - O, providerMaxInputTokens ?? Infinity) - F - P - U)`.
- `Rhost = max(0, hostTokenBudget - sum(reservations NOT already excluded from it))`.
- **`H = min(Rphysical, Rhost)`**: admissible historical projection, including pinned L3 if not in `F`.

If mandatory material exceeds physical input, return `MandatoryInputOverflow` with component breakdown and supported choices (larger configured model, smaller attachment scope, smaller requested output, or task-level multiple passes). Do not delete the current request, user constraints or required safety instructions. A numeric host budget with unknown scope blocks strict admission; fail clearly or use a verified host compatibility adapter, not invented arithmetic.

Budget every serialized token: actual system text, schema framing, role delimiters, selected text, L0 citations, L1/L2 tables, L3 rules, native media tokens, provider wrappers, current pending input and reserved output. Attach a single owning layer to each text segment; a citation included in a passage belongs to that passage's layer, preventing double counting. Media costs are separately charged whether the owning source is L0. External image tokens can depend on resolution/tiles; audio/video charges depend on provider duration/frame/token rules, not base64 string length. Wire byte limits include base64 expansion independently of token costs.

Use model tokenizer + real chat template where available. Otherwise use provider token-count APIs or conservatively calibrated upper bounds. A byte/character heuristic is explicitly labeled, margin-adjusted and checked against observed provider usage. After hydration, recompute actual rendered costs and re-admit. On provider overflow, invalidate the estimator and rebuild with a measured envelope correction; never compact. A bounded retry policy reports `admission_failed` after repeated mismatch. The planner is not allowed to call an LLM secretly to summarize overflow.

## 4. Query demand and obligations

Classification is deterministic and multi-signal. The class is a routing hint, not a cap:

| Primary class | Signals | Initial desired total input (illustrative) | Required evidence behavior |
|---|---|---:|---|
| `conversational` | greeting, simple follow-up, explicitly structured log, low entity breadth | 1.5k–3.5k | exact relevant active state, safety/constraints, enough tail to resolve referents |
| `analytical` | compare, explain causality, arithmetic, decisions, contradictions, multiple entities/time periods | 4k–16k | facts + supporting L0 + contrary evidence; formulas and source precision |
| `heavy_rag` | explicit docs/files/pages/codebase, exhaustive synthesis, broad source count, deep citation graph | 8k–32k, then elastic growth | enumerate requested source set, exact spans, coverage manifest, complete dependency sections |
| `multimodal_inspection` | attached/referenced visual/audio/video detail, chart/layout/acoustics/motion | modality-specific, not a fixed textual budget | supported native evidence or explicit unavailable capability; pages/time/region coverage |

Signals include current native attachment metadata, explicit IDs/paths/pages/time ranges, lexical operation patterns, entity count, unresolved prior-task state, requested thoroughness and estimated source bytes. “Thanks” following 150k RAG does not inherit heavy demand. An image-only turn does not become conversational because the text is empty. A simple question can escalate to heavy RAG when evidence is dispersed; a huge corpus does not justify loading it all for an unrelated greeting.

Compile a **demand graph** of obligations: explicit sources, entities, temporal intervals, comparisons, calculations, contradictions, citation fidelity and modality/coverage requirements. Deterministic parsing is conservative: ambiguity becomes an unresolved obligation, not a false certainty score. Coverage is a structural measure (sources/pages/constraints represented), not a proof that the model will reason correctly. For “all documents,” enumerate the actual authorized source inventory first; unknown inventory completeness must be reported.

Candidate ranking uses stable versioned weights and tie-breaking IDs. Inputs include explicit reference match, FTS BM25, entity/time match, source trust, currentness, contradiction relevance, graph adjacency, novelty and token/transport cost. Formula:

`utility(bundle) = obligationGain + relevance + authority + temporalFit + contradictionGain + continuity - redundancy - fidelityLoss`

Selection units are **bundles**: fact plus support spans; table plus header/units; code symbol plus necessary definitions; image plus caption/citation; complete historical protocol group. Parent/neighbor expansion handles context dependencies. Resolve authorization before scoring. No confidence score can override a required explicit source, a negative constraint or a known contradiction. Permanent data does not belong in a system role merely because it was retrieved.

## 5. Elastic staged expansion algorithm

The 25% → 50% → 75% → 100% ladder applies to the **current demand tranche**, not the whole native window. Starting every local greeting at 25% of 64k (16k) would defeat the requirement. Conversely 100% of an initial 8k tranche is not a final ceiling.

1. Establish authorized scope, policy, capability envelope and exact pending-input reservation. Choose stable tool/prompt profile for this admission.
2. Load mandatory pinned rules and minimum continuity tail using deterministic dependency closure. Tail length is demand-driven: include latest accepted exchange and unresolved referents/tool state, not a fixed N-message truncation. If these cannot fit, report overflow.
3. Build obligations and cheap L2/FTS/entity/time candidates from an immutable snapshot. Always retain access to raw L0 even if compiler jobs lag.
4. Compute initial optional-history tranche `Q0` from initial class demand minus already-counted fixed/pending/mandatory tokens, bounded below by the smallest relevant bundle and above by remaining `H`. This is a **target**, not a limit configuration.
5. Within a tranche `Q`, consider optional spend at `.25Q`, `.50Q`, `.75Q`, `Q`, rounding up and including mandatory material at every stage. Add indivisible bundles when the next stage admits them; if one required bundle itself exceeds `Q`, enlarge the tranche directly to its cost when physical room exists.
6. At each stage retrieve more candidates as necessary, expand source/provenance/graph dependencies, resolve conflicts, estimate media renditions, deduplicate source overlaps, select and measure coverage/marginal gain. Stop only when obligations are satisfied and additional evidence has low measured utility, not because a class's initial range ended.
7. If `Q` is exhausted but demand remains and room exists, set `Qnext = min(remainingCapacity, max(2Q, predictedUncoveredEvidenceCost + currentOptionalCost, requiredLargestBundleCost))` and repeat. Heavy RAG may jump from 32k to 128k/256k/512k or the entire usable envelope. Growth need not be powers of two when inventory cost is known.
8. Stop at sufficient evidence, corpus exhausted, true physical limit, cancellation, or explicit retrieval-work deadline. A deadline leaves an `incomplete` receipt/continuation, never a false “all evidence loaded” success. Work batch sizes are scheduler mechanics, not total-recall caps.
9. Hydrate selected media, validate final message protocol and exact serialization cost, revalidate revocation/status and perform final admission. Shrink only *optional* material if estimates changed; required unsupported material yields an explicit blocked/partial plan.
10. Emit immutable receipt, return historical messages and estimate. Host-owned pending content is appended once. Accepted-turn commit persists source and compiler jobs after completion. The next admission selects anew and need not retain heavy-turn bulk.

Reference pseudocode (internal domain functions, not SDK exports):

```text
plan = prepare(request, envelope, authorizedSnapshot)
mandatory = selectMandatoryClosure(plan)
assertFitsOrExplain(mandatory, plan.historyCapacity)
Q = initialTranche(plan)
selected = mandatory
while true:
  for fraction in [0.25, 0.50, 0.75, 1.0]:
    allowance = mandatory.cost + ceil(Q * fraction)
    candidates = retrieveMoreUntilUsefulOrExhausted(plan, allowance)
    bundles = closeDependenciesAndDeduplicate(candidates, plan)
    selected = deterministicSelect(mandatory, bundles, allowance)
    recordStage(plan, selected, fraction, Q)
    if obligationsSatisfied(plan, selected) and lowMarginalGain(plan):
      return hydrateValidateAdmit(plan, selected)
    if cancelledOrDeadline(plan): return explicitIncomplete(plan, selected)
  if corpusExhausted(plan): return explicitCoverageResult(plan, selected)
  if mandatory.cost + Q == plan.historyCapacity:
    return explicitPhysicalLimitResult(plan, selected)
  Q = expandedTranche(plan, Q)
```

Selection is not strictly monotone inside a stage: a more compact higher-fidelity bundle may replace redundant fragments. Required coverage may not regress. Record additions **and removals**. Broad retrieval must paginate beyond preliminary top-K; if the compiler or index misses a specified source, direct L0 lookup takes priority. Full-source inventory and chunk counts support measurable exhaustive coverage.

### Worked envelope examples (illustrative, not benchmarks)

- **Routine local chat:** 64k deployed window, history allowance 58k after exact reservations; actual fixed/pending input 1.2k, relevant tail/state 1k, result 2.2k. Unused 55k+ is not filled.
- **Local 32k model, 150k relevant document:** reserve 4k output and 2k fixed/pending/uncertainty, leaving 26k historical capacity. A 150k mandatory exhaustive request cannot fit. Report coverage and offer authorized multi-pass/larger-model execution; do not label 26k selected excerpts exhaustive.
- **Cloud heavy synthesis:** 256k window, 12k output reserve, 5k fixed/pending/uncertainty → 239k historical capacity (assuming host agrees). 8k→16k→32k→64k→128k→190k evidence demand reaches 190k and stops, without a 100k cap.
- **Very large cloud window:** 950k deployment, 32k output, 12k fixed/pending/uncertainty → 906k capacity. A 780k authorized corpus may be fully selected if transport and model constraints permit. 950k metadata alone does not establish that the API route supports this request.
- **Video inspection:** a short relevant interval may be 3k text plus 18k media-token equivalents; another task may require the whole video and 200k+. Account for duration/request limits separately; do not equate video bytes with tokens.

## 6. System prompt slimming and tool profiles

`before_prompt_build` returns `systemPrompt` and optionally `toolsAllow`. The prompt compiler must preserve all applicable higher-priority safety, privacy, authorization, execution, user and workspace requirements. “Slim” is not permission to delete required policy or turn retrieved text into instructions. Do not summarize mandatory policy lossily with an LLM. Use a versioned manifest of required sections and deterministic omission of genuinely inapplicable boilerplate, redundant explanations, giant catalogs and duplicated memory. If the host cannot identify policy ownership sufficiently to produce a faithful replacement, use passthrough/hybrid mode and report that the 2k target is infeasible.

Profiles:
- **passthrough:** no replacement; ContextForge still selects history. Safest compatibility baseline.
- **hybrid-stable:** preserve mandatory host policy, stable scoped L3 and concise capability-discovery guidance; move turn metadata/retrieved evidence outside stable instructions when the host allows it.
- **slim-domain:** explicit dedicated-scope opt-in, with a verified minimal policy manifest and approved capability profile. Never infer a domain-only session merely from the active local model's name.

Tools are a stable, minimal **task capability profile**, not a per-word allowlist. Candidates might include `conversation`, `memory`, `documents`, `code` and `multimodal`. Actual concrete IDs come from the host-resolved authorized tool registry. Required memory instructions that mandate `memory_search` must retain that tool. Keep discovery/expansion paths only where they are authorized and compatible with host policy. `toolsAllow` is solely an intersection/narrowing; it cannot grant blocked tools or bypass post-policy authority. An empty array disables optional tools, so use it only for a genuinely tool-free admission. If a needed capability becomes apparent mid-turn but the tool set is locked, request a host-supported replan/new admission rather than claiming an unavailable tool.

Ordinary prompt hooks choose system/tools. Authorized post-policy enrichment (`requiresToolAuthority:true`) checks the current capability before tool-backed recall and may return only context additions; it cannot change system/tools after policy settlement. Namespace ACL authorization applies even when retrieval is internal rather than tool-backed. The ephemeral host authority capability is not durable authorization; never persist/reuse its fingerprint as a permission grant.

The embedded and Copilot runtimes support turn-scoped narrowing in the inspected docs; Codex app-server rejects restrictive `toolsAllow` because tools are thread-scoped. Declare it unsupported for strict slim-tool mode, or use a verified fixed thread profile; do not silently ignore the restriction. Other plugins may win system replacement or intersect tools more tightly. Validate the **final serialized request** and expose effective profile/compatibility state in receipts.

A skills catalog may be replaced by concise discovery instructions only if the host's required skill-use behavior remains reachable and correct. Stable tool schemas are serialized in canonical order; no random ordering, generated timestamps or changing descriptions. Tool schema costs are measured; a 1k system plus 12k tools is a 13k fixed prefix, not a 1k prompt.

## 7. KV-cache prefix locking: Epoch architecture

### 7.1 What an epoch freezes

An epoch is an immutable rendered prefix and compatibility key, **not a rewritten transcript** and not model fine-tuning. It freezes:
- provider/model revision, tokenizer, chat template, adapter and relevant generation/request-mode configuration;
- namespace/tenant/access-scope partition, policy versions and selected stable L3 revisions;
- exact system bytes, canonical tool schema bytes and provider-supported cache-breakpoint placement;
- optional stable project/source evidence bundle selected for repeated use.

`epochId = SHA256(canonical({version, scope, modelFingerprint, policyHashes, toolSchemasHash, stableEvidenceManifest, rendererVersion}))` plus a storage identity if separate creations share a semantic hash. The DB stores canonical prefix bytes/content-addressed blob, manifest hash, source generations, creation/retirement reasons and audit linkage. Store only public cache-key material; API credentials and ephemeral authority tokens are excluded.

Conceptual wire layout (provider ordering must be verified):

```text
[provider framing + stable tool schemas]
[stable mandatory system + approved L3 domain rules]
[optional stable, source-backed project evidence anchor]
---------------- epoch / supported cache breakpoint ----------------
[current selected L2/L1/L0 evidence + contradictions + provenance]
[recent verbatim historical protocol groups]
[host-owned pending user/tool exchange, appended once]
```

Stable retrieved evidence remains labeled data at its correct message authority; it is not promoted into system policy. Some providers place tools before system, others transform messages; measure the longest common prefix of **actual tokenized wire requests**, not concatenated application strings. Host-added timestamps/runtime context before the stable prefix can invalidate it; inspect/move permitted dynamic sections or report the limitation. Byte-identical app text with a changed model/chat template does not share KV state.

### 7.2 The 90% target is conditional, not magic

For a simplified prompt containing `S` reusable-prefix tokens and `D` changed-suffix tokens, maximum ordinary prefix cache hit ratio is roughly `S/(S+D)` after warmup, assuming cache residency and provider support. A 1,000-token stable prefix plus 1,500 changed tokens yields **40%**, not >90%. Achieving >90% of *total prompt* requires `S > 9D` or additional reusable continuation beyond the static prefix. Do **not** pad prompts with 15k irrelevant instructions merely to inflate cache-hit percentage; that contradicts the surgical-context goal.

Therefore report three different metrics:
1. **Stable-prefix reuse ratio:** cached eligible stable-prefix tokens / eligible stable-prefix tokens. Target >90% on compatible warm turns.
2. **Total-input cache ratio:** provider-reported cached input tokens / total input tokens. Target >90% only for workloads with a large unchanged anchor or append-only warm continuation.
3. **User performance:** prefill milliseconds, time to first token, total latency, uncached input tokens, quality/coverage and resident KV memory. These determine success when dynamic work dominates.

Cloud minimum cacheable token thresholds, block rounding, TTL, explicit caching charges, load balancing and routing can make short 2k prompts partly or entirely uncacheable. llama.cpp server scheduling, prompt-cache settings, template changes and model reloads can do the same. No plugin can guarantee >90% total-input cache hits on arbitrary unrelated turns or first-time 200k RAG. The design optimizes cache reuse **subject to relevance and correctness**, not the reverse.

### 7.3 Two execution modes

**Surgical mode (default):** keep only compact stable policy/L3, then rebuild the dynamic evidence/tail. This maximizes focus and lowers uncached token count even if total cache percentage is modest. A heavy turn can drop back to a 2k routine turn immediately, with no archive mutation or summarization.

**Anchored burst mode:** for repeated work on the same document/codebase, freeze a relevant stable source bundle at the start of an epoch and append a short accepted conversational continuation *only while it remains useful*. If the actual next wire request is an exact token prefix extension of the previous prompt+accepted output, a compatible backend may reuse much more than policy tokens. No host compaction is needed: when tail bulk, topic, scope or currentness changes, start a new smaller epoch from the store. Reusing a heavy anchor for an unrelated greeting is forbidden just to preserve cache percentage.

Neither mode assumes that provider generation output is automatically cached for the next request; adapter/backend tests establish that behavior. A tool-schema profile change may invalidate a prefix before the system prompt even begins. Schedule planned profile changes at admission boundaries. Security revocations and corrected permanent rules rotate immediately regardless of cache loss; routine unrelated L1 writes do not rotate an unaffected prefix.

### 7.4 llama.cpp deployment specifics

`--parallel 1` simplifies same-slot serial reuse but is **not** a cache-hit guarantee or a plugin-managed setting. This spec makes no server config changes. Verify deployed model, actual slot context allocation, prompt-cache support/settings, GPU offload, chat template, media projector and tokenizer. Use sticky routing to the same warmed server; serialize requests per slot if required. Other sessions using the same slot can evict the prefix even with `--parallel 1`. Do not mix private tenant prefixes or reuse a persisted slot across trust boundaries without tested isolation.

Measure local cache reuse using actual server timing/token counters or instrumented token-prefix comparison where available. Record unavailable counters as `unknown`, not 100%. The first epoch request always pays cold prefill; a 200k changed suffix remains expensive. Offloading or saving KV cache is a backend capability with privacy/memory implications, not something `DatabaseSync` stores. SQLite holds text/assets/manifests, not opaque model KV tensors.

### 7.5 Cloud and persistent-thread specifics

Use provider-supported explicit cache breakpoints/handles only via a verified provider adapter. Standard implicit caches require stable byte/token order and often routing/account affinity. A cache is an optimization with expiring residency, not authoritative memory; a cache miss must reconstruct the same correct request.

OpenClaw's `contextProjection:{mode:'thread_bootstrap',epoch}` is for persistent backend threads and is **not synonymous with ordinary KV prefix caching**. This planner omits it for normal per-turn projection. A persistent-thread adapter requires separate proof that epoch rollover removes unwanted historical context and invalidates tools/policy correctly. Otherwise the backend can retain the very transcript accumulation the native engine is intended to eliminate.

### 7.6 Rollover policy

Rotate on model/template/provider change, policy/tool-profile change, scope/ACL change, referenced-source correction/withdrawal, changed stable L3, task boundary or measured anchor irrelevance. Record old/new hashes and reason. For performance-driven rotation, compare predicted saved future uncached tokens against one cold prefix cost using observed data; correctness-triggered rotation is unconditional. Rollover performs no LLM call, writes only metadata and reconstructs the selected prefix from authoritative records. Time/date/current task progress stays in the dynamic suffix unless policy requires otherwise.

## 8. Exact planner receipt interfaces

These are versioned internal TypeScript contracts. IDs/hashes are validated opaque strings at boundaries. All costs are integer tokens except utility scores and milliseconds; receipts use canonical JSON and a domain-separated SHA-256. The stored JSON is an audit artifact with the same ACL as its sources; client-facing receipts are redacted to the caller's scope.

```ts
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
```

`historicalTextByLayer.L3` excludes L3 already included in `systemPolicy`; every rendered byte has one token owner. `selectedHistory` includes historical framing/media but excludes host pending messages and separately counted fixed system/tool framing. `admissibleHistory` uses the normalized host envelope. A provider usage observation arriving after dispatch is a linked immutable observation receipt or new revision, not a silent rewrite of the original planning evidence.

Excluded candidates can number millions: persist a content-addressed manifest in the authorized store and a compact representative list, not a million IDs inside the model prompt or receipt row. Distinguish explicitly considered/excluded items from the unvisited archive; a planner cannot honestly enumerate why every unsearched item was irrelevant. Unauthorized data is absent entirely, not listed under `denied` with revealing titles or counts. Receipts are never injected wholesale into the prompt; the model receives only needed citations, coverage caveats and constraints.

Deterministic reproducibility uses input/snapshot/model/renderer/planner hashes plus fixed ranking weights and stable ID tie-breaks. Exclude receipt ID, wall-clock timings, createdAt, observed cache counters and provider handles from the semantic plan hash; include selected content, source lifecycle, obligation coverage, budget math and disposition. JSON validators reject NaN/Infinity, malformed hashes, negative tokens and inconsistent totals.

## 9. Validation, failure handling and rollout gates

### Correctness and elastic behavior

- Freeze fixtures spanning a 2k routine chat, ambiguous anaphora, arithmetic with negative constraints, adversarial contradictory sources, exhaustive 100k/200k/780k RAG, code dependency graphs and image/audio/video/PDF requests. Relevant evidence must survive selection; irrelevant heavy previous evidence must leave the next simple turn.
- Property-test monotone capacity: increasing the envelope cannot make a required feasible bundle impossible; lower-demand turns may legitimately select fewer tokens. No stage-class ceiling blocks reaching the physical envelope. Generate corpora beyond preliminary retrieval batch sizes to detect hidden top-K caps.
- Verify all mandatory current messages and host-appended pending tools appear **exactly once**. Atomic historical protocol groups remain valid. Accepted-turn commit, retry, abort, compiler lag and bootstrap use the ordinary host route.
- Wire-level admission tests include system, schema changes, role framing, images at multiple resolutions, audio/video duration, PDF rendering and output reasoning semantics. Provider overflows result in re-admission/error, never summary compaction.
- Correction/withdrawal and ACL revocation invalidate selected/pinned evidence before dispatch. Fuzz malicious source instructions to ensure no promotion into system policy or unauthorized tool permission.

### Cache/performance benchmarks

Run separate cold/warm tests on actual llama.cpp `--parallel 1` and supported cloud routes. Record server/provider versions, model/context configuration, tokenizer/template hash, workload, eligible cache tokens, cached total tokens, uncached tokens, p50/p95 prefill and TTFT, peak RAM/KV memory and source coverage. Compare:
1. legacy replay baseline;
2. surgical context without deliberate cache locking;
3. surgical mode with epoch locking;
4. anchored burst mode with repeated relevant document work;
5. topic/tool/model/profile switch and cache eviction.

Acceptance: no invoked LLM compaction on the verified ContextForge route; every emitted request satisfies physical accounting; routine fixtures meet their demand-appropriate small context target; heavy fixtures can exceed 100k whenever supported. >90% stable-prefix reuse is a target for warm compatible runs, and >90% **total** cache ratio is separately demonstrated only on suitable anchored/append-only workloads. Do not conflate input-cache discount, actual KV reuse and simulated longest-prefix potential. No asserted 1–2s latency or >90% cache success without measurements.

### Failure states

Typed failures include `HostContractUnsupported`, `BudgetSemanticsUnknown`, `MandatoryInputOverflow`, `ModalityUnavailable`, `TransportLimit`, `SourceRevoked`, `BlobUnavailable`, `CompilerLag`, `RetrievalIncomplete` and `StoreCorrupt`. Partial assembly must carry unresolved obligations and an explicit model-facing coverage notice. When a request explicitly requires all evidence, do not convert a blocked plan into a confident partial answer. Offer a larger supported envelope or authorized task-level multi-pass plan.

`compact()` is an immediate no-op and must be idempotent even under explicit host calls. UI spinner behavior remains a host integration assertion: verify the normal route does not enter compaction retries, and test a manual `/compact` request. Unsupported hosts or turn-local legacy degradation are surfaced in status/receipts; fail closed for users demanding strict native mode rather than silently replaying an enormous transcript.

### Implementation and rollback sequence

1. Build the SDK compatibility/admission adapter and wire capture tests before performance tuning.
2. Implement conservative planner with L0/FTS/typed L1-L3 and receipts; pass deterministic/fence/security tests with passthrough prompt.
3. Add verified hybrid/slim prompt manifests and stable authorized tool profiles; measure complete wire savings.
4. Add media capability adapters and full envelope accounting; no invented native content blocks.
5. Add cache epochs/anchored bursts only after a correct non-cache planner passes. Cache optimization cannot change evidentiary correctness.
6. Roll out opt-in per namespace/model, retaining host transcripts and reversible slot configuration. Rollback disables ContextForge's prompt hook and switches the context slot deliberately; it does not delete native L0 or rewrite memory-core/wiki.

Strongest dissent: deterministic retrieval may fail to surface important implicit connections, and cache anchoring may preserve stale or irrelevant context. Answer: retain exact L0 fallback and explicit uncertainty, test held-out natural-language queries, and make cache selection subordinate to demand/currentness. The architecture optimizes controlled admission and source-backed continuity; it does not claim deterministic extraction replaces general intelligence or that prefix caching eliminates the intrinsic cost of new evidence.

## 10. Specification verification record (2026-10-25)

All TypeScript fenced blocks in this document and document 02 were extracted and passed strict no-emit compilation with the installed TypeScript compiler. The storage DDL and FTS mechanics were executed successfully under built-in Node 24 SQLite; see document 02. No model/backend cache benchmark or native engine runtime has been implemented or measured by this specification-writing task. Therefore context-size examples, latency expectations and cache targets are explicitly design examples/acceptance criteria, not claimed results.
