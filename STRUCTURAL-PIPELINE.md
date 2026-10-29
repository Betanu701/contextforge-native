# Source-backed structural routing

Accepted implementation contract (2026-10-29): L0 bytes and SCHEMA_V1/checksum remain unchanged. The existing grammar decomposition is the structural authority; no parser dependency, external preprocessing, dictionary, or parallel symbol database is introduced. Existing `spans`, L2 canonical routing entries, provenance and FTS projections are reused.

Each source artifact can expose file/section/symbol/part ranges with exact byte and original line coordinates, containment, signature support and lexical subtokens. Compiler-owned structural L2 pages contain bounded exact excerpts plus navigation metadata (never semantic claims). Containment and continuation reference structural unit IDs and exact support spans. References are lexical occurrences, not claimed call resolution. README/architecture material remains documentation even with fenced examples.

Evidence hydration chooses an intact enclosing unit when it fits its bounded window; otherwise it emits an exact contiguous part, signature, and explicitly labelled structural navigation metadata. No derived label is mixed into an L0 quote. Retrieval, admission and final rendering order are independent. Explicit obligation order wins over optional orientation ordering.

Tradeoff: deterministic grammars are conservative, not full language semantic parsers. Unsupported syntax remains exact bounded source evidence. Persisted routing metadata is regenerable; raw custody is never modified. Rollback is a source/build rollback followed by ordinary recompilation; obsolete compiler pages retire through the existing lifecycle. Acceptance requires byte conservation, UTF-8 boundaries, provenance lint, ordinary ingest/compile/plan tests, full existing suite and packaged/source parity.

## Runtime contracts

- `ContextForgeStore.getStructuralUnits()` exposes regenerable source coordinates. `createEvidenceSpan()` creates or reuses exact quotes with budget-accounted range reads, not hidden full-blob reads.
- `compiler.ts` publishes `wiki/structure/<source>/<unit>` through the existing L2 publisher. Canonical entries carry containment, part adjacency, header support, subtokens, path provenance and lexical-reference targets. Links are navigation hints, not derivation claims or resolved calls.
- `buildEvidenceWindow()` admits a fitting complete definition, or atomically admits a part plus its signature. Default block bound is 4096 bytes; structural window bound is 8192 bytes. Oversized headers use a shared UTF-8-safe 4096-byte prefix policy and explicitly report incompleteness/continuation. Failed compound reads retain fallback evidence and mark structural incompleteness.
- Known code paths override heading heuristics; Markdown fenced examples never turn README into Python. Stream markers/outside records conserve all original bytes and retain original stream line numbers.
- General documentation has section structure, but only relevant README/architecture/overview/contributing material receives bounded orientation priority. Explicit caller order is preserved.
- Existing dictionary-era tables are left inert for nondestructive upgrade compatibility; new stores neither create nor seed them. The schema migration file remains byte-identical.
- Small required source sets share the ordinary 11,500-token input knee with optional recall. When explicit required payloads themselves exceed that knee, bounded optional recall remains available independently, capped by both the ordinary evidence budget and residual physical capacity. This preserves relevant premise retrieval on large authorized attachment turns without granting ordinary requests a second full budget.

- Support delivery recognizes exact span IDs or gap-free enclosing byte ranges on the same immutable artifact. Full required quotes therefore satisfy contained original support excerpts without duplicate optional excerpts; alternate artifacts and uncovered byte gaps remain missing evidence.

## Verification history

Adversarial review found hidden whole-blob span reads, non-atomic part/header admission and oversized-signature fallback. All three received targeted regression tests and range-budget/atomicity fixes. Repository-wide parser tests additionally caught crossing arrow/template spans; crossing intervals are rejected rather than clipped into invalid headers. Existing multiplier/dictionary/synthetic-numbering tests were replaced with the newly authorized invariants, not retained as obsolete product requirements.
