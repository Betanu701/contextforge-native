# ContextForge v2 Native Engine (`contextforge-native`)
## 04 — Agent Tool Surface, Migration Plan, Verification Benchmarks & Build Roadmap

**Authors**: ContextForge contributors
**Date**: October 25, 2026
**Status**: Complete Design & Specification Kit (Awaiting the owner's Review)

---

## 1. Agent Tool Surface (`contextforge-native`)

While `contextEngine.assemble()` and `contextEngine.afterTurn()` operate **100% automatically on every turn** (so local and cloud models get proactive context assembly and ingestion without needing to call a tool first), the plugin also registers a clean, low-overhead tool suite for explicit memory management, heavy RAG ingestion, and deep inspection:

| Tool Name | Purpose | Key Input Parameters |
| :--- | :--- | :--- |
| **`cf_recall`** | Explicitly search across L2 Wiki pages, L1 Facts, and L0 Raw Sources/Media with custom filters or cross-namespace scope. | `query: string`, `layers?: ("L0"\|"L1"\|"L2")[]`, `categories?: string[]`, `modalities?: ("text"\|"image"\|"audio"\|"video"\|"document")[]`, `timeRange?: { after?: string, before?: string }`, `maxTokens?: number`, `hydrateMedia?: boolean`, `namespace?: string` |
| **`cf_remember`** | Explicitly store or update an L1 Atomic Fact, Decision, Constraint, Negative Fact, or Metric with immediate L2 Wiki compilation. | `statement: string`, `kind: "fact"\|"decision"\|"constraint"\|"negative_fact"\|"metric"\|"preference"`, `entities?: string[]`, `supersedesId?: string`, `validAt?: string`, `namespace?: string` |
| **`cf_permanent`** | Set, update, list, or remove **L3 Permanent Context** contracts/rules for a namespace or session (e.g., Health Journal coaching & scale-math rules) and optionally configure the namespace's `systemPromptMode` (`"slim-domain"`, `"hybrid-stable"`, `"passthrough"`). | `action: "set"\|"get"\|"list"\|"delete"`, `key: string`, `content?: string`, `priority?: number`, `systemPromptMode?: "slim-domain"\|"hybrid-stable"\|"passthrough"`, `toolsAllow?: string[]`, `namespace?: string` |
| **`cf_ingest`** | Ingest large files, directories, codebases, PDFs, images, audio transcripts, or video metadata into L0 storage + chunk graph + L2 Wiki compilation for 100k+ Heavy RAG. | `paths?: string[]`, `text?: string`, `title?: string`, `category?: string`, `modality?: "text"\|"document"\|"image"\|"audio"\|"video"`, `compileWiki?: boolean`, `namespace?: string` |
| **`cf_wiki_lint`** | Run deterministic structural and provenance integrity checks across the L2 Wiki & L1 Fact graph (orphan pages, missing `L0` source pointers, unresolved contradictions, stale epochs). | `namespace?: string`, `autoRepair?: boolean` |
| **`cf_status`** | Inspect live `contextforge.sqlite` database metrics, active session Epoch state, KV-cache hit alignment, and the most recent `ContextForgePlanReceipt`. | `sessionKey?: string`, `namespace?: string`, `includeLastReceipt?: boolean` |

### Automatic Envelope-Proportional Tool & Prompt Scaling (Zero Cloud/Local Hardcoding)
ContextForge v2 is 100% model-agnostic and plug-and-play for any OpenClaw user:
- It **never** checks whether a model is "local" or "cloud" or hardcodes model names.
- Instead, on every turn it reads the active model's live `CapabilityEnvelope` ($W = \min(\text{nativeContextTokens}, \text{deploymentContextTokens})$, output reserve $O$, input modalities, and `tokenBudget`).
- When the default system prompt + tool schemas ($F$) would consume more than `maxFixedOverheadRatio` (default **15%** of $W$, e.g., a 22k prompt on a 16k, 32k, or 64k context model), `before_prompt_build` automatically engages **`"adaptive-slim"`** mode—compressing the fixed prefix and deferring optional tool schemas behind OpenClaw's native `tool_search` so at least **85% of the model's context window** is preserved for actual conversation, reasoning, and RAG evidence.
- When $W$ is large (e.g., 200k–1M+ tokens, so $F$ is $<15\%$ of $W$), it leaves the full `STABLE` prefix and tool surface inline while still controlling 100% of the message history and elastic RAG assembly via `assemble()`.

---

## 2. How Any Workload Scales Automatically Under ContextForge v2

### Scenario A: Routine Conversational & Structured Tracking Turns (On Any 16k–64k or 1M Model)
1. **Zero-Config Plug-and-Play:**
   - Out of the box, any user who installs `contextforge-native` gets automatic L0 turn/document capture, deterministic L1 fact/metric/decision extraction, and L2 source-backed Wiki compilation (`entities`, `concepts`, `timeline`, `status`, `decisions`, `negative-facts`, `constraints`) scoped automatically by OpenClaw namespace (`agentId / userId / channelId / sessionKey`).
   - Optional domain rules or project contracts can be pinned at any time via `cf_permanent` (`L3`) or imported from existing workspace files.
2. **What Happens on a Conversational Turn:**
   - **Envelope Discovery:** Suppose the active model has $W = 32,768$ or $65,536$ tokens. Because OpenClaw's 22k default prompt exceeds $15\%$ of $W$, ContextForge automatically engages `"adaptive-slim"`, locking a clean ~1,200-token prefix in the KV cache.
   - **Elastic Assembly (`S0–S1`):** The planner sees `class = "conversational"` (or a bounded log update), loads L3 Permanent Context + relevant L2/L1 state + the minimum dependency-closed verbatim tail (**~1,800–3,200 tokens total**), and leaves the remaining 30k–60k window untouched so attention stays sharp and prefill is near-instant.

### Scenario B: Heavy RAG / 100k+ Multi-Document Synthesis / Codebase Analysis
1. **What Happens When You Ask a Deep Research or Multi-Document Question:**
   - Example: *"Compare all 16 personality and professional reports in `reports/` with my March/April reflections and synthesize every contradiction with exact citations"* or *"Analyze this 150-page architecture PDF and cross-reference it with our repo."*
   - **Elastic Demand Classifier:** Detects `intent = "heavy_rag"` (multi-source synthesis / high breadth) on a high-capacity model (`cloud-model-A`, `cloud-model-C`, or `cloud-model-B` with `tokenBudget = 922,000`).
   - **Staged Expansion Without Artificial Caps:**
     - Stage 1 loads the L2 Wiki index and entity/concept maps (~5k tokens).
     - Stage 2 follows provenance links to pull all matching L0 document chunks and full report sections—scaling dynamically to **80k, 150k, or 300k+ tokens** as needed so no evidence is truncated.
   - **Post-Turn Automatic Release (Zero Permanent Bloat):**
     - Once the turn completes and the synthesis is answered (and indexed into L1/L2), the 150k tokens of raw L0 RAG chunks are **not** permanently glued onto future conversational turns! The next turn immediately drops back to the clean working set without needing a compaction pass.

### Scenario C: Multimodal Inspection (Images, Audio, Video, PDFs)
1. **What Happens When You Send or Reference Media:**
   - When an image (e.g., nutrition label photo, whiteboard diagram, UI screenshot), audio note, video clip, or PDF is attached or referenced:
   - **L0 Media Registry (`artifacts`, `asset_metadata`, `blobs`):** Stores the content-addressed SHA-256 hash (`blobs`), local CAS/inline bytes, MIME type, dimensions/duration (`asset_metadata`), and extracted text/caption/transcript artifacts (`artifact_lineage` + `facts` / `derived_nodes`).
   - **Modality-Aware Hydration in `assemble()`:**
     - If both the active model (`input: ["text", "image", ...]`) and the OpenClaw provider adapter support native vision/audio/PDF content blocks, `assemble()` hydrates the actual native media content block into the historical projection when the query inspects visual/audio details.
     - If the active model is a text-only local model (`input: ["text"]`), `assemble()` automatically substitutes the high-density L1/L2 OCR/caption/transcript representation so the local model never crashes with a modality error!

---

## 3. Dissent & Risk Audit (Architecture Decision Review Step 5)

Before writing a single line of production code, here are the three real engineering risks we challenged during design and how the spec mitigates them:

1. **Risk 1: Over-aggressive `systemPrompt` replacement breaking OpenClaw native tools or subagent instructions.**
   - *Countermeasure:* We do **not** blindly nuke the system prompt on `main` orchestrator turns that need the full 50-tool catalog (`sessions_spawn`, `browser`, `computer`, `portal`, etc.). Instead, `systemPromptMode` defaults to `"hybrid-stable"` on `main` cloud turns (preserving OpenClaw's `STABLE` cache prefix and tool instructions while bounding the transcript via `assemble()`), and activates `"slim-domain"` automatically on **local `llamacpp` models** and **opted-in domain sessions** (like Health Journal).
2. **Risk 2: Synchronous SQLite blocking the Node.js event loop during bulk RAG ingestion.**
   - *Countermeasure:* While per-turn `assemble()` queries take `< 2ms` in `node:sqlite` (WAL mode + memory-mapped I/O), bulk file ingestion (`cf_ingest` on hundreds of files) chunks work across async event-loop yields (`setImmediate`) and runs heavy index maintenance inside `contextEngine.maintain()` with `turnMaintenanceMode: "background"` so chat replies are never delayed.
3. **Risk 3: Losing active tool-call chains when trimming the verbatim message tail.**
   - *Countermeasure:* OpenClaw's model providers require every `assistant` `toolCall` message to be paired with its corresponding `toolResult` message, and `transcriptSemantics.currentTurnFence = "before-current-turn-entry-v1"` requires preserving the current turn's active tool loop. Our `assemble()` slicer never splits an `assistant(toolCall) <-> toolResult` pair and always preserves 100% of messages from `prePromptMessageCount` onward during multi-step tool loops.

---

## 4. Parallel Implementation Plan & Milestones (implementation team + `cloud-model-B`)

Once you approve this Spec Kit, me (`cloud-model-A`) and `cloud-model-B` can execute the entire build in **4 bounded, verifiable milestones (~3 hours total)**:

| Milestone | Owner | Deliverable & Scope | Verification Gate |
| :--- | :--- | :--- | :--- |
| **M1: Native SQLite Core & L0–L3 Compiler** | `cloud-model-B` | `extensions/contextforge-native/src/db.ts`, `schema.ts`, `compiler.ts`, `media.ts`. Full `node:sqlite` WAL database, L0–L3 tables, FTS5 index, deterministic Wiki/Fact compiler, and multimodal asset registry. | Unit test suite (`vitest`): 100% lossless round-trip of L0 turns/docs/media, deterministic L1/L2 compilation in `<5ms`, cumulative scale & temporal supersession tests. |
| **M2: Elastic Context Planner, Dual-Channel Symbolic IR & KV-Cache Assembler** | `cloud-model-B` + implementation team | `extensions/contextforge-native/src/planner.ts`, `assembler.ts`, `prompt-controller.ts`, `symbolic-ir.ts`. Demand classifier (`conversational` vs `heavy_rag` vs `multimodal`), staged budget expansion (no hard cap, up to full `tokenBudget`), Dual-Channel Prompt Compiler (natural prose `SOUL.md` persona + `<compiled_rules_ir>` Symbolic DSL for operational rules, toggleable via `symbolicIr: boolean`), tool-pair-safe verbatim tail slicer, and Epoch KV-cache prefix locking. | Benchmark tests: verify `1.5k–3.5k` assembly on conversational turns, 50%+ token reduction on operational rules via Symbolic IR without persona degradation, `100k+` expansion on multi-doc RAG turns, tool-call chain integrity, and `>90%` prefix cache reuse. |
| **M3: OpenClaw Plugin Wiring & Agent Tools** | implementation team | `extensions/contextforge-native/openclaw.plugin.json`, `src/index.ts`, `src/tools.ts`. Registers `api.registerContextEngine("contextforge", ...)`, atomic `commitTurn()`, `before_prompt_build` prompt/tool slimmer, background `maintain()`, and the 6 `cf_*` tools. | Live plugin load via `plugins` tool; verify `plugins.slots.contextEngine = "contextforge"` coexists with `plugins.slots.memory = "memory-core"` without degrading to legacy. |
| **M4: Zero-Config Plug-and-Play Packaging & Live Validation** | implementation team + `cloud-model-B` | Package `extensions/contextforge-native` as a drop-in OpenClaw plugin (`openclaw plugins install -l`), run multi-turn benchmarks across both small-window (`32k/64k`) and large-window (`922k`) models, and verify automatic envelope adaptation, 100k+ RAG expansion, and multimodal fallback. | End-to-end proof: zero hardcoded model/project assumptions, automatic envelope discovery & overhead scaling, accurate multi-turn recall, and 100k+ RAG expansion + automatic next-turn release. |

---

## 5. Summary of Plug-and-Play Design Guarantees

1. **Zero Hardcoded Model or Project Assumptions:** Everything is driven by the discovered `CapabilityEnvelope` ($W$, $O$, $F$, $P$, $H$, and `model.input` modalities) and generic L0 $\rightarrow$ L3 provenance laws. Anyone can drop `contextforge-native` into any OpenClaw gateway (`plugins.slots.contextEngine = "contextforge"`), and it immediately adapts to an 8k model, a 32k/64k model, or a 1M-token model without touching a single setting.
2. **Underlying Memory Coexistence or Standalone Operation:** Works out of the box alongside OpenClaw's built-in `memory-core` / `memory-wiki`, or stands completely on its own via `~/.openclaw/state/contextforge.sqlite`.
