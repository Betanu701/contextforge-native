import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRepoCodingBenchmark } from '../benchmarks/repo-coding-tranche/runner.ts';

test('repo-coding-tranche benchmark: Multi-Pass executeTrancheStream achieves 15/15 (100%) code premise delivery and 100% Slot 0 prefix stability vs 1/15 FIFO and 4/15 Single-Pass under a 16K tranche budget', async () => {
  const report = await runRepoCodingBenchmark({
    windowTokens: 18000,
    trancheTokenBudget: 16000,
    maxOutput: 1536,
  });

  assert.equal(report.summary.challenges, 5);
  assert.equal(report.summary.requiredPremisesTotal, 15);
  assert.equal(report.summary.trancheStreamPremisesCovered, 15);
  assert.equal(report.summary.trancheStreamCheckpointsComplete, 5);
  assert.equal(report.summary.trancheStreamAllPrefixStable, true);
  assert.ok(report.summary.standardFifoPremisesCovered < 5);
  assert.ok(report.summary.singlePassCfPremisesCovered < 8);

  for (const r of report.trancheStreamResults) {
    assert.equal(r.allPremisesCovered, true, `${r.challengeId} missed premises`);
    assert.equal(r.stablePrefixReusedAcrossAllPasses, true, `${r.challengeId} prefix unstable`);
    assert.ok(r.maxPassWireTokensHeuristic <= 16000, `${r.challengeId} exceeded 16K tranche budget`);
    assert.ok(r.finalSynthesisWireTokensHeuristic <= 16000, `${r.challengeId} final synthesis exceeded 16K budget`);
  }
});
