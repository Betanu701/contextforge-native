// Independent scoring oracle for the Repo-Coding Tranche Benchmark.
import type { ContextPlan } from '../../src/planner.ts';
import type { ContextForgeStore } from '../../src/store.ts';
import { canonicalJson } from '../../src/store.ts';

export interface RequiredCodePremise {
  file: string;
  witness: string;
  description: string;
}

export const REQUIRED_PREMISES: Record<string, RequiredCodePremise[]> = {
  'task-1-dispatch-revalidation': [
    { file: 'src/external-recall.ts', witness: 'derivedNodeIds', description: 'bindContextPlan collects all merged derivedNodeIds contributors' },
    { file: 'src/external-recall.ts', witness: 'ContextPlanNativeReferenceUnavailable', description: 'assertContextPlanCurrent throws ContextPlanNativeReferenceUnavailable on node/source status or hash mismatch' },
    { file: 'index.ts', witness: 'ContextPlanGenerationChanged', description: 'index.ts retries assemble with incremented attempt on ContextPlanGenerationChanged' },
  ],
  'task-2-cas-corruption-quarantine': [
    { file: 'src/store.ts', witness: 'INLINE_THRESHOLD', description: 'INLINE_THRESHOLD = 64 * 1024 (64 KiB) threshold in store.ts' },
    { file: 'src/store.ts', witness: 'EvidenceQuoteMismatch', description: 'getEvidenceChunks / readEvidenceSpan throws EvidenceQuoteMismatch or BlobCorrupted on SHA/quote mismatch' },
    { file: 'src/evidence.ts', witness: '0xc0', description: 'buildEvidenceWindow aligns 8192-byte window onto UTF-8 continuation byte boundaries ((bytes[start]&0xc0)===0x80)' },
  ],
  'task-3-bigint-scale-and-wiki-partitioning': [
    { file: 'src/compiler.ts', witness: 'exact_decimal', description: 'BigInt decimalSubtract records rounding: exact_decimal in canonical_json' },
    { file: 'src/compiler.ts', witness: '16384', description: 'buildWikiPages flushes /part-XXXX at 64 entries or 16384 chars' },
    { file: 'src/evidence.ts', witness: 'superseded', description: 'hydrateProvenanceSupport excludes superseded nodes unless historical(recall) is true' },
  ],
  'task-4-tranche-knee-and-symbolic-ir': [
    { file: 'src/planner.ts', witness: 'slim-domain', description: 'resolvePromptAndToolProfile switches to slim-domain when F > ratio * W' },
    { file: 'src/symbolic-ir.ts', witness: '<compiled_rules_ir>', description: 'compileDualChannelSystemPrompt emits <compiled_rules_ir> while preserving SOUL.md prose' },
    { file: 'src/planner.ts', witness: 'optionalKneeCap', description: 'planContext bounds non-exhaustive optional recall via optionalKneeCap (11500)' },
  ],
  'task-5-semantic-dial-and-acl-isolation': [
    { file: 'src/external-recall.ts', witness: 'measureNativeLexicalCoverage', description: 'prepareExternalRecall gates external adapter via measureNativeLexicalCoverage and fallbackMinCoverage' },
    { file: 'src/external-recall.ts', witness: 'CONTEXTFORGE_SUPPLEMENT_ORIGIN', description: 'CONTEXTFORGE_SUPPLEMENT_ORIGIN excludes recursive supplement ingestion' },
    { file: 'src/store.ts', witness: 'assertNamespace', description: 'assertNamespace enforces namespace ownership/grants before access' },
  ],
};

export function scoreCodePremisesOnText(challengeId: string, deliveredText: string) {
  const reqs = REQUIRED_PREMISES[challengeId] ?? [];
  const checks = reqs.map(r => ({
    file: r.file,
    witness: r.witness,
    description: r.description,
    present: deliveredText.includes(r.witness),
  }));
  return {
    challengeId,
    required: checks.length,
    covered: checks.filter(c => c.present).length,
    allPremisesCovered: checks.length > 0 && checks.every(c => c.present),
    checks,
  };
}

export function scoreCodePremisesOnPlan(challengeId: string, plan: ContextPlan, store: ContextForgeStore) {
  const delivered = plan.messages.map(m => canonicalJson(m)).join('\n');
  const reqs = REQUIRED_PREMISES[challengeId] ?? [];
  const checks = reqs.map(r => {
    const matchingSelections = plan.receipt.selections.filter(s => {
      const src = store.getSource(s.sourceId);
      if (!src || src.originKey !== r.file) return false;
      const spanText = s.provenanceSpanIds.map(id => store.readEvidenceSpan(id).text).join('\n');
      return spanText.includes(r.witness) && delivered.includes(r.witness);
    });
    return {
      file: r.file,
      witness: r.witness,
      description: r.description,
      present: matchingSelections.length > 0,
      sourceIds: [...new Set(matchingSelections.map(s => s.sourceId))],
      spanIds: [...new Set(matchingSelections.flatMap(s => s.provenanceSpanIds))],
    };
  });
  return {
    challengeId,
    required: checks.length,
    covered: checks.filter(c => c.present).length,
    allPremisesCovered: checks.length > 0 && checks.every(c => c.present),
    checks,
  };
}

export function scoreCodingResponse(challengeId: string, response: string) {
  const rubrics: Record<string, Array<{ name: string; re: RegExp }>> = {
    'task-1-dispatch-revalidation': [
      { name: 'derivedNodeIds contributor set', re: /derivedNodeIds/i },
      { name: 'ContextPlanNativeReferenceUnavailable error', re: /ContextPlanNativeReferenceUnavailable/i },
      { name: 'ContextPlanGenerationChanged retry/attempt', re: /ContextPlanGenerationChanged|attempt/i },
    ],
    'task-2-cas-corruption-quarantine': [
      { name: '64KiB / INLINE_THRESHOLD', re: /65[_,]?536|64\s*\*\s*1024|64\s*Ki?B|INLINE_THRESHOLD/i },
      { name: 'corruption/quote mismatch guard', re: /EvidenceQuoteMismatch|BlobCorrupted|corrupt/i },
      { name: 'UTF-8 byte boundary alignment', re: /0xc0|0x80|UTF-?8|8192/i },
    ],
    'task-3-bigint-scale-and-wiki-partitioning': [
      { name: 'BigInt exact_decimal formula', re: /BigInt|exact_decimal|decimalSubtract/i },
      { name: '64 entries / 16384 chars partitioning', re: /16[_,]?384|\b64\b|part-/i },
      { name: 'superseded historical gate', re: /superseded|historical/i },
    ],
    'task-4-tranche-knee-and-symbolic-ir': [
      { name: 'slim-domain / 0.15 ratio', re: /slim-domain|0\.15|maxFixedOverheadRatio/i },
      { name: '<compiled_rules_ir> + SOUL.md', re: /compiled_rules_ir|SOUL\.md|persona/i },
      { name: 'optionalKneeCap / 11500 knee', re: /optionalKneeCap|11[_,]?500/i },
    ],
    'task-5-semantic-dial-and-acl-isolation': [
      { name: 'fallbackMinCoverage / measureNativeLexicalCoverage', re: /fallbackMinCoverage|measureNativeLexicalCoverage|0\.05/i },
      { name: 'CONTEXTFORGE_SUPPLEMENT_ORIGIN loop guard', re: /CONTEXTFORGE_SUPPLEMENT_ORIGIN|contextforge-native/i },
      { name: 'assertNamespace ACL check', re: /assertNamespace|namespace_grants|access denied/i },
    ],
  };
  const checks = (rubrics[challengeId] ?? []).map(c => ({
    name: c.name,
    pass: c.re.test(response),
  }));
  return {
    pass: checks.length > 0 && checks.every(c => c.pass),
    passedCount: checks.filter(c => c.pass).length,
    totalChecks: checks.length,
    hasCitation: /\[span:[a-f0-9]{64}\]/i.test(response),
    checks,
  };
}
