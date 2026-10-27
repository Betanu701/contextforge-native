import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pluginEntry, { createContextForgeEngine } from "../index.ts";
import { createContextForgeTools } from "../src/tools.ts";

test("OpenClaw plugin entry registers contextforge engine, 6 cf_* tools, and before_prompt_build Symbolic IR hook", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-plugin-test-"));
  const dbPath = path.join(tmpDir, "contextforge.sqlite");

  let registeredEngineId = "";
  let registeredEngineFactory: (() => any) | null = null;
  let registeredToolNames: string[] = [];
  let registeredHookName = "";
  let registeredHookFn: ((event: any) => Promise<any>) | null = null;

  pluginEntry.register({
    pluginConfig: {
      dbPath,
      maxFixedOverheadRatio: 0.15,
      symbolicIr: true,
    },
    registerContextEngine(id: string, factory: () => any) {
      registeredEngineId = id;
      registeredEngineFactory = factory;
    },
    registerTool(_factory: any, meta: { names: string[] }) {
      registeredToolNames = meta.names;
    },
    on(hookName: string, fn: (event: any) => Promise<any>) {
      registeredHookName = hookName;
      registeredHookFn = fn;
    },
  });

  assert.equal(registeredEngineId, "contextforge");
  assert.ok(registeredEngineFactory);
  assert.deepEqual(registeredToolNames, [
    "cf_recall",
    "cf_remember",
    "cf_permanent",
    "cf_ingest",
    "cf_wiki_lint",
    "cf_status",
  ]);
  assert.equal(registeredHookName, "before_prompt_build");
  assert.ok(registeredHookFn);

  const engine = registeredEngineFactory!();
  assert.equal(engine.info.id, "contextforge");
  assert.equal(engine.info.ownsCompaction, true);
  assert.equal(engine.info.transcriptSemantics.currentTurnFence, "before-current-turn-entry-v1");
  assert.equal(
    engine.info.transcriptSemantics.turnAdvancementIdempotency,
    "atomic-idempotent-v1",
  );

  // Test compact() is a zero-latency no-op
  const compactRes = await engine.compact();
  assert.deepEqual(compactRes, { ok: true, compacted: false });

  // Test before_prompt_build hook automatically engages Dual-Channel Symbolic IR when prompt > 15% of window
  const largePrompt = [
    "# SOUL.md - Who You Are",
    "**Name:** Edith",
    "## Vibe",
    "Calm, sharp, warm, and understated.",
    "## Directives",
    ...Array.from(
      { length: 80 },
      (_, i) =>
        `- Always verify rule number ${i + 1} before making configuration changes so nothing breaks in production.`,
    ),
  ].join("\n");

  const smallWindowHookRes = await registeredHookFn!({
    systemPrompt: largePrompt,
    contextTokens: 4096, // 15% of 4096 = 614 tokens; largePrompt > 1000 tokens -> triggers Symbolic IR
  });
  assert.ok(smallWindowHookRes?.prependSystemContext);
  assert.match(smallWindowHookRes.prependSystemContext, /<compiled_rules_ir>/);
  assert.ok(smallWindowHookRes.prependSystemContext.length < largePrompt.length);

  // On a huge 1M window, 1200 tokens is < 15% so it leaves the prompt untouched
  const hugeWindowHookRes = await registeredHookFn!({
    systemPrompt: largePrompt,
    contextTokens: 1000000,
  });
  assert.equal(hugeWindowHookRes, undefined);

  engine.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("End-to-end cf_* tools and engine.assemble() lifecycle", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-e2e-test-"));
  const dbPath = path.join(tmpDir, "contextforge.sqlite");
  const engine = createContextForgeEngine({ dbPath });
  const tools = createContextForgeTools(
    () => ({ store: engine.store, compiler: engine.compiler }),
    { sessionId: "sess-e2e-1" },
  );
  const byName = new Map(tools.map((t) => [t.name, t]));

  // 1. Set L3 Permanent Context via cf_permanent
  const permRes = await byName.get("cf_permanent")!.execute("call-1", {
    action: "set",
    key: "coaching-rules",
    title: "Coaching Rules",
    body: "Always subtract consecutive cumulative scale gram weights.",
    priority: 100,
  });
  assert.match(permRes.content[0].text, /Set L3 Permanent Context/);

  // 2. Store a cumulative scale reading via cf_remember
  const remRes = await byName.get("cf_remember")!.execute("call-2", {
    statement: "cumulative scale: 104g chili, 130g cheese, 152g sour cream",
    kind: "raw",
    originKey: "lunch-scale",
  });
  assert.match(remRes.content[0].text, /Stored source/);

  // 3. Recall via cf_recall and verify exact subtracted net weights (26g cheese, 22g sour cream)
  const recallRes = await byName.get("cf_recall")!.execute("call-3", {
    query: "cheese",
  });
  assert.match(recallRes.content[0].text, /26/);

  // 4. Ingest a document via cf_ingest
  const ingestRes = await byName.get("cf_ingest")!.execute("call-4", {
    text: "# Architecture Spec\nDecision: ContextForge uses built-in node:sqlite in WAL mode.",
    originKey: "arch-spec.md",
  });
  assert.match(ingestRes.content[0].text, /Ingested source/);

  // 5. Lint wiki via cf_wiki_lint
  const lintRes = await byName.get("cf_wiki_lint")!.execute("call-5", {});
  assert.match(lintRes.content[0].text, /ok=true, provenanceGaps=0/);

  // 6. Run engine.assemble() on a 32k model budget and verify assembled messages + receipt
  // Also include an OpenClaw-style toolResult message and a live model lookup test
  const commitRes = await engine.commitTurn({
    sessionId: "sess-e2e-1",
    advancementKey: "turn-1",
    messages: [
      {
        id: "m-user-1",
        role: "user",
        content: "Run a quick check on arch-spec.md",
      },
      {
        id: "m-asst-1",
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-99", name: "cf_recall", arguments: { query: "SQLite" } }],
      },
      {
        id: "m-tool-1",
        role: "toolResult",
        toolCallId: "tc-99",
        content: [{ type: "text", text: "Decision: ContextForge uses built-in node:sqlite in WAL mode." }],
      },
    ],
  });
  assert.deepEqual(commitRes, { status: "committed" });
  const duplicateCommitRes = await engine.commitTurn({
    sessionId: "sess-e2e-1",
    advancementKey: "turn-1",
    messages: [
      {
        id: "m-user-1",
        role: "user",
        content: "Run a quick check on arch-spec.md",
      },
      {
        id: "m-asst-1",
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-99", name: "cf_recall", arguments: { query: "SQLite" } }],
      },
      {
        id: "m-tool-1",
        role: "toolResult",
        toolCallId: "tc-99",
        content: [{ type: "text", text: "Decision: ContextForge uses built-in node:sqlite in WAL mode." }],
      },
    ],
  });
  assert.deepEqual(duplicateCommitRes, { status: "duplicate" });

  const assembled = await engine.assemble({
    sessionId: "sess-e2e-1",
    messages: [],
    tokenBudget: 32768,
    availableTools: new Set(["read", "write", "cf_recall", "cf_remember"]),
    model: "llamacpp/gemma-4-26B-A4B-it-UD-IQ4_XS.gguf",
    prompt: "Compare our arch-spec.md decision and explain why.",
  });
  assert.equal(assembled.promptAuthority, "assembled");
  assert.ok(assembled.messages.length >= 2);
  assert.ok(assembled.systemPromptAddition?.includes("Coaching Rules"));
  assert.equal(assembled.receipt.disposition, "admitted");

  // 7. Check cf_status
  const statusRes = await byName.get("cf_status")!.execute("call-6", {
    sessionId: "sess-e2e-1",
  });
  assert.match(statusRes.content[0].text, /Latest Plan Receipt/);

  // 8. Verify Turn 89 recall from Turn 1 & Turn 4 after 84 noisy turns, with 1 stable Epoch
  for (let t = 2; t <= 88; t++) {
    await engine.commitTurn({
      sessionId: "sess-e2e-1",
      advancementKey: `turn-${t}`,
      messages: [
        { id: `u-${t}`, role: "user", content: `[Turn ${t}] Routine status check.` },
        { id: `a-${t}`, role: "assistant", content: "Status nominal. " + "metric=ok ".repeat(30) },
      ],
    });
  }
  const assembled89 = await engine.assemble({
    sessionId: "sess-e2e-1",
    messages: [],
    tokenBudget: 32768,
    availableTools: new Set(["read", "write", "cf_recall", "cf_remember"]),
    model: "llamacpp/gemma-4-26B-A4B-it-UD-IQ4_XS.gguf",
    prompt: "From our earlier turns, how many net grams of cheese and sour cream were added on the lunch scale, and what was our arch-spec.md decision?",
  });
  const text89 = JSON.stringify(assembled89.messages);
  assert.match(text89, /26 g/);
  assert.match(text89, /22 g/);
  assert.match(text89, /node:sqlite in WAL mode/);
  assert.ok(assembled89.messages.every((m: any) => m.role !== "system" && m.role !== "developer"));
  const epochCount = engine.store.db.prepare("SELECT COUNT(*) AS c FROM epochs WHERE session_id=?").get("sess-e2e-1")!.c;
  assert.equal(epochCount, 1);

  engine.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
