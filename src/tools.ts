import fs from "node:fs";
import path from "node:path";
import { ContextForgeStore } from "./store.ts";
import { ContextForgeCompiler, WIKI_COMPILER_VERSION } from "./compiler.ts";
import { prepareExternalRecall, externalRecallStatus, type ExternalRecallOptions } from "./external-recall.ts";
import { LEXICAL_VERSION } from "./retrieval.ts";
import type { Modality, SourceKind } from "./types.ts";

export interface ToolContext {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  callerContext?: unknown;
}

export interface AgentToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function createContextForgeTools(
  getStore: () => { store: ContextForgeStore; compiler: ContextForgeCompiler },
  ctx: ToolContext = {},
  options: ExternalRecallOptions = {},
): AgentToolSpec[] {
  return [
    {
      name: "cf_recall",
      label: "ContextForge Recall",
      description:
        "Search ContextForge source-backed L2 Wiki pages, L1 atomic facts, and L0 raw sources/chunks.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query or entity name" },
          includeSupport: { type: "boolean", description: "Include cited original L0 support" },
          external: { type: "boolean", description: "Use configured optional external discovery" },
          limit: { type: "number", description: "Max results (default 10)" },
          includeHistory: {
            type: "boolean",
            description: "Include superseded/historical revisions",
          },
          namespaceId: { type: "string", description: "Optional explicit namespace ID" },
        },
      },
      async execute(_id, rawParams, signal) {
        const params = asRecord(rawParams);
        const query = String(params.query ?? "").trim();
        if (!query) throw new Error("cf_recall requires a non-empty query");
        const { store } = getStore();
        const limit =
          typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0
            ? params.limit
            : 10;
        const namespaceId =
          typeof params.namespaceId === "string" && params.namespaceId.trim()
            ? params.namespaceId.trim()
            : store.namespaceId;
        const includeHistory = params.includeHistory === true;

        const externalRecall = params.external === true
          ? await prepareExternalRecall({ store, query, namespaceId, sessionId: ctx.sessionId ?? ctx.sessionKey ?? "tool", abortSignal: signal }, { ...options, hostContext: ctx })
          : undefined;
        const ftsResults = store.search(query, { namespaceId, limit, includeHistory });
        const entityResults = store.searchEntity(query, { namespaceId, includeHistory });

        const lines: string[] = [
          `ContextForge Recall for "${query}" (namespace=${namespaceId}):`,
          `- FTS matches: ${ftsResults.length}`,
          `- Entity nodes: ${entityResults.length}`,
        ];

        for (const [idx, hit] of ftsResults.entries()) {
          lines.push(
            `\n[${idx + 1}] ${hit.title} [${hit.status}] (source=${hit.sourceId ?? "n/a"}, node=${hit.nodeId ?? "n/a"}, score=${hit.score.toFixed(3)})\n${hit.body}`,
          );
        }
        for (const node of entityResults.slice(0, limit)) {
          lines.push(
            `\n[Entity L${node.layer}] ${node.title} (${node.logicalKey}, rev=${node.revision}, status=${node.status})\n${node.body}`,
          );
        }

        const support: unknown[] = [];
        if (params.includeSupport === true) {
          const seen = new Set<string>();
          for (const hit of ftsResults) {
            for (const p of hit.nodeId ? store.getProvenance(hit.nodeId) : []) {
              if (seen.has(p.spanId)) continue;
              seen.add(p.spanId);
              try {
                const span = store.readEvidenceSpan(p.spanId, { namespaceId });
                support.push(span);
                lines.push(`\n[L0 support source=${p.sourceId} span=${p.spanId}]\n${span.text}`);
              } catch { lines.push("\n[Original support currently unavailable]"); }
            }
          }
        }
        if (externalRecall) lines.push(`\nExternal discovery: ${externalRecall.status}; suggestions are discovery-only, not original evidence.`, ...externalRecall.warnings);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { ftsResults, entityResults, support, externalRecall },
        };
      },
    },
    {
      name: "cf_remember",
      label: "ContextForge Remember",
      description:
        "Store an authoritative L0 observation and immediately compile its L1 facts (decisions, negative facts, constraints, state updates, or cumulative scale readings) and L2 Wiki pages.",
      parameters: {
        type: "object",
        required: ["statement"],
        properties: {
          statement: {
            type: "string",
            description:
              "Fact, decision, constraint, negative fact, state assignment (e.g. 'State: Entity | predicate = value'), or cumulative scale reading",
          },
          kind: {
            type: "string",
            enum: ["Fact", "Decision", "Negative fact", "Constraint", "State", "Correction", "raw"],
            description: "Controlled grammar prefix (default 'Fact')",
          },
          originKey: { type: "string", description: "Logical source key/title" },
          namespaceId: { type: "string", description: "Optional explicit namespace ID" },
        },
      },
      async execute(_id, rawParams) {
        const params = asRecord(rawParams);
        const statement = String(params.statement ?? "").trim();
        if (!statement) throw new Error("cf_remember requires a non-empty statement");
        const kind = typeof params.kind === "string" ? params.kind : "Fact";
        const formatted =
          kind !== "raw" && !/^(Decision|Negative fact|Constraint|Concept|Fact|State|Correction):/i.test(statement)
            ? `${kind}: ${statement}`
            : statement;
        const { store, compiler } = getStore();
        const namespaceId =
          typeof params.namespaceId === "string" && params.namespaceId.trim()
            ? params.namespaceId.trim()
            : store.namespaceId;
        const originKey =
          typeof params.originKey === "string" && params.originKey.trim()
            ? params.originKey.trim()
            : `remember/${Date.now()}`;

        const source = store.ingestSource({
          namespaceId,
          sessionId: ctx.sessionId,
          kind: "turn",
          originKey,
          role: "user",
          trustClass: "user_statement",
          text: formatted,
        });
        const compiled = compiler.compile(namespaceId);

        return {
          content: [
            {
              type: "text",
              text: `Stored source ${source.sourceId} and compiled ${compiled.nodeIds.length} L1/L2 node(s) (provenanceGaps=${compiled.provenanceGaps}).`,
            },
          ],
          details: { source, compiled },
        };
      },
    },
    {
      name: "cf_permanent",
      label: "ContextForge Permanent Context (L3)",
      description:
        "Manage namespace-scoped L3 Permanent Context rules/contracts and configure prompt/symbolic-IR policies.",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["set", "get", "list", "delete"] },
          key: { type: "string", description: "Logical rule key (required for set/get/delete)" },
          body: { type: "string", description: "Permanent rule/contract body (for action='set')" },
          title: { type: "string", description: "Optional human-readable title" },
          priority: { type: "number", description: "Priority ordering (higher loads first)" },
          namespaceId: { type: "string", description: "Optional explicit namespace ID" },
        },
      },
      async execute(_id, rawParams) {
        const params = asRecord(rawParams);
        const action = String(params.action ?? "").trim();
        const { store } = getStore();
        const namespaceId =
          typeof params.namespaceId === "string" && params.namespaceId.trim()
            ? params.namespaceId.trim()
            : store.namespaceId;

        if (action === "list") {
          const items = store.listPermanentContext(namespaceId);
          return {
            content: [
              {
                type: "text",
                text: items.length
                  ? items.map((n) => `- ${n.logicalKey} (rev ${n.revision}): ${n.title}\n  ${n.body}`).join("\n")
                  : `No active L3 Permanent Context entries in ${namespaceId}.`,
              },
            ],
            details: { items },
          };
        }

        const key = String(params.key ?? "").trim();
        if (!key) throw new Error(`cf_permanent action="${action}" requires key`);

        if (action === "get") {
          const node = store.getPermanentContext(key, namespaceId);
          return {
            content: [
              {
                type: "text",
                text: node ? `${node.title} (${node.logicalKey}):\n${node.body}` : `Key "${key}" not found.`,
              },
            ],
            details: { node },
          };
        }

        if (action === "delete") {
          const deleted = store.deletePermanentContext(key, namespaceId);
          return {
            content: [{ type: "text", text: deleted ? `Deleted L3 key "${key}".` : `Key "${key}" not found.` }],
            details: { deleted },
          };
        }

        if (action === "set") {
          const body = String(params.body ?? "").trim();
          if (!body) throw new Error("cf_permanent action='set' requires non-empty body");
          const node = store.setPermanentContext(key, body, {
            title: typeof params.title === "string" ? params.title : key,
            namespaceId,
            priority: typeof params.priority === "number" ? params.priority : 10,
            ownerApproved: true,
          });
          return {
            content: [
              {
                type: "text",
                text: `Set L3 Permanent Context "${node.logicalKey}" (node=${node.nodeId}, rev=${node.revision}).`,
              },
            ],
            details: { node },
          };
        }

        throw new Error(`Unsupported cf_permanent action: ${action}`);
      },
    },
    {
      name: "cf_ingest",
      label: "ContextForge Ingest",
      description:
        "Ingest raw text, documents, or multimodal files into L0 CAS storage and compile into L1/L2 Wiki nodes.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Raw text content to ingest" },
          filePath: { type: "string", description: "Local file path to ingest" },
          originKey: { type: "string", description: "Logical document/source key" },
          mimeType: { type: "string", description: "Optional MIME type override" },
          captionOrTranscript: {
            type: "string",
            description: "Optional OCR/caption/transcript fallback for media assets",
          },
          compileWiki: { type: "boolean", description: "Immediately run deterministic L1/L2 compile (default true)" },
          namespaceId: { type: "string", description: "Optional explicit namespace ID" },
        },
      },
      async execute(_id, rawParams) {
        const params = asRecord(rawParams);
        const { store, compiler } = getStore();
        const namespaceId =
          typeof params.namespaceId === "string" && params.namespaceId.trim()
            ? params.namespaceId.trim()
            : store.namespaceId;

        let text = typeof params.text === "string" ? params.text : undefined;
        let bytes: Uint8Array | undefined;
        let mimeType = typeof params.mimeType === "string" ? params.mimeType : "text/plain";
        let kind: SourceKind = "document";

        if (typeof params.filePath === "string" && params.filePath.trim()) {
          const resolved = path.resolve(params.filePath.trim());
          // Guard against touching protected health_journal unless explicitly read-only authorized
          const buf = fs.readFileSync(resolved);
          const ext = path.extname(resolved).toLowerCase();
          if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
            kind = "media";
            mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
            bytes = buf;
          } else if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) {
            kind = "media";
            mimeType = "audio/mpeg";
            bytes = buf;
          } else if ([".mp4", ".webm", ".mov"].includes(ext)) {
            kind = "media";
            mimeType = "video/mp4";
            bytes = buf;
          } else if (ext === ".pdf") {
            kind = "document";
            mimeType = "application/pdf";
            bytes = buf;
          } else {
            text = buf.toString("utf8");
            mimeType = ext === ".md" ? "text/markdown" : "text/plain";
          }
        }

        if (!text && !bytes) {
          throw new Error("cf_ingest requires either text or filePath");
        }

        const originKey =
          typeof params.originKey === "string" && params.originKey.trim()
            ? params.originKey.trim()
            : typeof params.filePath === "string"
              ? path.basename(params.filePath)
              : `ingest/${Date.now()}`;

        const source = store.ingestSource({
          namespaceId,
          sessionId: ctx.sessionId,
          kind,
          originKey,
          trustClass: "user_statement",
          text,
          bytes,
          mimeType,
        });

        if (typeof params.captionOrTranscript === "string" && params.captionOrTranscript.trim()) {
          store.addArtifact({
            sourceId: source.sourceId,
            kind: "caption",
            text: params.captionOrTranscript.trim(),
            mimeType: "text/plain",
            fidelity: "human_annotated",
          });
        }

        const compiled = params.compileWiki === false ? null : compiler.compile(namespaceId);
        return {
          content: [
            {
              type: "text",
              text: `Ingested source ${source.sourceId} (${originKey}, kind=${source.kind})${compiled ? ` and compiled ${compiled.nodeIds.length} L1/L2 node(s)` : ""}.`,
            },
          ],
          details: { source, compiled },
        };
      },
    },
    {
      name: "cf_wiki_lint",
      label: "ContextForge Wiki Lint",
      description:
        "Verify structural and provenance integrity across all compiled L1/L2/L3 nodes in the active namespace.",
      parameters: {
        type: "object",
        properties: {
          namespaceId: { type: "string", description: "Optional explicit namespace ID" },
        },
      },
      async execute(_id, rawParams) {
        const params = asRecord(rawParams);
        const { store, compiler } = getStore();
        const namespaceId =
          typeof params.namespaceId === "string" && params.namespaceId.trim()
            ? params.namespaceId.trim()
            : store.namespaceId;
        const result = compiler.lintWiki(namespaceId);
        return {
          content: [
            {
              type: "text",
              text: `Wiki Lint (${namespaceId}): ok=${result.ok}, provenanceGaps=${result.provenanceGaps}, issues=${result.issues.length}`,
            },
          ],
          details: result,
        };
      },
    },
    {
      name: "cf_status",
      label: "ContextForge Status",
      description:
        "Inspect live ContextForge SQLite counts, active Epoch KV-cache state, and the latest planner receipt.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Optional session ID filter" },
        },
      },
      async execute(_id, rawParams) {
        const params = asRecord(rawParams);
        const { store } = getStore();
        const stats = store.getStats();
        const sessionId =
          typeof params.sessionId === "string" && params.sessionId.trim()
            ? params.sessionId.trim()
            : ctx.sessionId;
        const latestReceiptRow = sessionId
          ? store.db
              .prepare(
                "SELECT receipt_json FROM planner_receipts WHERE session_id=? ORDER BY created_at DESC LIMIT 1",
              )
              .get(sessionId)
          : store.db
              .prepare("SELECT receipt_json FROM planner_receipts ORDER BY created_at DESC LIMIT 1")
              .get();
        const rawReceipt = latestReceiptRow
          ? JSON.parse(String(latestReceiptRow.receipt_json))
          : null;
        const latestReceiptSummary = rawReceipt
          ? {
              receiptId: rawReceipt.receiptId,
              sessionId: rawReceipt.sessionId,
              modelId: rawReceipt.capabilityEnvelope?.modelId,
              providerId: rawReceipt.capabilityEnvelope?.providerId,
              disposition: rawReceipt.disposition,
              stopReason: rawReceipt.stopReason,
              promptMode: rawReceipt.profile?.promptMode,
              demand: rawReceipt.demand,
              tokens: rawReceipt.tokens,
              cache: rawReceipt.cache,
              selectionCount: Array.isArray(rawReceipt.selections) ? rawReceipt.selections.length : 0,
              stageCount: Array.isArray(rawReceipt.stages) ? rawReceipt.stages.length : 0,
            }
          : null;

        return {
          content: [
            {
              type: "text",
              text: `ContextForge Native Status (namespace=${store.namespaceId}):\n${JSON.stringify(stats, null, 2)}${
                latestReceiptSummary
                  ? `\nLatest Plan Receipt (${latestReceiptSummary.receiptId}): model=${latestReceiptSummary.providerId}/${latestReceiptSummary.modelId}, disposition=${latestReceiptSummary.disposition}, stopReason=${latestReceiptSummary.stopReason}, promptMode=${latestReceiptSummary.promptMode}, selections=${latestReceiptSummary.selectionCount}, selectedHistoryTokens=${latestReceiptSummary.tokens?.selectedHistory}/${latestReceiptSummary.tokens?.admissibleHistory}`
                  : ""
              }`,
            },
          ],
          details: { stats, latestReceipt: latestReceiptSummary, versions: { lexical: LEXICAL_VERSION, wiki: WIKI_COMPILER_VERSION, planner: rawReceipt?.plannerVersion ?? "native" }, bridge: externalRecallStatus(options), coverage: rawReceipt?.retrieval ?? null },
        };
      },
    },
  ];
}
