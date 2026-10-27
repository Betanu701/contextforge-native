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

const LLAMA_BASE = process.env.CONTEXTFORGE_API_BASE ?? "http://127.0.0.1:8080/v1";

const MODELS = [
  {
    id: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
    name: "Qwen 3.5 4B",
    contextWindow: 32768,
    turns: 100,
    runRawAbBaseline: true, // Also run a raw uncompacted baseline on this model to measure exact crossover
  },
  {
    id: "gemma-4-E2B-it-UD-Q4_K_XL.gguf",
    name: "Gemma 4 E2B",
    contextWindow: 32768,
    turns: 100,
    runRawAbBaseline: false,
  },
  {
    id: "gemma-4-26B-A4B-it-UD-IQ4_XS.gguf",
    name: "Gemma 4 26B-A4B MoE",
    contextWindow: 65536,
    turns: 100,
    runRawAbBaseline: false,
  },
  {
    id: "Qwen3.6-35B-A3B-UD-IQ3_S.gguf",
    name: "Qwen 3.6 35B-A3B MoE",
    contextWindow: 65536,
    turns: 100,
    runRawAbBaseline: false,
  },
];

function buildTurnScenario(turnIndex) {
  if (turnIndex === 1) {
    return {
      kind: "fact_plant",
      prompt:
        "Fact: Project Codename is Aurora-7.\nDecision: Storage engine is SQLite WAL.\nState: Primary GPU | model = RTX 5090\nAcknowledge in 1 short sentence.",
    };
  }
  if (turnIndex === 4) {
    return {
      kind: "scale_plant",
      prompt:
        "Cumulative kitchen scale: 420 g empty bowl, 970 g flour, 1345 g water\nAcknowledge the scale reading in 1 short sentence.",
    };
  }
  if (turnIndex === 50) {
    return {
      kind: "state_supersede",
      prompt:
        "State: Primary GPU | model = Dual RTX 5090 + RTX 3090 Ti\nAcknowledge the updated GPU state in 1 short sentence.",
    };
  }
  // Checkpoints on Turn 10, 20, 30, 40, 60, 70, 80, 89 (explicitly requested by Derek!), 90, 100
  if (turnIndex === 89 || (turnIndex % 10 === 0 && turnIndex !== 50)) {
    const expectedGpu = turnIndex > 50 ? "3090" : "5090";
    return {
      kind: "analytical_recall",
      prompt: `Turn ${turnIndex} audit: From our earlier turns, answer concisely in 2 sentences: (1) What is the Project Codename and Storage engine Decision? (2) What is the current Primary GPU model, and how many net grams of flour and water were added on the kitchen scale?`,
      expectedSubstrings: ["Aurora-7", "SQLite", expectedGpu, "550", "375"],
    };
  }
  const topics = [
    "Confirm status of telemetry pipeline.",
    "Check latency budget on current epoch.",
    "Acknowledge heartbeat check.",
    "Report ready for next micro-batch.",
    "Verify CAS deduplication status.",
    "Confirm FTS5 index health.",
    "Acknowledge KV-cache prefix lock.",
    "Confirm zero provenance gaps.",
  ];
  const msg = topics[turnIndex % topics.length];
  return {
    kind: "conversational",
    prompt: `[Turn ${turnIndex}] ${msg} Reply in 1 short sentence (under 12 words).`,
    syntheticToolOutputChars: 2400, // ~600 tokens of tool output per routine turn -> 100 turns = ~65,000+ raw tokens
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
    signal: AbortSignal.timeout(120000),
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

async function runRawUncompactedBaseline(modelCfg, rawSystemPrompt) {
  console.log(`\n------------------------------------------------------`);
  console.log(`Running A/B Raw Uncompacted Baseline on ${modelCfg.name} (until 32k window overflow)...`);
  console.log(`------------------------------------------------------`);
  const rawMessages = [];
  const baselineLogs = [];
  for (let t = 1; t <= 45; t++) {
    const scenario = buildTurnScenario(t);
    try {
      const llmRes = await callLlamaChat(
        modelCfg.id,
        rawSystemPrompt,
        rawMessages,
        scenario.prompt,
        scenario.kind === "analytical_recall" ? 110 : 48,
      );
      rawMessages.push({ role: "user", content: scenario.prompt });
      if (scenario.syntheticToolOutputChars) {
        const filler =
          `Tool execution telemetry log for turn ${t}: ` + "status=ok metric=nominal ".repeat(85);
        rawMessages.push({ role: "user", content: filler });
      }
      rawMessages.push({ role: "assistant", content: llmRes.reply });
      baselineLogs.push({
        turn: t,
        status: "ok",
        wirePromptTokens: llmRes.promptTokens,
        cachedTokens: llmRes.cachedTokens,
        evaluatedPromptTokens: llmRes.evaluatedPromptTokens,
        promptMs: Number(llmRes.promptMs.toFixed(1)),
        predictedMs: Number(llmRes.predictedMs.toFixed(1)),
        totalLatencyMs: Number(llmRes.latencyMs.toFixed(1)),
      });
      if (t === 1 || t % 5 === 0) {
        console.log(
          `[RAW BASELINE | Turn ${String(t).padStart(2, " ")}] wireIn=${llmRes.promptTokens}tok cached=${llmRes.cachedTokens}tok newEval=${llmRes.evaluatedPromptTokens}tok promptMs=${llmRes.promptMs.toFixed(0)}ms total=${llmRes.latencyMs.toFixed(0)}ms`,
        );
      }
    } catch (err) {
      console.log(`[RAW BASELINE | Turn ${t}] OVERFLOW / FAILED: ${String(err.message).slice(0, 180)}`);
      baselineLogs.push({
        turn: t,
        status: "overflow_error",
        error: String(err.message).slice(0, 200),
      });
      break;
    }
  }
  return baselineLogs;
}

async function runModelBenchmark(modelCfg, rawSystemPrompt) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cf-bench-${modelCfg.id.slice(0, 10)}-`));
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
  const sessionId = `bench-${modelCfg.id}`;

  let uncompactedRawHistoryTokens = 0;
  const turnLogs = [];
  let recallHits = 0;
  let recallTotal = 0;

  console.log(`\n======================================================`);
  console.log(`Starting ${modelCfg.turns}-Turn ContextForge v2 Benchmark: ${modelCfg.name} (${modelCfg.id})`);
  console.log(`Context Window: ${modelCfg.contextWindow} tokens | Raw System Prompt: ${sysTokens} tokens`);
  console.log(`======================================================`);

  for (let t = 1; t <= modelCfg.turns; t++) {
    const scenario = buildTurnScenario(t);

    // Plan context purely via ContextForge v2 (no manual script injection!)
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

    // Call live local model on llama.cpp using ONLY plan.systemPrompt and plan.messages
    const llmRes = await callLlamaChat(
      modelCfg.id,
      plan.systemPrompt,
      plan.messages,
      scenario.prompt,
      scenario.kind === "analytical_recall" ? 110 : 48,
    );

    // Commit turn + optional synthetic tool output into L0 store
    const turnMessages = [
      {
        id: `t${t}-u`,
        role: "user",
        content: scenario.prompt,
      },
    ];
    if (scenario.syntheticToolOutputChars) {
      const filler =
        `Tool execution telemetry log for turn ${t}: ` + "status=ok metric=nominal ".repeat(85);
      turnMessages.push(
        {
          id: `t${t}-a-tc`,
          role: "assistant",
          content: [
            { type: "toolCall", id: `tc-${t}`, name: "telemetry_check", input: { turn: t } },
          ],
        },
        {
          id: `t${t}-tr`,
          role: "toolResult",
          toolCallId: `tc-${t}`,
          content: filler,
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
      recallPassed = matched.length >= 4; // require at least 4 of 5 facts (Aurora-7, SQLite, GPU, 550g flour, 375g water)
      if (recallPassed) recallHits++;
    }

    const quotedCount = plan.receipt.selections.filter((s) => s.role === "quoted_evidence").length;

    turnLogs.push({
      turn: t,
      kind: scenario.kind,
      demand: plan.receipt.demand.primary,
      promptMode: plan.receipt.profile.promptMode,
      epochId: plan.epoch.epochId.slice(0, 12),
      systemTokens: plan.receipt.tokens.systemPolicy,
      selectedHistoryTokens: plan.receipt.tokens.selectedHistory,
      quotedEvidenceItems: quotedCount,
      uncompactedRawHistoryTokens,
      wirePromptTokens: llmRes.promptTokens,
      cachedTokens: llmRes.cachedTokens,
      evaluatedPromptTokens: llmRes.evaluatedPromptTokens,
      completionTokens: llmRes.completionTokens,
      planMs: Number(planMs.toFixed(2)),
      compileMs: Number(compileMs.toFixed(2)),
      promptMs: Number(llmRes.promptMs.toFixed(1)),
      predictedMs: Number(llmRes.predictedMs.toFixed(1)),
      llmLatencyMs: Number(llmRes.latencyMs.toFixed(1)),
      predictedPerSec: Number(llmRes.predictedPerSec.toFixed(1)),
      recallPassed,
      matchedCount,
      replyPreview: llmRes.reply.slice(0, 180),
    });

    if (t === 1 || t === 4 || t === 50 || t === 89 || t % 10 === 0 || t === modelCfg.turns) {
      console.log(
        `[${modelCfg.name} | Turn ${String(t).padStart(3, " ")}/${modelCfg.turns}] kind=${scenario.kind.padEnd(17, " ")} demand=${plan.receipt.demand.primary.padEnd(14, " ")} cfHist=${String(plan.receipt.tokens.selectedHistory).padStart(4, " ")}tok (raw=${String(uncompactedRawHistoryTokens).padStart(5, " ")}tok) wireIn=${String(llmRes.promptTokens).padStart(4, " ")}tok cached=${String(llmRes.cachedTokens).padStart(4, " ")}tok newEval=${String(llmRes.evaluatedPromptTokens).padStart(4, " ")}tok plan=${planMs.toFixed(1)}ms llm=${llmRes.latencyMs.toFixed(0)}ms (${llmRes.predictedPerSec.toFixed(1)} tok/s)` +
          (recallPassed !== null
            ? ` recall=${recallPassed ? "PASS" : "PARTIAL"} [${matchedCount}] (${JSON.stringify(llmRes.reply.slice(0, 110))})`
            : ""),
      );
    }
  }

  let rawAbBaseline = null;
  if (modelCfg.runRawAbBaseline) {
    rawAbBaseline = await runRawUncompactedBaseline(modelCfg, rawSystemPrompt);
  }

  const lint = compiler.lintWiki();
  const status = store.getStats();
  const distinctEpochs = store.db
    .prepare("SELECT COUNT(*) AS c FROM epochs WHERE session_id=?")
    .get(sessionId).c;
  store.close();

  // Exclude Turn 1 cold model-load from warm latency averages
  const warmLogs = turnLogs.slice(1);
  const conversationalLogs = warmLogs.filter((x) => x.kind === "conversational");
  const analyticalLogs = warmLogs.filter((x) => x.kind === "analytical_recall");

  const avg = (arr, fn) =>
    arr.length ? arr.reduce((a, b) => a + fn(b), 0) / arr.length : 0;

  const finalRawTokens = uncompactedRawHistoryTokens + sysTokens;
  const turn89Log = turnLogs.find((x) => x.turn === 89);

  return {
    modelId: modelCfg.id,
    modelName: modelCfg.name,
    contextWindow: modelCfg.contextWindow,
    turnsCompleted: turnLogs.length,
    promptMode: turnLogs[0].promptMode,
    rawSystemTokens: sysTokens,
    compiledSystemTokens: turnLogs[0].systemTokens,
    systemPromptReductionPct: Number(
      (((sysTokens - turnLogs[0].systemTokens) / sysTokens) * 100).toFixed(1),
    ),
    distinctEpochsAcross100Turns: distinctEpochs,
    finalUncompactedTotalTokens: finalRawTokens,
    wouldOverflowWindowWithoutCf: finalRawTokens > modelCfg.contextWindow,
    conversationalTurns: {
      count: conversationalLogs.length,
      avgSelectedHistoryTokens: Math.round(avg(conversationalLogs, (x) => x.selectedHistoryTokens)),
      avgWirePromptTokens: Math.round(avg(conversationalLogs, (x) => x.wirePromptTokens)),
      avgCachedTokens: Math.round(avg(conversationalLogs, (x) => x.cachedTokens)),
      avgNewEvaluatedTokens: Math.round(avg(conversationalLogs, (x) => x.evaluatedPromptTokens)),
      kvCacheHitRatioPct: Number(
        (
          (avg(conversationalLogs, (x) => x.cachedTokens) /
            Math.max(1, avg(conversationalLogs, (x) => x.wirePromptTokens))) *
          100
        ).toFixed(1),
      ),
      avgPlanMs: Number(avg(conversationalLogs, (x) => x.planMs).toFixed(2)),
      avgCompileMs: Number(avg(conversationalLogs, (x) => x.compileMs).toFixed(2)),
      avgPromptEvalMs: Math.round(avg(conversationalLogs, (x) => x.promptMs)),
      avgTotalLlmLatencyMs: Math.round(avg(conversationalLogs, (x) => x.llmLatencyMs)),
      avgGenTokPerSec: Number(avg(conversationalLogs, (x) => x.predictedPerSec).toFixed(1)),
    },
    analyticalRecallTurns: {
      count: analyticalLogs.length,
      recallAccuracy: `${recallHits}/${recallTotal}`,
      avgSelectedHistoryTokens: Math.round(avg(analyticalLogs, (x) => x.selectedHistoryTokens)),
      avgQuotedEvidenceItems: Number(avg(analyticalLogs, (x) => x.quotedEvidenceItems).toFixed(1)),
      avgWirePromptTokens: Math.round(avg(analyticalLogs, (x) => x.wirePromptTokens)),
      avgCachedTokens: Math.round(avg(analyticalLogs, (x) => x.cachedTokens)),
      avgNewEvaluatedTokens: Math.round(avg(analyticalLogs, (x) => x.evaluatedPromptTokens)),
      avgPlanMs: Number(avg(analyticalLogs, (x) => x.planMs).toFixed(2)),
      avgPromptEvalMs: Math.round(avg(analyticalLogs, (x) => x.promptMs)),
      avgTotalLlmLatencyMs: Math.round(avg(analyticalLogs, (x) => x.llmLatencyMs)),
    },
    turn89Audit: turn89Log,
    sqliteStats: status,
    wikiLint: lint,
    rawAbBaseline,
    checkpointTurns: turnLogs.filter(
      (x) =>
        x.turn === 1 ||
        x.turn === 2 ||
        x.turn === 4 ||
        x.turn === 50 ||
        x.turn === 89 ||
        x.turn % 10 === 0 ||
        x.turn === 99,
    ),
  };
}

async function main() {
  const rawSystemPrompt = loadWorkspaceSystemPrompt();
  const results = [];
  const outPath =
    "benchmark-100turns-results.json";
  for (const m of MODELS) {
    const res = await runModelBenchmark(m, rawSystemPrompt);
    results.push(res);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
    );
  }
  console.log("\nALL 4 LOCAL MODEL 100-TURN BENCHMARKS COMPLETE.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
