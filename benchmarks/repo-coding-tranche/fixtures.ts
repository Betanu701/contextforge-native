// Runtime repository fixture and cross-file coding tasks. No scoring imports.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURE_VERSION = 'repo-coding-tranche-v1';

export interface RepoFile {
  path: string;
  text: string;
}

export interface CodingChallenge {
  id: string;
  title: string;
  query: string;
  /** Initial queued files; intentionally ordered so target files span early/mid/late tranches, and some tasks omit an imported dependency to test L2 unresolvedSymbols resolution. */
  initialFiles: string[];
  /** Unresolved symbol that Pass 0 can request to pull in an unqueued dependency via L2 entity graph. */
  crossFileSymbolHint?: string;
}

export const REPO_FILE_PATHS = [
  'index.ts',
  'src/types.ts',
  'src/schema.ts',
  'src/store.ts',
  'src/symbolic-ir.ts',
  'src/retrieval.ts',
  'src/evidence.ts',
  'src/compiler.ts',
  'src/planner.ts',
  'src/external-recall.ts',
  'src/tools.ts',
] as const;

export function loadRepoFiles(repoRoot = resolve(new URL('../..', import.meta.url).pathname)): RepoFile[] {
  return REPO_FILE_PATHS.map(p => ({
    path: p,
    text: `// Repository file: ${p}\n` + readFileSync(resolve(repoRoot, p), 'utf8'),
  }));
}

export const CHALLENGES: CodingChallenge[] = [
  {
    id: 'task-1-dispatch-revalidation',
    title: 'Async Dispatch Gap & Derived-Node Contributor Revalidation',
    query: 'Analyze how `planContextWithRecall`, `bindContextPlan`, and `assertContextPlanCurrent` protect against concurrent mutations across async gaps before dispatch. Specifically: (1) Why is checking `SelectionItem.nodeId` or `trace.seedNodeId` insufficient when an L0 selection renders multiple merged L1 interpretations (`derivedNodeIds`), (2) what exact error is thrown if a contributor node status changes to `withdrawn` or `superseded` or its `content_sha256` changes without a namespace generation bump, and (3) how does `index.ts` handle a `ContextPlanGenerationChanged` error during `assemble()`? Cite exact `[span:...]` evidence and function/field names.',
    // Deliberately put bulky files first so FIFO/single-pass truncates before reaching external-recall.ts and index.ts
    initialFiles: [
      'src/store.ts',
      'src/compiler.ts',
      'src/planner.ts',
      'src/schema.ts',
      'src/tools.ts',
      'src/evidence.ts',
      'src/symbolic-ir.ts',
      'src/retrieval.ts',
      'src/types.ts',
      'src/external-recall.ts',
      'index.ts',
    ],
  },
  {
    id: 'task-2-cas-corruption-quarantine',
    title: '64KiB CAS Blob Split, Range-Read Verification & Corruption Quarantine',
    query: 'Trace the Content-Addressed Storage (CAS) and evidence span integrity pipeline across `src/schema.ts`, `src/store.ts`, and `src/evidence.ts`. Specifically: (1) At what exact byte threshold (`INLINE_THRESHOLD`) does `writeBlob` switch from inline SQLite storage to external SHA-256 files, (2) how does `readEvidenceSpan` / `getEvidenceChunks` verify quote integrity and what exact error (`BlobCorrupted` / `EvidenceQuoteMismatch`) or table update (`corrupt = 1`) occurs on mismatch, and (3) how does `buildEvidenceWindow` bound oversized (>8192 byte) chunks onto valid UTF-8 character boundaries? Cite exact `[span:...]` evidence.',
    initialFiles: [
      'index.ts',
      'src/planner.ts',
      'src/compiler.ts',
      'src/tools.ts',
      'src/external-recall.ts',
      'src/symbolic-ir.ts',
      'src/retrieval.ts',
      'src/types.ts',
      'src/schema.ts',
      'src/evidence.ts',
      'src/store.ts',
    ],
  },
  {
    id: 'task-3-bigint-scale-and-wiki-partitioning',
    title: 'Arbitrary-Precision BigInt Cumulative Scale Subtraction & L2 Wiki Partitioning',
    query: 'Examine `decimalSubtract`, `normalizedDecimal`, `extractAssertions`, and `buildWikiPages` in `src/compiler.ts` and how `hydrateProvenanceSupport` in `src/evidence.ts` consumes them. Specifically: (1) How does `decimalSubtract` compute exact differences using `BigInt` without IEEE-754 float drift and what `formula.rounding` tag is stored in `canonical_json`, (2) what per-page entry count (`64`) and character limit (`16384`) trigger `/part-XXXX` partitioning in `buildWikiPages`, and (3) how does `hydrateProvenanceSupport` enforce R2 lifecycle rules for `superseded` nodes? Cite exact `[span:...]` evidence.',
    initialFiles: [
      'src/store.ts',
      'src/planner.ts',
      'index.ts',
      'src/tools.ts',
      'src/external-recall.ts',
      'src/schema.ts',
      'src/symbolic-ir.ts',
      'src/retrieval.ts',
      'src/types.ts',
      'src/evidence.ts',
      'src/compiler.ts',
    ],
  },
  {
    id: 'task-4-tranche-knee-and-symbolic-ir',
    title: 'Dual-Channel Symbolic IR Compression & Self-Bounding Optional Tranche Knee',
    query: 'Trace how `resolvePromptAndToolProfile` and `planContext` in `src/planner.ts` interact with `compileDualChannelSystemPrompt` in `src/symbolic-ir.ts`. Specifically: (1) Under what condition (`F > ratio * W`, default `maxFixedOverheadRatio = 0.15`) does `promptMode` switch to `slim-domain`, (2) how does `compileDualChannelSystemPrompt` preserve `SOUL.md` persona prose while compiling operational directives into `<compiled_rules_ir>`, and (3) how does `optionalKneeCap` (`11500 - fixed - mandatoryCost`) bound non-exhaustive optional recall while allowing required obligations and `executeTrancheStream` to use the full window? Cite exact `[span:...]` evidence.',
    // Intentionally omit `src/symbolic-ir.ts` from initialFiles so `executeTrancheStream` resolves `compileDualChannelSystemPrompt` via L2 entity graph!
    initialFiles: [
      'src/store.ts',
      'src/compiler.ts',
      'index.ts',
      'src/tools.ts',
      'src/external-recall.ts',
      'src/schema.ts',
      'src/evidence.ts',
      'src/retrieval.ts',
      'src/types.ts',
      'src/planner.ts',
    ],
    crossFileSymbolHint: 'compileDualChannelSystemPrompt',
  },
  {
    id: 'task-5-semantic-dial-and-acl-isolation',
    title: 'Semantic Fallback Coverage Dial (`fallbackMinCoverage`), Supplement Loop Guard & ACL Isolation',
    query: 'Analyze the security and routing boundaries across `src/external-recall.ts`, `src/tools.ts`, `src/store.ts`, and `index.ts`. Specifically: (1) How does `measureNativeLexicalCoverage` compute the weighted question-facet coverage ratio and gate the external/embedding adapter via `fallbackMinCoverage` (default `0.05`), (2) how does `CONTEXTFORGE_SUPPLEMENT_ORIGIN` (`contextforge-native`) prevent recursive ingestion loops in `ingest()` and `prepareExternalRecall()`, and (3) how does `assertNamespace` in `src/store.ts` enforce owner/grant ACLs before any source existence or scoring check? Cite exact `[span:...]` evidence.',
    initialFiles: [
      'src/planner.ts',
      'src/compiler.ts',
      'src/store.ts',
      'src/evidence.ts',
      'src/schema.ts',
      'src/symbolic-ir.ts',
      'src/retrieval.ts',
      'src/types.ts',
      'src/tools.ts',
      'index.ts',
      'src/external-recall.ts',
    ],
  },
];
