import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextForgeStore } from '../src/store.ts';
import { ContextForgeCompiler } from '../src/compiler.ts';
import { planContext, executeTrancheStream } from '../src/planner.ts';
import type { PlanContextInput } from '../src/planner.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cf-unified-tranche-'));
  const store = new ContextForgeStore(join(dir, 'store.sqlite'));
  return { store, clean() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function request(store: ContextForgeStore, extra: Partial<PlanContextInput> = {}) {
  return planContext({ store, sessionId: 'unified', admissionId: 'ample', query: 'ceramic kiln', rawSystemPrompt: 'Be precise.',
    envelope: { nativeContextTokens: 64000, hostTokenBudget: 60000, hostBudgetScope: 'history_only', input: ['text'] }, ...extra });
}
const quoted = (p: ReturnType<typeof planContext>) => p.receipt.selections.filter(s => s.role === 'quoted_evidence');

for (const compiled of [false, true]) test(`optional relative quality is elastic to actual headroom (compiled=${compiled})`, () => {
  const f = fixture();
  try {
    const strong = f.store.ingestSource({ originKey: 'firing-note', text: 'The ceramic kiln needs a slow cooling cycle.' });
    const weak = Array.from({ length: 24 }, (_, i) => f.store.ingestSource({ originKey: `catalog-${i}`, text: `The kiln catalog edition ${i} describes an unrelated shelf finish.` }));
    if (compiled) new ContextForgeCompiler(f.store).compile();
    const ample = request(f.store);
    assert.deepEqual(new Set(quoted(ample).map(s => s.sourceId)), new Set([strong, ...weak].map(s => s.sourceId)), 'roomy optional evidence is not cut merely for relative lexical quality');
    assert.equal(quoted(ample).at(-1)?.sourceId, strong.sourceId, 'strongest independent evidence renders last');
    const scarce = request(f.store, { admissionId: 'scarce', envelope: { nativeContextTokens: 64000, hostTokenBudget: 500, hostBudgetScope: 'history_only', input: ['text'] } });
    assert.deepEqual(quoted(scarce).map(s => s.sourceId), [strong.sourceId]);
    assert.ok(scarce.receipt.coldStorage.exclusions.some(e => e.reason === 'low_marginal_gain'));
    assert.ok(scarce.receipt.tokens.selectedHistory <= scarce.receipt.tokens.admissibleHistory);
  } finally { f.clean(); }
});

test('staged expansion does not let smaller later obligations displace an earlier fitting retained window', () => {
  const f = fixture();
  try {
    const texts = [`priorityGate ${'a'.repeat(10800)}`, ...Array.from({ length: 8 }, (_, i) => `secondaryNote${i} ${'b'.repeat(750)}`)];
    const sources = texts.map((text, i) => f.store.ingestSource({ originKey: `packet-${i}`, text }));
    const spans = Object.fromEntries(sources.map(s => [s.sourceId, f.store.getEvidenceChunks(s.sourceId).map(c => c.spanId)]));
    const p = request(f.store, { query: 'Inspect priorityGate and secondaryNote obligations.', sourceIds: sources.map(s => s.sourceId), requiredSpansBySource: spans,
      retainedStructuralSpans: true, strictExplicitObligationsOnly: true,
      envelope: { nativeContextTokens: 64000, hostTokenBudget: 4000, hostBudgetScope: 'history_only', input: ['text'] } });
    assert.equal(quoted(p)[0]?.sourceId, sources[0].sourceId, 'earlier large obligation must survive incremental admission');
    const indexes = quoted(p).map(s => sources.findIndex(x => x.sourceId === s.sourceId));
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
    assert.ok(p.receipt.stages.length > 1);
    assert.ok(p.receipt.tokens.selectedHistory <= 4000);
    assert.ok(p.receipt.demand.obligations.some(o => o.status !== 'satisfied'), 'unfit suffix remains honestly unresolved');
  } finally { f.clean(); }
});

test('a physically unfit earlier retained window does not deadlock later obligations', () => {
  const f = fixture();
  try {
    const large = f.store.ingestSource({ originKey: 'oversized-packet', text: 'x'.repeat(18000) });
    const small = f.store.ingestSource({ originKey: 'small-packet', text: 'A compact standalone obligation.' });
    const sources = [large, small];
    const p = request(f.store, { sourceIds: sources.map(s => s.sourceId),
      requiredSpansBySource: Object.fromEntries(sources.map(s => [s.sourceId, f.store.getEvidenceChunks(s.sourceId).map(c => c.spanId)])),
      retainedStructuralSpans: true, strictExplicitObligationsOnly: true,
      envelope: { nativeContextTokens: 64000, hostTokenBudget: 1000, hostBudgetScope: 'history_only', input: ['text'] } });
    assert.deepEqual(quoted(p).map(s => s.sourceId), [small.sourceId]);
    assert.ok(p.receipt.demand.obligations.some(o => o.status !== 'satisfied'));
  } finally { f.clean(); }
});

test('multi-pass source continuation retains disjoint exact structural units under a bounded wire budget', async () => {
  const f = fixture();
  try {
    const symbols = ['startRotor', 'stopRotor', 'checkRotor'];
    const text = symbols.map((name, i) => `export function ${name}() {\n  const note = '${'q'.repeat(3000)}';\n  return '${name}_witness_${i}';\n}\n`).join('\n');
    const src = f.store.ingestSource({ originKey: 'machine.ts', text });
    new ContextForgeCompiler(f.store).compile();
    const result = await executeTrancheStream({ store: f.store, sessionId: 'stream', admissionId: 'stream', query: `Inspect ${symbols.map(x => '`' + x + '`').join(' and ')}.`, rawSystemPrompt: 'Cite exact evidence.', sourceIds: [src.sourceId],
      trancheTokenBudget: 5000, maxPasses: 12,
      envelope: { nativeContextTokens: 32000, hostTokenBudget: 8000, hostBudgetScope: 'total_input', outputReserveTokens: 0, safetyMarginTokens: 100, input: ['text'] } },
      p => ({ keepSpanIds: quoted(p).flatMap(s => s.provenanceSpanIds) }));
    assert.ok(result.passes.length > 1, 'a source-level visited bit must not stop at its first window');
    assert.equal(result.allRequestedSourcesCovered, true);
    assert.equal(new Set(result.passes.map(p => p.plan.epoch.prefixSha256)).size, 1);
    for (const pass of result.passes) assert.ok(pass.plan.receipt.tokens.serializedInputTokens <= 5000);
    const finalText = quoted(result.finalPlan).flatMap(s => s.provenanceSpanIds).map(id => f.store.readEvidenceSpan(id).text).join('\n');
    for (const [i, name] of symbols.entries()) assert.ok(finalText.includes(`${name}_witness_${i}`), `missing disjoint premise ${name}`);
  } finally { f.clean(); }
});
