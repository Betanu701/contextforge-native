#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ContextForgeStore,
  ContextForgeCompiler,
  planContext,
  loadWorkspaceSystemPrompt,
} from "../dist/index.js";
import { estimateTokens } from "../dist/src/symbolic-ir.js";

const LLAMA_BASE = "http://host.docker.internal:18080/v1";

const MODELS = [
  {
    id: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
    name: "Qwen 3.5 4B",
    contextWindow: 32768,
    turns: 50,
    runStandardCompactionAb: true,
  },
  {
    id: "gemma-4-E2B-it-UD-Q4_K_XL.gguf",
    name: "Gemma 4 E2B",
    contextWindow: 32768,
    turns: 50,
    runStandardCompactionAb: true,
  },
  {
    id: "gemma-4-26B-A4B-it-UD-IQ4_XS.gguf",
    name: "Gemma 4 26B-A4B MoE",
    contextWindow: 65536,
    turns: 50,
    runStandardCompactionAb: true,
  },
  {
    id: "Qwen3.6-35B-A3B-UD-IQ3_S.gguf",
    name: "Qwen 3.6 35B-A3B MoE",
    contextWindow: 65536,
    turns: 50,
    runStandardCompactionAb: true,
  },
];

// ~7,150 tokens (~25,800 chars) of realistic tool output per routine turn -> 50 turns = ~330,000+ raw tokens!
function buildHeavyToolPayload(turnIndex) {
  return (
    `Gateway cluster telemetry dump [batch=${turnIndex}]:\n` +
    `timestamp=2026-10-26T21:${String(turnIndex % 60).padStart(2, "0")}:00Z service=openclaw-gateway status=200 latency_ms=14.2 cpu_pct=31.4 mem_mb=4120 active_lanes=4 queue_depth=0 `.repeat(
      210,
    )
  );
}

function buildHeavyScenario(turnIndex) {
  if (turnIndex === 1) {
    return {
      kind: "fact_plant",
      prompt:
        "Fact: Vault Passphrase is Cobalt-99.\nDecision: Primary DB is SQLite WAL.\nState: Cluster Node | primary = spark-gpu-01\nAcknowledge in 1 short sentence.",
    };
  }
  if (turnIndex === 3) {
    return {
      kind: "scale_plant",
      prompt:
        "Cumulative kitchen scale: 310 g mixing bowl, 860 g oats, 1290 g honey\nAcknowledge the scale reading in 1 short sentence.",
    };
  }
  if (turnIndex === 25) {
    return {
      kind: "state_supersede",
      prompt:
        "State: Cluster Node | primary = dual-spark-5090-cluster\nAcknowledge the updated cluster node state in 1 short sentence.",
    };
  }
  // Checkpoints on Turn 10, 20, 30, 40, 47 (explicitly requested by Derek!), and 50
  if (turnIndex === 47 || [10, 20, 30, 40, 50].includes(turnIndex)) {
    const expectedNode = turnIndex > 25 ? "dual-spark-5090-cluster" : "spark-gpu-01";
    return {
      kind: "analytical_recall",
      prompt: `Turn ${turnIndex} audit: From our earlier turns (including Turn 1 and Turn 3), answer concisely in 2 sentences: (1) What is the Vault Passphrase and Primary DB Decision? (2) What is the current primary Cluster Node, and how many net grams of oats and honey were added on the kitchen scale?`,
      expectedSubstrings: ["Cobalt-99", "SQLite", expectedNode, "550", "430"],
    };
  }
  const topics = [
    "Inspect gateway telemetry batch and confirm status.",
    "Verify cluster shard health from log dump.",
    "Check memory pressure across worker lanes.",
    "Confirm zero dropped frames in transport log.",
    "Validate WAL checkpoint completion in dump.",
    "Verify CAS blob integrity across shards.",
  ];
  const msg = topics[turnIndex % topics.length];
  return {
    kind: "heavy_tool_turn",
    prompt: `[Turn ${turnIndex}] ${msg} Reply in 1 short sentence (under 12 words).`,
    heavyToolOutput: buildHeavyToolPayload(turnIndex),
  };
}

async function callLlamaChat(modelId, systemPrompt, messages, userPrompt, maxTokens = 96) {
  const sysParts = [systemPrompt];
  const nonSystemMessages = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m.role === "system" || m.role === "developer") {
      sysParts.push(text);
    } else {
      nonSystemMessages.push({
        role: m.role === "toolResult" || m.role === "tool" ? "user" : m.role,
        content: text,
      });
    }
  }
  const apiMessages = [
    { role: "system", content: sysParts.join("\n\n") },
    ...nonSystemMessages,
    { role: "user", content: userPrompt },
  ];

  const t0 = performance.now();
  const res = await fetch(`${LLAMA_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: apiMessages,
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const latencyMs = performance.now() - t0;
  const reply = data.choices?.[0]?.message?.content?.trim() || "";
  const usage = data.usage || {};
  const timings = data.timings || {};
  return {
    reply,
    latencyMs,
    promptTokens: usage.prompt_tokens ?? (timings.cache_n ?? 0) + (timings.prompt_n ?? 0),
    completionTokens: usage.completion_tokens ?? timings.predicted_n ?? 0,
    cachedTokens: timings.cache_n ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
    evaluatedPromptTokens: timings.prompt_n ?? 0,
    promptMs: timings.prompt_ms ?? 0,
    predictedMs: timings.predicted_ms ?? 0,
    promptPerSec: timings.prompt_per_second ?? 0,
    predictedPerSec: timings.predicted_per_second ?? 0,
  };
}

/**
 * Simulates standard Rolling LLM Compaction across 50 heavy turns (~7,150 tokens/turn):
 * Whenever accumulated history approaches the model's context window (or every ~3-4 heavy turns on a 32k model,
 * ~7-8 heavy turns on a 64k model), standard compaction invokes the LLM to summarize the history into a
 * ~250-token rolling summary and replaces the old messages with the summary.
 */
async function runStandardCompactionBaseline(modelCfg, compiledSystemPrompt) {
  console.log(`\n------------------------------------------------------`);
  console.log(
    `Running Standard Rolling Compaction Baseline (50 Heavy Turns, ~7.2k tok/turn) on ${modelCfg.name}...`,
  );
  console.log(`------------------------------------------------------`);

  const maxHistoryTokensBeforeCompact = Math.floor(modelCfg.contextWindow * 0.68); // ~22k on 32k window, ~44k on 64k window
  let rollingHistory = [];
  let compactionCount = 0;
  let totalCompactionPauseMs = 0;
  let recallHits = 0;
  let recallTotal = 0;
  const turnLogs = [];

  for (let t = 1; t <= modelCfg.turns; t++) {
    const scenario = buildHeavyScenario(t);

    // Estimate current history tokens
    const currentHistoryTokens = estimateTokens(JSON.stringify(rollingHistory));
    let compactedThisTurn = false;
    let compactionMs = 0;

    if (currentHistoryTokens > maxHistoryTokensBeforeCompact) {
      compactedThisTurn = true;
      compactionCount++;
      const compactPrompt =
        "Summarize the conversation and telemetry history so far into a concise 4-sentence checkpoint summary so we can free up context window space.";
      const compactRes = await callLlamaChat(
        modelCfg.id,
        "You are a session compaction summarizer. Summarize the conversation history concisely.",
        // Keep only a truncated view of tool outputs so the compaction call itself fits
        rollingHistory.map((m) => ({
          role: m.role,
          content: String(m.content).slice(0, 1200),
        })),
        compactPrompt,
        160,
      );
      compactionMs = compactRes.latencyMs;
      totalCompactionPauseMs += compactionMs;
      // Keep the rolling summary + the last 2 messages
      rollingHistory = [
        {
          role: "user",
          content: `[Compacted Session Summary (Compaction #${compactionCount})]:\n${compactRes.reply}`,
        },
        {
          role: "assistant",
          content: "Summary acknowledged.",
        },
        ...rollingHistory.slice(-2),
      ];
    }

    // Now run the actual turn against the rolling/compacted history (with tool outputs truncated to 2,500 chars like standard tool-result guard)
    const guardedHistory = rollingHistory.map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 6000),
    }));

    const llmRes = await callLlamaChat(
      modelCfg.id,
      compiledSystemPrompt,
      guardedHistory,
      scenario.prompt,
      scenario.kind === "analytical_recall" ? 110 : 48,
    );

    rollingHistory.push({ role: "user", content: scenario.prompt });
    if (scenario.heavyToolOutput) {
      rollingHistory.push({ role: "user", content: scenario.heavyToolOutput });
    }
    rollingHistory.push({ role: "assistant", content: llmRes.reply });

    let recallPassed = null;
    let matchedCount = null;
    if (scenario.expectedSubstrings) {
      recallTotal++;
      const matched = scenario.expectedSubstrings.filter((s) =>
        llmRes.reply.toLowerCase().includes(s.toLowerCase()),
      );
      matchedCount = `${matched.length}/${scenario.expectedSubstrings.length}`;
      recallPassed = matched.length >= 4;
      if (recallPassed) recallHits++;
    }

    turnLogs.push({
      turn: t,
      kind: scenario.kind,
      compactedThisTurn,
      compactionCountSoFar: compactionCount,
      compactionMs: Number(compactionMs.toFixed(1)),
      wirePromptTokens: llmRes.promptTokens,
      cachedTokens: llmRes.cachedTokens,
      evaluatedPromptTokens: llmRes.evaluatedPromptTokens,
      llmLatencyMs: Number((llmRes.latencyMs + compactionMs).toFixed(1)),
      recallPassed,
      matchedCount,
      replyPreview: llmRes.reply.slice(0, 180),
    });

    if (t === 1 || t === 3 || [10, 20, 25, 30, 40, 47, 50].includes(t)) {
      console.log(
        `[STD COMPACTION | ${modelCfg.name} | Turn ${String(t).padStart(2, " ")}/50] compactions=${compactionCount} wireIn=${String(llmRes.promptTokens).padStart(5, " ")}tok cached=${String(llmRes.cachedTokens).padStart(5, " ")}tok llm=${(llmRes.latencyMs + compactionMs).toFixed(0)}ms` +
          (recallPassed !== null
            ? ` recall=${recallPassed ? "PASS" : "FAIL"} [${matchedCount}] (${JSON.stringify(llmRes.reply.slice(0, 100))})`
            : ""),
      );
    }
  }

  const turn47 = turnLogs.find((x) => x.turn === 47);
  const avgLatencyMs =
    turnLogs.slice(1).reduce((a, b) => a + b.llmLatencyMs, 0) / (turnLogs.length - 1);
  const avgWirePromptTokens =
    turnLogs.slice(1).reduce((a, b) => a + b.wirePromptTokens, 0) / (turnLogs.length - 1);

  return {
    compactionCount,
    totalCompactionPauseMs: Math.round(totalCompactionPauseMs),
    avgWirePromptTokens: Math.round(avgWirePromptTokens),
    avgTurnLatencyMsIncludingCompaction: Math.round(avgLatencyMs),
    recallAccuracy: `${recallHits}/${recallTotal}`,
    turn47Audit: turn47,
    checkpoints: turnLogs.filter((x) => [1, 3, 10, 20, 25, 30, 40, 47, 50].includes(x.turn)),
  };
}

async function runHeavyModelBenchmark(modelCfg, rawSystemPrompt) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `cf-heavy50-${modelCfg.id.slice(0, 10)}-`),
  );
  const dbPath = path.join(tmpDir, "bench.sqlite");
  const store = new ContextForgeStore({ dbPath, blobRoot: path.join(tmpDir, "blobs") });
  const compiler = new ContextForgeCompiler(store);

  store.setPermanentContext(
    "contextforge-core-contract",
    "Always preserve SOUL.md persona in natural prose while compiling operational directives to Symbolic IR when fixed overhead exceeds 15% of the model context window.",
    {
      title: "ContextForge Core Contract",
      priority: 100,
      ownerApproved: true,
    },
  );

  const sysTokens = estimateTokens(rawSystemPrompt);
  const sessionId = `heavy50-${modelCfg.id}`;

  let uncompactedRawHistoryTokens = 0;
  const turnLogs = [];
  let recallHits = 0;
  let recallTotal = 0;
  let compiledSysPromptForAb = rawSystemPrompt;

  console.log(`\n======================================================`);
  console.log(
    `Starting 50-Turn HEAVY Benchmark (~7.2k tok/turn): ${modelCfg.name} (${modelCfg.id})`,
  );
  console.log(`Context Window: ${modelCfg.contextWindow} tokens | Raw System Prompt: ${sysTokens} tokens`);
  console.log(`======================================================`);

  for (let t = 1; t <= modelCfg.turns; t++) {
    const scenario = buildHeavyScenario(t);

    const planT0 = performance.now();
    const plan = planContext({
      store,
      sessionId,
      admissionId: `turn-${t}`,
      query: scenario.prompt,
      rawSystemPrompt,
      symbolicIr: true,
      maxFixedOverheadRatio: 0.15,
      envelope: {
        providerId: "llamacpp",
        modelId: modelCfg.id,
        input: ["text"],
        nativeContextTokens: modelCfg.contextWindow,
        deploymentContextTokens: modelCfg.contextWindow,
        hostTokenBudget: modelCfg.contextWindow - 4096,
        hostBudgetScope: "history_only",
        outputReserveTokens: 2048,
        reasoningReserveTokens: 0,
        systemTokens: sysTokens,
        toolSchemaTokens: 248,
        framingTokens: 64,
        pendingInputTokens: estimateTokens(scenario.prompt),
        safetyMarginTokens: 256,
        nativeDocumentMimeTypes: [],
      },
    });
    const planMs = performance.now() - planT0;
    if (t === 1) compiledSysPromptForAb = plan.systemPrompt;

    const llmRes = await callLlamaChat(
      modelCfg.id,
      plan.systemPrompt,
      plan.messages,
      scenario.prompt,
      scenario.kind === "analytical_recall" ? 110 : 48,
    );

    const turnMessages = [
      {
        id: `t${t}-u`,
        role: "user",
        content: scenario.prompt,
      },
    ];
    if (scenario.heavyToolOutput) {
      turnMessages.push(
        {
          id: `t${t}-a-tc`,
          role: "assistant",
          content: [
            { type: "toolCall", id: `tc-${t}`, name: "read_logs", input: { batch: t } },
          ],
        },
        {
          id: `t${t}-tr`,
          role: "toolResult",
          toolCallId: `tc-${t}`,
          content: scenario.heavyToolOutput,
        },
      );
    }
    turnMessages.push({
      id: `t${t}-a`,
      role: "assistant",
      content: llmRes.reply,
    });

    const turnRawTokens = estimateTokens(JSON.stringify(turnMessages));
    uncompactedRawHistoryTokens += turnRawTokens;

    store.commitTurn({
      sessionId,
      advancementKey: `commit-turn-${t}`,
      messages: turnMessages,
    });
    const compileT0 = performance.now();
    compiler.compilePending();
    const compileMs = performance.now() - compileT0;

    let recallPassed = null;
    let matchedCount = null;
    if (scenario.expectedSubstrings) {
      recallTotal++;
      const matched = scenario.expectedSubstrings.filter((s) =>
        llmRes.reply.toLowerCase().includes(s.toLowerCase()),
      );
      matchedCount = `${matched.length}/${scenario.expectedSubstrings.length}`;
      recallPassed = matched.length >= 4;
      if (recallPassed) recallHits++;
    }

    turnLogs.push({
      turn: t,
      kind: scenario.kind,
      demand: plan.receipt.demand.primary,
      selectedHistoryTokens: plan.receipt.tokens.selectedHistory,
      uncompactedRawHistoryTokens,
      wirePromptTokens: llmRes.promptTokens,
      cachedTokens: llmRes.cachedTokens,
      evaluatedPromptTokens: llmRes.evaluatedPromptTokens,
      planMs: Number(planMs.toFixed(2)),
      compileMs: Number(compileMs.toFixed(2)),
      promptMs: Number(llmRes.promptMs.toFixed(1)),
      llmLatencyMs: Number(llmRes.latencyMs.toFixed(1)),
      predictedPerSec: Number(llmRes.predictedPerSec.toFixed(1)),
      recallPassed,
      matchedCount,
      replyPreview: llmRes.reply.slice(0, 180),
    });

    if (t === 1 || t === 3 || [10, 20, 25, 30, 40, 47, 50].includes(t)) {
      console.log(
        `[CF v2 | ${modelCfg.name} | Turn ${String(t).padStart(2, " ")}/50] kind=${scenario.kind.padEnd(17, " ")} cfHist=${String(plan.receipt.tokens.selectedHistory).padStart(4, " ")}tok (raw=${String(uncompactedRawHistoryTokens).padStart(6, " ")}tok) wireIn=${String(llmRes.promptTokens).padStart(4, " ")}tok cached=${String(llmRes.cachedTokens).padStart(4, " ")}tok newEval=${String(llmRes.evaluatedPromptTokens).padStart(4, " ")}tok plan=${planMs.toFixed(1)}ms llm=${llmRes.latencyMs.toFixed(0)}ms` +
          (recallPassed !== null
            ? ` recall=${recallPassed ? "PASS" : "FAIL"} [${matchedCount}] (${JSON.stringify(llmRes.reply.slice(0, 100))})`
            : ""),
      );
    }
  }

  let standardCompactionAb = null;
  if (modelCfg.runStandardCompactionAb) {
    standardCompactionAb = await runStandardCompactionBaseline(modelCfg, compiledSysPromptForAb);
  }

  const lint = compiler.lintWiki();
  const status = store.getStats();
  store.close();

  const warmLogs = turnLogs.slice(1);
  const heavyTurns = warmLogs.filter((x) => x.kind === "heavy_tool_turn");
  const analyticalTurns = warmLogs.filter((x) => x.kind === "analytical_recall");
  const avg = (arr, fn) => (arr.length ? arr.reduce((a, b) => a + fn(b), 0) / arr.length : 0);

  return {
    modelId: modelCfg.id,
    modelName: modelCfg.name,
    contextWindow: modelCfg.contextWindow,
    turnsCompleted: turnLogs.length,
    finalUncompactedTotalTokens: uncompactedRawHistoryTokens + sysTokens,
    contextForge: {
      routineHeavyTurns: {
        count: heavyTurns.length,
        avgSelectedHistoryTokens: Math.round(avg(heavyTurns, (x) => x.selectedHistoryTokens)),
        avgWirePromptTokens: Math.round(avg(heavyTurns, (x) => x.wirePromptTokens)),
        avgCachedTokens: Math.round(avg(heavyTurns, (x) => x.cachedTokens)),
        avgNewEvaluatedTokens: Math.round(avg(heavyTurns, (x) => x.evaluatedPromptTokens)),
        kvCacheHitRatioPct: Number(
          (
            (avg(heavyTurns, (x) => x.cachedTokens) /
              Math.max(1, avg(heavyTurns, (x) => x.wirePromptTokens))) *
            100
          ).toFixed(1),
        ),
        avgPlanMs: Number(avg(heavyTurns, (x) => x.planMs).toFixed(2)),
        avgCompileMs: Number(avg(heavyTurns, (x) => x.compileMs).toFixed(2)),
        avgTotalLlmLatencyMs: Math.round(avg(heavyTurns, (x) => x.llmLatencyMs)),
      },
      analyticalRecallTurns: {
        count: analyticalTurns.length,
        recallAccuracy: `${recallHits}/${recallTotal}`,
        avgSelectedHistoryTokens: Math.round(avg(analyticalTurns, (x) => x.selectedHistoryTokens)),
        avgWirePromptTokens: Math.round(avg(analyticalTurns, (x) => x.wirePromptTokens)),
        avgCachedTokens: Math.round(avg(analyticalTurns, (x) => x.cachedTokens)),
        avgTotalLlmLatencyMs: Math.round(avg(analyticalTurns, (x) => x.llmLatencyMs)),
      },
      turn47Audit: turnLogs.find((x) => x.turn === 47),
      checkpoints: turnLogs.filter((x) => [1, 3, 10, 20, 25, 30, 40, 47, 50].includes(x.turn)),
      sqliteStats: status,
      wikiLint: lint,
    },
    standardCompactionAb,
  };
}

async function main() {
  const rawSystemPrompt = loadWorkspaceSystemPrompt();
  const results = [];
  const outPath =
    "/home/node/.openclaw/workspace/extensions/contextforge-native/benchmark-heavy-50turns-results.json";
  for (const m of MODELS) {
    const res = await runHeavyModelBenchmark(m, rawSystemPrompt);
    results.push(res);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
    );
  }
  console.log("\nALL 50-TURN HEAVY BENCHMARKS COMPLETE.");
}

main().catch((err) => {
  console.error("Heavy benchmark failed:", err);
  process.exit(1);
});
