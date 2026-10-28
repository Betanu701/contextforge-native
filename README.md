# `@openclaw/contextforge-native` — ContextForge v2 Native Engine for OpenClaw

**ContextForge v2 (`contextforge-native`)** is a model-agnostic, zero-Python-sidecar, in-process SQLite context engine and Dual-Channel Symbolic IR compiler for OpenClaw (`>=2026.10.4` on Node 24+ `node:sqlite`).

## Key Capabilities

1. **Model-Agnostic Capability Envelope Discovery (`src/planner.ts`, `index.ts`)**
   - Automatically discovers the active model's physical and deployed context window ($W$), output/reasoning reserves ($O$), fixed system/tool overhead ($F$), pending user turn ($P$), and supported native input modalities (`text`, `image`, `audio`, `video`, `application/pdf`) from OpenClaw's live model catalog (`openclaw.json` / `runtimeSettings`).
   - Zero hardcoded cloud vs. local model names: any model on any provider adapts proportionally to its actual usable history budget $H$.
   - **No artificial context cap:** Routine conversational turns stay compact (`1.5k–3.5k` tokens), while heavy RAG, multi-document analysis, or multimodal inspection expands through a quarter-tranche ladder (`0.25 -> 0.50 -> 0.75 -> 1.00`, doubling up to $H$, verified at `780k+` tokens on 1M-window models) and releases bulk evidence on the next turn.

2. **Dual-Channel Symbolic IR System Prompt Compiler (`src/symbolic-ir.ts`)**
   - Whenever fixed system/tool overhead exceeds `maxFixedOverheadRatio` (default `15%` of $W$), ContextForge automatically engages `"slim-domain"` mode via `before_prompt_build`.
   - **Channel 1 (Persona / `SOUL.md`):** Preserved 100% in natural English prose so voice, candor, warmth, and style never sound robotic.
   - **Channel 2 (Operational Directives & L3 Rules):** Compiled into dense, formal `<compiled_rules_ir>` operators (`MUST`, `NEVER`, `PREFER`, `WHEN(cond) => DO(action)`), achieving ~69% token reduction on operational rules with a clean `symbolicIr: false` fallback toggle.

3. **Native SQLite + Content-Addressed Storage (`src/schema.ts`, `src/store.ts`)**
   - Uses Node 24's built-in `node:sqlite` (`DatabaseSync`) in `WAL` mode with `STRICT` tables, foreign-key cascades, and `FTS5` full-text indexing.
   - Inline storage for payloads `< 64 KiB` and content-addressed SHA-256 file blobs (`blobs/sha256/aa/bb/<sha256>`) for payloads `>= 64 KiB` with read-time SHA-256 verification and corruption quarantine.
   - Implements OpenClaw's `before-current-turn-entry-v1` transcript fence and `atomic-idempotent-v1` `commitTurn()` contract.

4. **Deterministic L0 $\rightarrow$ L1/L2 Wiki Compiler (`src/compiler.ts`)**
   - Zero-LLM-latency compilation of controlled grammars (`Decision:`, `Fact:`, `Negative fact:`, `Constraint:`, `State:`, `Correction:`), measurements, and exact decimal cumulative scale subtraction (`104g, 130g, 152g` $\rightarrow$ `104g, 26g, 22g`), while preserving general unstructured prose as extractive L0/L2 source-backed FTS5 chunks and Wiki pages.

5. **Agent Tools (`src/tools.ts`)**
   - `cf_recall` — Hybrid FTS5 + entity/Wiki recall across L0/L1/L2/L3.
   - `cf_remember` — Store authoritative L0 observations and immediately compile L1/L2 nodes.
   - `cf_permanent` — Manage owner-approved L3 Permanent Context rules (`set`, `get`, `list`, `delete`).
   - `cf_ingest` — Ingest text, documents, or multimodal files into L0 CAS storage.
   - `cf_wiki_lint` — Verify zero provenance gaps and quote-hash integrity across all active nodes.
   - `cf_status` — Inspect live SQLite counts, Epoch KV-cache state, and the latest `ContextForgePlanReceipt`.

## Build & Test

```bash
node scripts/build.mjs
node --experimental-strip-types --test test/*.test.ts
```

## OpenClaw Configuration

Install into `~/.openclaw/extensions/contextforge-native` and enable:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "contextforge",
      "memory": "memory-core"
    },
    "entries": {
      "contextforge-native": {
        "enabled": true,
        "config": {
          "maxFixedOverheadRatio": 0.15,
          "symbolicIr": true
        }
      }
    }
  }
}
```

## Part 2: Long-horizon understanding benchmark

The test-only [`benchmarks/long-horizon-understanding`](benchmarks/long-horizon-understanding/README.md)
benchmark exercises the real SQLite/compiler/planner pipeline with **50/100 turns**,
**0–5 bounded pressure spikes** (including 3/5 × 150k actual serialized-text heuristic
tokens), immediate next-turn pressure release, and five deep causal tracks:
architecture reversals, inferred operational constraints, native-image/tool/config
three-hop debugging, 27-observation same-entity drift with exact decimal math, and
late unprovisioned-sibling abstention (after turn 80 in the 100-turn variant).

```bash
# Offline only: no LLM inference or network. Includes all four 50/100 × 3/5 combinations.
node --experimental-strip-types --test test/long-horizon-benchmark.test.ts
node --experimental-strip-types benchmarks/long-horizon-understanding/runner.ts \
  --preset stress-max --turns 100 --pressure-spikes 5 \
  --spike-tokens 150000 --output long-horizon.json
```

Fixtures and scoring oracles are separate. Offline checks prove **original-premise
coverage, wire pressure/release, provenance integrity, and native protocol delivery**,
not model comprehension. Token estimates use actual serialized bytes but are not
provider tokenizer counts. Explicit opt-in `--live` supports configurable
OpenAI-compatible models, strictly sequential requests, provider usage reporting,
and `local-sequential`, `cloud-economical`, and `stress-max` presets. Live responses
are retained with lexical screens requiring separate human causal/citation review;
no inference is performed by the offline suite. See the benchmark README for CLI,
model-file schema, reporting semantics, and resource envelopes.

Natural-prose untared/cumulative balance sequences now compile exact BigInt deltas in consistent g/kg/mg/ml/mL/L/oz/lb units, with original quotes and explicit normalized-number/unit rendering.

## Part 3: 100-Turn Zero-Filler Deep Research Benchmark

The [`benchmarks/deep-research-100turns`](benchmarks/deep-research-100turns/README.md) suite exercises **100 substantive analytical turns with zero filler**, five interleaved scientific tracks (20 observations each), 10 multi-hop checkpoints (**108 required original premise deliveries**, including 80+ turn backward lags and 20-step `BigInt` 18-decimal-place `10^12 g` tare calorimetry subtraction), and 3 window-filling pressure spikes (`161k–178k` wire tokens) with `100%` immediate next-turn shedding.

Because `planContext()` enforces an automatic working-set knee (`optionalKneeCap` in `src/planner.ts`) on non-exhaustive optional historical recall while allowing required obligations (`sourceIds` and named document references) to expand to the full model window, normal analytical turns remain naturally bounded (`<= 11.8k` wire tokens) even when `hostTokenBudget` is left at the full `262,144`-token window.

## Architectural Boundary: Deterministic Lexical + Entity Routing vs. Optional Semantic/Embedding Fallback Dial (`fallbackMinCoverage`)

ContextForge v2 is intentionally **deterministic-first**:
1. **Primary Retrieval Path (`src/retrieval.ts`, `src/evidence.ts`, `src/compiler.ts`):** All core retrieval uses SQLite FTS5 lexical matching (`tokenizeRecallText` with identifier/camelCase/snake_case/numeric splitting) combined with L1/L2 compiled entity and concept graph traversal (`hydrateProvenanceSupport`, `expandRelatedPremises`). No embedding model or external vector daemon is shipped or required by default. This guarantees zero embedding-inference latency, 100% deterministic reproducibility, and exact `[span:...]` byte-offset provenance custody.
2. **Known Boundary:** When a query uses domain vocabulary, identifiers, or entity names present in the corpus (or connected via L2 entity/concept pages), recall is exact even 85+ turns later. However, if a query is phrased as a pure abstract paraphrase sharing *zero* lexical tokens and *zero* entity names with the target evidence, deterministic lexical search will have low facet coverage.
3. **Optional Semantic/Embedding Fallback Dial (`bridgePolicy.fallbackMinCoverage` in `src/external-recall.ts`):**
   - For deployments that want an embedding model or external semantic index as a safety net when lexical coverage is sparse, `prepareExternalRecall` / `planContextWithRecall` provides an explicit coverage dial: `bridgePolicy.fallbackMinCoverage` (a float in `[0, 1]`, default `0.05` / `5%` in `openclaw.plugin.json`).
   - Before invoking an injected `ExternalRecallAdapter`, `measureNativeLexicalCoverage()` computes the weighted question-facet coverage ratio (`0.0` to `1.0`) achieved by native L0/L1/L2 search.
   - If native coverage is **`>= fallbackMinCoverage`**, the external/embedding adapter is **skipped completely** (zero latency or cost).
   - If native coverage falls **`< fallbackMinCoverage`** (e.g., `< 5%` on an abstract paraphrase), ContextForge automatically invokes the injected `ExternalRecallAdapter` (which can wrap an embedding model, vector DB, or hybrid index), validates every returned `nativeRef` against the current SQLite generation/SHA-256/ACL boundary (`validateNativeRecallReference`), and hydrates the exact native L0 provenance spans into the plan.

