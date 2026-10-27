import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ContextForgeStore, sha256 } from "./src/store.ts";
import { ContextForgeCompiler } from "./src/compiler.ts";
import {
  planContext,
  resolveCapabilityEnvelope,
  resolvePromptAndToolProfile,
  type EnvelopeMetadata,
  type MediaAdapter,
} from "./src/planner.ts";
import { compileDualChannelSystemPrompt, estimateTokens } from "./src/symbolic-ir.ts";
import { createContextForgeTools } from "./src/tools.ts";
import type { AcceptedMessage, JsonValue, Modality } from "./src/types.ts";

export {
  ContextForgeStore,
  ContextForgeCompiler,
  planContext,
  resolveCapabilityEnvelope,
  resolvePromptAndToolProfile,
  compileDualChannelSystemPrompt,
  createContextForgeTools,
};

export interface ContextForgePluginOptions {
  dbPath?: string;
  blobRoot?: string;
  workspaceDir?: string;
  openclawConfig?: unknown;
  maxFixedOverheadRatio?: number;
  symbolicIr?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function extractTextFromMessage(msg: unknown): string {
  const rec = asRecord(msg);
  if (typeof rec.content === "string") return rec.content;
  if (Array.isArray(rec.content)) {
    return rec.content
      .map((part) => {
        const p = asRecord(part);
        return typeof p.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Normalizes an arbitrary OpenClaw transcript message (`user`, `assistant`, `tool`, or `toolResult`)
 * into a lossless `AcceptedMessage` while preserving `toolCall`, `toolResult`, `toolCallId`,
 * `protocolGroupId`, and multimodal content blocks.
 */
export function normalizeHostMessage(
  rawMsg: unknown,
  fallbackId?: string,
  storeForMedia?: ContextForgeStore,
  sessionId?: string,
): AcceptedMessage {
  const rec = asRecord(rawMsg);
  const rawRole = typeof rec.role === "string" ? rec.role : "user";
  const role: AcceptedMessage["role"] =
    rawRole === "toolResult" || rawRole === "tool" || rec.type === "toolResult"
      ? (rawRole === "toolResult" ? "toolResult" : "tool")
      : ["user", "assistant", "system", "developer"].includes(rawRole)
        ? (rawRole as AcceptedMessage["role"])
        : "user";

  const id =
    typeof rec.id === "string" && rec.id.trim()
      ? rec.id
      : typeof rec.idempotencyKey === "string" && rec.idempotencyKey.trim()
        ? rec.idempotencyKey
        : fallbackId;

  const toolCallId =
    typeof rec.toolCallId === "string" && rec.toolCallId.trim()
      ? rec.toolCallId
      : typeof rec.callId === "string" && rec.callId.trim()
        ? rec.callId
        : undefined;

  let content: JsonValue = "";
  if (typeof rec.content === "string") {
    content = rec.content;
  } else if (Array.isArray(rec.content)) {
    // If historical message contains inline base64 media blocks, offload them to CAS media sources
    // and replace the inline replay block with a lightweight source reference so planner.ts
    // can hydrate them on demand via MediaAdapter without tripping HistoricalMediaRequiresAdapter.
    const mappedParts: JsonValue[] = [];
    for (const part of rec.content) {
      const p = asRecord(part);
      const partType = typeof p.type === "string" ? p.type : "";
      if (["image", "audio", "video", "document"].includes(partType) && storeForMedia) {
        const mimeType =
          typeof p.mimeType === "string"
            ? p.mimeType
            : partType === "image"
              ? "image/png"
              : partType === "audio"
                ? "audio/mpeg"
                : partType === "video"
                  ? "video/mp4"
                  : "application/pdf";
        const dataStr = typeof p.data === "string" ? p.data : "";
        const bytes = dataStr ? Buffer.from(dataStr, "base64") : Buffer.from("");
        const originKey = `${sessionId ?? "session"}/media/${sha256(bytes).slice(0, 16)}`;
        const mediaSource = storeForMedia.ingestSource({
          sessionId,
          kind: partType === "document" ? "document" : "media",
          originSystem: "host-media",
          originKey,
          role: role === "toolResult" ? "tool" : role,
          bytes,
          mimeType,
        });
        mappedParts.push({
          type: "text",
          text: `[Attached ${partType} source=${mediaSource.sourceId} mime=${mimeType}]`,
        });
      } else {
        mappedParts.push((part ?? null) as JsonValue);
      }
    }
    content = mappedParts;
  } else if (rec.content !== undefined && rec.content !== null) {
    content = JSON.parse(JSON.stringify(rec.content)) as JsonValue;
  }

  const out: AcceptedMessage = {
    ...(id ? { id } : {}),
    role,
    content,
    ...(typeof rec.timestamp === "number"
      ? { observedAt: rec.timestamp }
      : typeof rec.observedAt === "number"
        ? { observedAt: rec.observedAt }
        : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof rec.protocolGroupId === "string" ? { protocolGroupId: rec.protocolGroupId } : {}),
  };

  if (Array.isArray(rec.toolCalls)) {
    out.toolCalls = JSON.parse(JSON.stringify(rec.toolCalls)) as JsonValue;
  }
  return out;
}

/**
 * Looks up configured model capabilities (contextWindow, maxTokens, input modalities)
 * from OpenClaw's live configuration (`openclaw.json` or passed `config`).
 */
export function lookupOpenClawModelSpec(params: {
  provider?: string | null;
  modelId?: string | null;
  openclawConfig?: unknown;
}): {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Modality[];
} {
  let cfg = asRecord(params.openclawConfig);
  if (Object.keys(cfg).length === 0) {
    try {
      const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
      const cfgPath = path.join(stateDir, "openclaw.json");
      if (fs.existsSync(cfgPath)) {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      }
    } catch {
      // Ignore config read errors and use runtimeSettings
    }
  }

  const rawModel = String(params.modelId ?? "").trim();
  const slashIdx = rawModel.indexOf("/");
  const inferredProvider = slashIdx > 0 ? rawModel.slice(0, slashIdx) : undefined;
  const bareModelId = slashIdx > 0 ? rawModel.slice(slashIdx + 1) : rawModel;
  const providerId = String(params.provider || inferredProvider || "openclaw-runtime").trim();

  const modelsCfg = asRecord(cfg.models);
  const providersCfg = asRecord(modelsCfg.providers);

  for (const [provKey, provVal] of Object.entries(providersCfg)) {
    const pRec = asRecord(provVal);
    const list = Array.isArray(pRec.models) ? pRec.models : [];
    for (const entry of list) {
      const mRec = asRecord(entry);
      const id = String(mRec.id ?? "").trim();
      if (!id) continue;
      if (
        id.toLowerCase() === bareModelId.toLowerCase() ||
        id.toLowerCase() === rawModel.toLowerCase()
      ) {
        const cw =
          typeof mRec.contextWindow === "number" && mRec.contextWindow > 0
            ? mRec.contextWindow
            : undefined;
        const mt =
          typeof mRec.maxTokens === "number" && mRec.maxTokens > 0 ? mRec.maxTokens : undefined;
        const inp =
          Array.isArray(mRec.input) &&
          mRec.input.every((x) => ["text", "image", "audio", "video"].includes(String(x)))
            ? (mRec.input as Modality[])
            : undefined;
        return {
          providerId: provKey,
          modelId: id,
          contextWindow: cw,
          maxTokens: mt,
          input: inp,
        };
      }
    }
  }

  return {
    providerId,
    modelId: bareModelId || "active-model",
  };
}

/**
 * Loads the workspace's actual `SOUL.md` and operational instruction files (`AGENTS.md`, `USER.md`)
 * so both `planContext()` and the `before_prompt_build` hook operate on real workspace directives
 * rather than placeholder strings.
 */
export function loadWorkspaceSystemPrompt(workspaceDir?: string): string {
  const dir =
    workspaceDir ||
    process.env.OPENCLAW_WORKSPACE_DIR ||
    path.join(os.homedir(), ".openclaw", "workspace");
  const sections: string[] = [];
  for (const name of ["SOUL.md", "AGENTS.md", "USER.md"]) {
    const filePath = path.join(dir, name);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) {
          sections.push(`## ${filePath}\n${content}`);
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }
  return sections.length > 0
    ? sections.join("\n\n")
    : "# SOUL.md - Who You Are\nBe genuinely helpful, candid, and accurate.";
}

/**
 * Normalizes OpenClaw runtime settings and model metadata into a strict
 * model-agnostic CapabilityEnvelope without hardcoding cloud vs local names.
 */
export function buildEnvelopeFromOpenClawRuntime(params: {
  tokenBudget?: number;
  model?: string;
  runtimeSettings?: unknown;
  runtimeContext?: unknown;
  openclawConfig?: unknown;
  availableToolsCount?: number;
  systemTokens?: number;
  toolSchemaTokens?: number;
  pendingInputTokens?: number;
}): EnvelopeMetadata {
  const rs = asRecord(params.runtimeSettings);
  const rc = asRecord(params.runtimeContext);
  const limits = asRecord(rs.limits);
  const modelMeta = asRecord(rs.model);

  const spec = lookupOpenClawModelSpec({
    provider: String(modelMeta.provider ?? rc.provider ?? ""),
    modelId: String(params.model ?? modelMeta.resolved ?? modelMeta.requested ?? rc.modelId ?? ""),
    openclawConfig: params.openclawConfig,
  });

  const hostTokenBudget =
    typeof params.tokenBudget === "number" && Number.isSafeInteger(params.tokenBudget) && params.tokenBudget > 0
      ? params.tokenBudget
      : typeof limits.promptTokenBudget === "number" &&
          Number.isSafeInteger(limits.promptTokenBudget) &&
          limits.promptTokenBudget > 0
        ? (limits.promptTokenBudget as number)
        : typeof rc.tokenBudget === "number" &&
            Number.isSafeInteger(rc.tokenBudget) &&
            rc.tokenBudget > 0
          ? (rc.tokenBudget as number)
          : spec.contextWindow ?? 65536;

  const maxOutputTokens =
    typeof limits.maxOutputTokens === "number" &&
    Number.isSafeInteger(limits.maxOutputTokens) &&
    limits.maxOutputTokens > 0
      ? (limits.maxOutputTokens as number)
      : spec.maxTokens ?? 4096;

  const nativeContextTokens = Math.max(
    typeof rc.modelContextWindow === "number" && rc.modelContextWindow > 0
      ? (rc.modelContextWindow as number)
      : spec.contextWindow ?? 0,
    hostTokenBudget + maxOutputTokens,
    hostTokenBudget,
  );

  const modalitiesRaw = modelMeta.input ?? spec.input;
  const input: Modality[] =
    Array.isArray(modalitiesRaw) &&
    modalitiesRaw.length > 0 &&
    modalitiesRaw.every((m) => ["text", "image", "audio", "video"].includes(String(m)))
      ? (modalitiesRaw as Modality[])
      : ["text"];

  const estimatedToolTokens =
    params.toolSchemaTokens ??
    (typeof params.availableToolsCount === "number" && params.availableToolsCount > 0
      ? Math.max(400, params.availableToolsCount * 95)
      : 800);

  return {
    providerId: spec.providerId,
    modelId: spec.modelId,
    input,
    nativeContextTokens,
    deploymentContextTokens: nativeContextTokens,
    hostTokenBudget,
    hostBudgetScope: "history_only",
    outputReserveTokens: maxOutputTokens,
    reasoningReserveTokens: 0,
    systemTokens: params.systemTokens ?? 1200,
    toolSchemaTokens: estimatedToolTokens,
    framingTokens: 64,
    pendingInputTokens: params.pendingInputTokens ?? 256,
    safetyMarginTokens: 256,
    nativeDocumentMimeTypes: ["application/pdf"],
  };
}

const defaultMediaAdapter: MediaAdapter = {
  version: "openclaw-media-adapter-v1",
  estimate(artifact) {
    if (artifact.mimeType.startsWith("image/")) {
      return { tokens: 258, estimateKind: "heuristic" };
    }
    if (artifact.mimeType.startsWith("audio/")) {
      const durMs = Number(artifact.asset.durationMs ?? artifact.metadata.durationMs ?? 10000);
      return { tokens: Math.max(64, Math.ceil((durMs / 1000) * 32)), estimateKind: "heuristic" };
    }
    if (artifact.mimeType.startsWith("video/")) {
      const durMs = Number(artifact.asset.durationMs ?? artifact.metadata.durationMs ?? 5000);
      return { tokens: Math.max(256, Math.ceil((durMs / 1000) * 260)), estimateKind: "heuristic" };
    }
    return { tokens: 512, estimateKind: "heuristic" };
  },
};

/**
 * Creates a standalone or OpenClaw-registered ContextForge v2 engine instance.
 */
export function createContextForgeEngine(options: ContextForgePluginOptions = {}) {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw", "state");
  const dbPath = options.dbPath || path.join(stateDir, "contextforge.sqlite");
  const store = new ContextForgeStore({
    dbPath,
    blobRoot: options.blobRoot,
  });
  const compiler = new ContextForgeCompiler(store);
  const maxFixedOverheadRatio = options.maxFixedOverheadRatio ?? 0.15;
  const symbolicIr = options.symbolicIr !== false;
  const workspaceSystemPrompt = loadWorkspaceSystemPrompt(options.workspaceDir);

  return {
    store,
    compiler,
    info: {
      id: "contextforge" as const,
      name: "ContextForge Native",
      version: "2.0.0",
      ownsCompaction: true,
      acceptedHostParams: [
        "sessionKey",
        "prompt",
        "runtimeSettings",
        "sessionTarget",
        "runtimeContext",
        "abortSignal",
      ] as const,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1" as const,
        turnAdvancementIdempotency: "atomic-idempotent-v1" as const,
      },
      turnMaintenanceMode: "background" as const,
    },

    async bootstrap(params: {
      sessionId?: string;
      sessionKey?: string;
      runtimeSettings?: unknown;
      runtimeContext?: unknown;
    }) {
      const sessionId = String(params.sessionId || params.sessionKey || "default-session");
      store.ensureSession(sessionId);
      return { bootstrapped: true };
    },

    async ingest(params: {
      sessionId?: string;
      sessionKey?: string;
      message: unknown;
      isHeartbeat?: boolean;
    }) {
      if (params.isHeartbeat) return { ingested: false };
      const sessionId = String(params.sessionId || params.sessionKey || "default-session");
      const rawMsg = asRecord(params.message);
      const normalized = normalizeHostMessage(
        rawMsg,
        `msg-${randomUUID()}`,
        store,
        sessionId,
      );
      const hasText = extractTextFromMessage(normalized).trim().length > 0;
      const hasToolCalls = Array.isArray(normalized.toolCalls) && normalized.toolCalls.length > 0;
      const hasContentArray = Array.isArray(normalized.content) && normalized.content.length > 0;
      if (!hasText && !hasToolCalls && !hasContentArray) return { ingested: false };

      const advKey = `ingest:${sessionId}:${String(normalized.id ?? randomUUID())}`;
      store.commitTurn({
        sessionId,
        advancementKey: advKey,
        messages: [normalized],
      });
      compiler.compilePending();
      return { ingested: true };
    },

    async ingestBatch(params: {
      sessionId?: string;
      sessionKey?: string;
      messages: unknown[];
      isHeartbeat?: boolean;
    }) {
      if (params.isHeartbeat || !Array.isArray(params.messages) || params.messages.length === 0) {
        return { ingestedCount: 0 };
      }
      const sessionId = String(params.sessionId || params.sessionKey || "default-session");
      const batchId = `batch:${sessionId}:${Date.now()}:${randomUUID()}`;
      const normalized = params.messages.map((m, idx) =>
        normalizeHostMessage(m, `${batchId}:${idx}`, store, sessionId),
      );
      store.commitTurn({
        sessionId,
        advancementKey: batchId,
        messages: normalized,
      });
      compiler.compilePending();
      return { ingestedCount: normalized.length };
    },

    /**
     * OpenClaw's durable outbox (`context-engine-turn-outbox`) requires `{ status: "committed" | "duplicate" }`.
     */
    async commitTurn(params: {
      sessionId?: string;
      sessionKey?: string;
      advancementKey: string;
      messages: unknown[];
      isHeartbeat?: boolean;
    }): Promise<{ status: "committed" | "duplicate" }> {
      const sessionId = String(params.sessionId || params.sessionKey || "default-session");
      const normalized = (Array.isArray(params.messages) ? params.messages : []).map((m, idx) =>
        normalizeHostMessage(m, `${params.advancementKey}:${idx}`, store, sessionId),
      );
      const status = store.commitTurn({
        sessionId,
        advancementKey: params.advancementKey,
        messages: normalized,
      });
      if (status === "committed") {
        compiler.compilePending();
      }
      return { status };
    },

    async assemble(params: {
      sessionId?: string;
      sessionKey?: string;
      messages: unknown[];
      tokenBudget?: number;
      availableTools?: Set<string> | string[];
      citationsMode?: string;
      model?: string;
      prompt?: string;
      runtimeSettings?: unknown;
      runtimeContext?: unknown;
      abortSignal?: AbortSignal;
    }) {
      const sessionId = String(params.sessionId || params.sessionKey || "default-session");
      const rawMessages = Array.isArray(params.messages) ? params.messages : [];
      const normalizedMessages = rawMessages.map((m, idx) =>
        normalizeHostMessage(m, `hist:${sessionId}:${idx}`, store, sessionId),
      );

      const latestText =
        typeof params.prompt === "string" && params.prompt.trim()
          ? params.prompt.trim()
          : normalizedMessages.length > 0
            ? extractTextFromMessage(normalizedMessages[normalizedMessages.length - 1])
            : "";

      // Ensure any unindexed historical messages passed in `params.messages` are committed
      // Only perform initial historical bootstrap sync if the session has zero prior occurrences.
      // Once bootstrapped, OpenClaw's durable turn outbox (`commitTurn`) is the sole writer for
      // closed turns so in-flight steps never collide with `commitTurn`.
      const existingOccurrences = store.occurrenceCount(sessionId);
      if (existingOccurrences === 0 && normalizedMessages.length > 0) {
        let turnIndex = 0;
        let currentTurn: AcceptedMessage[] = [];
        const flushSlice = (slice: AcceptedMessage[], tIdx: number) => {
          if (slice.length === 0) return;
          const syncKey = `bootstrap-sync:${sessionId}:t${tIdx}:${sha256(JSON.stringify(slice.map((m) => m.id ?? m.role))).slice(0, 12)}`;
          try {
            store.commitTurn({
              sessionId,
              advancementKey: syncKey,
              messages: slice,
            });
          } catch {
            // Already committed; safe to continue
          }
        };
        for (const msg of normalizedMessages) {
          if (msg.role === "user" && currentTurn.length > 0) {
            flushSlice(currentTurn, turnIndex++);
            currentTurn = [msg];
          } else {
            currentTurn.push(msg);
          }
        }
        flushSlice(currentTurn, turnIndex);
        compiler.compilePending();
      }

      const availableToolsList =
        params.availableTools instanceof Set
          ? [...params.availableTools]
          : Array.isArray(params.availableTools)
            ? params.availableTools.map(String)
            : [];

      const envelopeMeta = buildEnvelopeFromOpenClawRuntime({
        tokenBudget: params.tokenBudget,
        model: params.model,
        runtimeSettings: params.runtimeSettings,
        runtimeContext: params.runtimeContext,
        openclawConfig: options.openclawConfig,
        availableToolsCount: availableToolsList.length,
        systemTokens: estimateTokens(workspaceSystemPrompt),
        pendingInputTokens: Math.max(64, estimateTokens(latestText)),
      });

      const plan = planContext({
        store,
        sessionId,
        admissionId: `turn:${Date.now()}:${randomUUID()}`,
        query: latestText || "continue conversation",
        envelope: envelopeMeta,
        rawSystemPrompt: workspaceSystemPrompt,
        symbolicIr,
        maxFixedOverheadRatio,
        tools: availableToolsList.map((name) => ({
          name,
          required: ["read", "write", "edit", "exec", "cf_recall", "cf_remember", "cf_status"].includes(name),
          capabilities: name.startsWith("cf_") || name.startsWith("memory_") ? ["memory"] : ["general"],
        })),
        mediaAdapter: defaultMediaAdapter,
        abortSignal: params.abortSignal,
      });

      // Surface active L3 Permanent Context rules in systemPromptAddition, and when
      // promptMode === 'slim-domain', also surface the compiled Dual-Channel Symbolic IR
      // (`<compiled_rules_ir>`) in systemPromptAddition so local/smaller-window models
      // always receive it even if OpenClaw's core system-prompt builder runs after hooks.
      const l3Nodes = store.listPermanentContext();
      const additionSections: string[] = [];
      if (l3Nodes.length > 0) {
        additionSections.push(
          "## ContextForge L3 Permanent Context",
          ...l3Nodes.map((n) => `### ${n.title} (${n.logicalKey})\n${n.body}`),
        );
      }
      if (plan.receipt.profile.promptMode === "slim-domain" && symbolicIr) {
        const compiled = compileDualChannelSystemPrompt({
          rawSystemPrompt: workspaceSystemPrompt,
          symbolicIr: true,
        });
        additionSections.push(
          `## ContextForge Slim-Domain Symbolic IR (fixedOverhead=${plan.receipt.capabilityEnvelope.systemTokens}/${plan.receipt.capabilityEnvelope.nativeContextTokens} tokens > ${Math.round(maxFixedOverheadRatio * 100)}%)`,
          compiled.symbolicRulesIr || compiled.compiledSystemPrompt,
        );
      }
      const systemPromptAddition =
        additionSections.length > 0 ? additionSections.join("\n\n") : undefined;

      return {
        messages: plan.messages.filter((m) => m.role !== "system" && m.role !== "developer"),
        estimatedTokens: plan.estimatedTokens,
        promptAuthority: "assembled" as const,
        ...(systemPromptAddition ? { systemPromptAddition } : {}),
        receipt: plan.receipt,
      };
    },

    async compact() {
      // ContextForge owns compaction via per-turn elastic assembly; no blocking summary pass needed.
      return { ok: true, compacted: false };
    },

    async maintain() {
      const compiled = compiler.compilePending();
      return {
        changed: compiled.nodeIds.length > 0,
        bytesFreed: 0,
        rewrittenEntries: 0,
      };
    },

    dispose() {
      store.close();
    },
  };
}

/**
 * Standard OpenClaw plugin entry point.
 */
export default {
  id: "contextforge-native",
  name: "ContextForge v2 Native Engine",
  description:
    "Model-agnostic SQLite context engine with source-backed L0-L3 Wiki compilation, multimodal CAS hydration, and Dual-Channel Symbolic IR prompt compression.",
  kind: "context-engine" as const,
  register(api: any) {
    const rawCfg = asRecord(api?.pluginConfig);
    let sharedEngine: ReturnType<typeof createContextForgeEngine> | null = null;

    const getOrCreateEngine = (factoryCtx?: any) => {
      if (!sharedEngine) {
        const ctxRec = asRecord(factoryCtx);
        sharedEngine = createContextForgeEngine({
          dbPath: typeof rawCfg.dbPath === "string" ? rawCfg.dbPath : undefined,
          blobRoot: typeof rawCfg.blobRoot === "string" ? rawCfg.blobRoot : undefined,
          workspaceDir:
            typeof ctxRec.workspaceDir === "string" ? ctxRec.workspaceDir : undefined,
          openclawConfig: ctxRec.config ?? api?.config,
          maxFixedOverheadRatio:
            typeof rawCfg.maxFixedOverheadRatio === "number" ? rawCfg.maxFixedOverheadRatio : 0.15,
          symbolicIr: typeof rawCfg.symbolicIr === "boolean" ? rawCfg.symbolicIr : true,
        });
      }
      return sharedEngine;
    };

    if (typeof api?.registerContextEngine === "function") {
      api.registerContextEngine("contextforge", (factoryCtx: any) => {
        const eng = getOrCreateEngine(factoryCtx);
        // Return a turn-leased wrapper whose dispose() does not close the shared SQLite handle
        return {
          ...eng,
          dispose() {
            // Keep shared SQLite connection open across turn leases
          },
        };
      });
    }

    if (typeof api?.registerTool === "function") {
      api.registerTool(
        (ctx: any) => {
          const eng = getOrCreateEngine(ctx);
          return createContextForgeTools(() => ({ store: eng.store, compiler: eng.compiler }), ctx);
        },
        {
          names: [
            "cf_recall",
            "cf_remember",
            "cf_permanent",
            "cf_ingest",
            "cf_wiki_lint",
            "cf_status",
          ],
        },
      );
    }

    if (typeof api?.on === "function") {
      api.on("before_prompt_build", async (event: any, hookCtx: any) => {
        const ev = asRecord(event);
        const hCtx = asRecord(hookCtx);
        const ratio =
          typeof rawCfg.maxFixedOverheadRatio === "number" ? rawCfg.maxFixedOverheadRatio : 0.15;
        const symbolicIrEnabled = rawCfg.symbolicIr !== false;
        if (!symbolicIrEnabled) return;

        // Resolve the active model's true context window from hookCtx or event
        const spec = lookupOpenClawModelSpec({
          provider: String(hCtx.modelProviderId ?? ""),
          modelId: String(hCtx.modelId ?? ""),
          openclawConfig: api?.config,
        });

        const windowTokens =
          typeof ev.contextTokens === "number" && ev.contextTokens > 0
            ? ev.contextTokens
            : typeof hCtx.contextWindowReferenceTokens === "number" &&
                hCtx.contextWindowReferenceTokens > 0
              ? hCtx.contextWindowReferenceTokens
              : typeof hCtx.contextTokenBudget === "number" && hCtx.contextTokenBudget > 0
                ? hCtx.contextTokenBudget
                : spec.contextWindow ?? 65536;

        const rawSysPrompt =
          typeof ev.systemPrompt === "string" && ev.systemPrompt.trim()
            ? ev.systemPrompt
            : loadWorkspaceSystemPrompt(
                typeof hCtx.workspaceDir === "string" ? hCtx.workspaceDir : undefined,
              );

        const sysTokens = estimateTokens(rawSysPrompt);

        // Model-agnostic overhead rule: if fixed system prompt exceeds ratio of model window,
        // compile operational rules to Symbolic IR while keeping Persona/SOUL.md in natural prose.
        if (sysTokens > windowTokens * ratio) {
          const compiled = compileDualChannelSystemPrompt({
            rawSystemPrompt: rawSysPrompt,
            symbolicIr: true,
          });
          return {
            prependSystemContext: compiled.symbolicRulesIr || compiled.compiledSystemPrompt,
          };
        }
        return;
      });
    }
  },
};
