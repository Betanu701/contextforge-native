import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContextForgeStore, sha256 } from '../../src/store.ts';
import { ContextForgeCompiler } from '../../src/compiler.ts';
import { planContext, executeTrancheStream, resolveCapabilityEnvelope, type ContextPlan } from '../../src/planner.ts';
import { decomposeCodeSource } from '../../src/code-decomposer.ts';
import { estimateTokens } from '../../src/symbolic-ir.ts';
import { scoreFacetCoverage, analyzeRecallQuery } from '../../src/retrieval.ts';

export const BENCHMARK_VERSION = 'standard-polyglot-and-ruler-v1';

export interface PolyglotTask {
  id: string;
  suite: 'SWE-Polyglot-Enterprise' | 'RULER-MultiNeedle-VT';
  language: string;
  title: string;
  query: string;
  files: Array<{ path: string; text: string }>;
  requiredWitnesses: Array<{ file: string; witness: string; description: string }>;
  rubricChecks: Array<{ name: string; re: RegExp }>;
}

function makeCobolMainframeRepo(): Array<{ path: string; text: string }> {
  const paddingParagraphs = (prefix: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `00${String(1000 + i).slice(-4)} ${prefix}-PARA-${String(i + 1).padStart(3, '0')}.\n` +
        `           MOVE ${i + 1} TO WS-STEP-COUNTER.\n` +
        `           COMPUTE WS-TEMP-ACCUM = WS-TEMP-ACCUM + (WS-STEP-COUNTER * 1.05).\n` +
        `           IF WS-TEMP-ACCUM > 9999999\n` +
        `               MOVE 0 TO WS-TEMP-ACCUM\n` +
        `           END-IF.\n`,
    ).join('');

  return [
    {
      path: 'mainframe/CLM-BATCH-DRIVER.cbl',
      text:
        `000100 IDENTIFICATION DIVISION.\n000200 PROGRAM-ID. CLM-BATCH-DRIVER.\n000300 DATA DIVISION.\n000400 WORKING-STORAGE SECTION.\n000500 01 WS-STEP-COUNTER PIC 9(6) VALUE 0.\n000600 01 WS-TEMP-ACCUM PIC 9(9)V99 VALUE 0.\n000700 PROCEDURE DIVISION.\n000800 1000-BATCH-MAIN SECTION.\n` +
        paddingParagraphs('BATCH', 200),
    },
    {
      path: 'mainframe/CLM-AUDIT-LOG.cbl',
      text:
        `000100 IDENTIFICATION DIVISION.\n000200 PROGRAM-ID. CLM-AUDIT-LOG.\n000300 DATA DIVISION.\n000400 WORKING-STORAGE SECTION.\n000500 01 WS-STEP-COUNTER PIC 9(6) VALUE 0.\n000600 01 WS-TEMP-ACCUM PIC 9(9)V99 VALUE 0.\n000700 PROCEDURE DIVISION.\n000800 1000-AUDIT-MAIN SECTION.\n` +
        paddingParagraphs('AUDIT', 200),
    },
    {
      path: 'mainframe/VA-BENEFIT-CALC.cbl',
      text:
        `000100 IDENTIFICATION DIVISION.\n000200 PROGRAM-ID. VA-BENEFIT-CALC.\n000300 DATA DIVISION.\n000400 WORKING-STORAGE SECTION.\n000500 01 WS-CLAIM-RECORD.\n000600    05 WS-VETERAN-ID     PIC X(12).\n000700    05 WS-BASE-AWARD     PIC 9(7)V99 VALUE 0.\n000800    05 WS-COLA-FACTOR    PIC 9V9999 VALUE 1.0325.\n000900    05 WS-NET-BENEFIT    PIC 9(7)V99 VALUE 0.\n001000    05 WS-SQL-STATUS     PIC S9(9) COMP VALUE 0.\n001100 PROCEDURE DIVISION.\n` +
        paddingParagraphs('PRE', 40) +
        `005000 5000-ADJUDICATE-SECTION SECTION.\n` +
        `005100 5100-FETCH-ELIGIBILITY.\n` +
        `           EXEC SQL\n` +
        `               SELECT BASE_AWARD, COLA_FACTOR\n` +
        `               INTO :WS-BASE-AWARD, :WS-COLA-FACTOR\n` +
        `               FROM VA_ELIGIBILITY_LEDGER\n` +
        `               WHERE VETERAN_ID = :WS-VETERAN-ID\n` +
        `                 AND FISCAL_YEAR = 2026\n` +
        `           END-EXEC.\n` +
        `005200 5200-COMPUTE-COLA-CAP.\n` +
        `           EVALUATE TRUE\n` +
        `               WHEN WS-BASE-AWARD > 42500.00\n` +
        `                   COMPUTE WS-NET-BENEFIT ROUNDED = (WS-BASE-AWARD * WS-COLA-FACTOR) - 350.00\n` +
        `               WHEN OTHER\n` +
        `                   COMPUTE WS-NET-BENEFIT = WS-BASE-AWARD * WS-COLA-FACTOR\n` +
        `           END-EVALUATE.\n` +
        paddingParagraphs('POST', 40),
    },
  ];
}

function makeFortranSolverRepo(): Array<{ path: string; text: string }> {
  const padSubroutines = (mod: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `  SUBROUTINE ${mod}_AUX_KERNEL_${i + 1}(ARR, N)\n` +
        `    INTEGER, INTENT(IN) :: N\n` +
        `    REAL(8), INTENT(INOUT) :: ARR(N)\n` +
        `    INTEGER :: K\n` +
        `    DO K = 1, N\n` +
        `      ARR(K) = ARR(K) * 0.9999D0 + ${i}.0D-6\n` +
        `    END DO\n` +
        `  END SUBROUTINE ${mod}_AUX_KERNEL_${i + 1}\n`,
    ).join('\n');

  return [
    {
      path: 'hpc/GRID_METRICS.f90',
      text: `MODULE GRID_METRICS\n  IMPLICIT NONE\nCONTAINS\n` + padSubroutines('GRID', 95) + `END MODULE GRID_METRICS\n`,
    },
    {
      path: 'hpc/IO_CHECKPOINT.f90',
      text: `MODULE IO_CHECKPOINT\n  IMPLICIT NONE\nCONTAINS\n` + padSubroutines('IO', 95) + `END MODULE IO_CHECKPOINT\n`,
    },
    {
      path: 'hpc/NAVIER_STOKES_CFL.f90',
      text:
        `! High-Order Compressible Navier-Stokes CFL Stability Module\nMODULE NAVIER_STOKES_CFL\n  IMPLICIT NONE\n  REAL(8), PARAMETER :: CFL_SAFETY_LIMIT = 0.45D0\n  REAL(8), PARAMETER :: MIN_GRID_DX = 1.0D-9\nCONTAINS\n` +
        padSubroutines('PRE_NS', 35) +
        `  SUBROUTINE ADVANCE_RK3_STAGE(U, FLUX, NX, DT, DX, IERR)\n` +
        `    INTEGER, INTENT(IN) :: NX\n` +
        `    REAL(8), INTENT(INOUT) :: U(NX)\n` +
        `    REAL(8), INTENT(IN) :: FLUX(NX), DT, DX\n` +
        `    INTEGER, INTENT(OUT) :: IERR\n` +
        `    INTEGER :: I\n` +
        `    REAL(8) :: LOCAL_CFL\n` +
        `    IERR = 0\n` +
        `    IF (DX < MIN_GRID_DX) THEN\n` +
        `      IERR = -904\n` +
        `      RETURN\n` +
        `    END IF\n` +
        `    DO I = 2, NX - 1\n` +
        `      LOCAL_CFL = ABS(U(I)) * DT / DX\n` +
        `      IF (LOCAL_CFL > CFL_SAFETY_LIMIT) THEN\n` +
        `        IERR = 702\n` +
        `        RETURN\n` +
        `      END IF\n` +
        `      U(I) = U(I) - (DT / DX) * (FLUX(I) - FLUX(I - 1))\n` +
        `    END DO\n` +
        `  END SUBROUTINE ADVANCE_RK3_STAGE\n` +
        padSubroutines('POST_NS', 35) +
        `END MODULE NAVIER_STOKES_CFL\n`,
    },
  ];
}

function makeTsPolyglotHtmlSqlRepo(): Array<{ path: string; text: string }> {
  const padModules = (name: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `export function ${name}Helper${i + 1}(input: string): string {\n` +
        `  const normalized = input.trim().toLowerCase();\n` +
        `  return normalized + "-v${i + 1}";\n` +
        `}\n`,
    ).join('\n');

  return [
    {
      path: 'web/telemetry-batch.ts',
      text: padModules('telemetry', 140),
    },
    {
      path: 'web/theme-tokens.ts',
      text: padModules('theme', 140),
    },
    {
      path: 'web/billing-portal-ssr.ts',
      text:
        padModules('portalPre', 40) +
        `\nexport const BILLING_LEDGER_DDL = String.raw\`\n` +
        `CREATE TABLE enterprise_invoice_splits (\n` +
        `  invoice_id TEXT PRIMARY KEY,\n` +
        `  tenant_id TEXT NOT NULL,\n` +
        `  retainage_bps INTEGER NOT NULL CHECK(retainage_bps BETWEEN 0 AND 2500),\n` +
        `  settlement_state TEXT NOT NULL CHECK(settlement_state IN ('pending','escrow_locked','released'))\n` +
        `) STRICT;\n` +
        `\`;\n\n` +
        `export function renderEscrowPortalHtml(invoiceId: string, retainageBps: number, csrfNonce: string): string {\n` +
        `  const distraction = "if (unbalanced_string_brace > 0) {{{";\n` +
        `  return \`\n` +
        `    <section id="escrow-release-panel" data-invoice="\${invoiceId}">\n` +
        `      <header class="panel-header"><h2>Enterprise Retainage Escrow</h2></header>\n` +
        `      <form method="POST" action="/api/v2/escrow/release">\n` +
        `        <input type="hidden" name="x_csrf_token" value="\${csrfNonce}" />\n` +
        `        <div class="metric-row" data-retainage-bps="\${retainageBps}">\n` +
        `          <span>Max Allowed Retainage: 2500 bps (25.00%)</span>\n` +
        `        </div>\n` +
        `        <footer><button type="submit" id="btn-confirm-escrow">Release Escrow</button></footer>\n` +
        `      </form>\n` +
        `    </section>\n` +
        `  \`;\n` +
        `}\n` +
        padModules('portalPost', 40),
    },
  ];
}

function makeRulerMultiNeedleHaystack(): Array<{ path: string; text: string }> {
  const hayChunk = (idx: number) =>
    `// Telemetry archive segment ${idx}\n` +
    Array.from(
      { length: 90 },
      (_, j) => `Line ${j}: ambient sensor reading=${100 + j}kPa status=nominal station=alpha-${idx};`,
    ).join('\n') +
    '\n';

  return [
    { path: 'haystack/segment-01.log', text: hayChunk(1) },
    {
      path: 'haystack/segment-02.log',
      text:
        hayChunk(2) +
        `\n[RULER_NEEDLE_1] Vault- Key-Alpha = "KRYPTON-8841" ; Initial variable binding: LET X_SEED = 1400.\n` +
        hayChunk(20),
    },
    { path: 'haystack/segment-03.log', text: hayChunk(3) },
    { path: 'haystack/segment-04.log', text: hayChunk(4) },
    {
      path: 'haystack/segment-05.log',
      text:
        hayChunk(5) +
        `\n[RULER_NEEDLE_2] Vault-Key-Beta = "ARGON-3319" ; Variable hop: LET Y_STAGE = X_SEED + 625 (so Y_STAGE = 2025 when X_SEED = 1400).\n` +
        hayChunk(50),
    },
    { path: 'haystack/segment-06.log', text: hayChunk(6) },
    { path: 'haystack/segment-07.log', text: hayChunk(7) },
    {
      path: 'haystack/segment-08.log',
      text:
        hayChunk(8) +
        `\n[RULER_NEEDLE_3] Vault-Key-Gamma = "XENON-9072" ; Final variable hop: LET Z_FINAL = Y_STAGE - 199 (so Z_FINAL = 1826 when Y_STAGE = 2025).\n` +
        hayChunk(80),
    },
  ];
}

export const POLYGLOT_AND_RULER_TASKS: PolyglotTask[] = [
  {
    id: 'swe-polyglot-1-cobol-exec-sql',
    suite: 'SWE-Polyglot-Enterprise',
    language: 'cobol+sql',
    title: 'Mainframe COBOL Division/Paragraph Decomposition + Embedded EXEC SQL Audit',
    query: 'Audit `mainframe/VA-BENEFIT-CALC.cbl` (`5000-ADJUDICATE-SECTION`). Specifically: (1) What SQL table (`VA_ELIGIBILITY_LEDGER`), columns (`BASE_AWARD`, `COLA_FACTOR`), and `FISCAL_YEAR` filter are queried inside the embedded `EXEC SQL ... END-EXEC` block in `5100-FETCH-ELIGIBILITY`? (2) In `5200-COMPUTE-COLA-CAP`, at what `WS-BASE-AWARD` threshold (`42500.00`) does the `EVALUATE TRUE` branch subtract `350.00` with `ROUNDED`? Cite `[span:...]` evidence.',
    files: makeCobolMainframeRepo(),
    requiredWitnesses: [
      { file: 'mainframe/VA-BENEFIT-CALC.cbl', witness: 'VA_ELIGIBILITY_LEDGER', description: 'Embedded EXEC SQL table VA_ELIGIBILITY_LEDGER' },
      { file: 'mainframe/VA-BENEFIT-CALC.cbl', witness: '42500.00', description: 'EVALUATE threshold WS-BASE-AWARD > 42500.00' },
      { file: 'mainframe/VA-BENEFIT-CALC.cbl', witness: '350.00', description: 'Deduction of 350.00 in 5200-COMPUTE-COLA-CAP' },
    ],
    rubricChecks: [
      { name: 'VA_ELIGIBILITY_LEDGER & FISCAL_YEAR=2026', re: /VA_ELIGIBILITY_LEDGER.*2026|2026.*VA_ELIGIBILITY_LEDGER/is },
      { name: '42500.00 threshold', re: /42[_,]?500/ },
      { name: '350.00 deduction with ROUNDED', re: /350/ },
    ],
  },
  {
    id: 'swe-polyglot-2-fortran-cfl-stability',
    suite: 'SWE-Polyglot-Enterprise',
    language: 'fortran90',
    title: 'Scientific Fortran 90 Module/Subroutine Decomposition & CFL Error-Code Localization',
    query: 'Analyze `ADVANCE_RK3_STAGE` inside `hpc/NAVIER_STOKES_CFL.f90`. Specifically: (1) What are the exact parameter values for `CFL_SAFETY_LIMIT` (`0.45D0`) and `MIN_GRID_DX` (`1.0D-9`), (2) what integer error code `IERR` (`-904`) is returned when `DX < MIN_GRID_DX`, and (3) what integer error code `IERR` (`702`) is returned inside the `DO` loop when `LOCAL_CFL > CFL_SAFETY_LIMIT`? Cite `[span:...]` evidence.',
    files: makeFortranSolverRepo(),
    requiredWitnesses: [
      { file: 'hpc/NAVIER_STOKES_CFL.f90', witness: '0.45D0', description: 'CFL_SAFETY_LIMIT = 0.45D0' },
      { file: 'hpc/NAVIER_STOKES_CFL.f90', witness: '-904', description: 'IERR = -904 when DX < MIN_GRID_DX' },
      { file: 'hpc/NAVIER_STOKES_CFL.f90', witness: '702', description: 'IERR = 702 when LOCAL_CFL > CFL_SAFETY_LIMIT' },
    ],
    rubricChecks: [
      { name: 'CFL_SAFETY_LIMIT 0.45 / MIN_GRID_DX 1.0D-9', re: /0\.45/ },
      { name: 'IERR = -904 on DX < MIN_GRID_DX', re: /-904/ },
      { name: 'IERR = 702 on LOCAL_CFL > CFL_SAFETY_LIMIT', re: /\b702\b/ },
    ],
  },
  {
    id: 'swe-polyglot-3-ts-embedded-html-sql',
    suite: 'SWE-Polyglot-Enterprise',
    language: 'typescript+html+sql',
    title: 'TypeScript Polyglot Strings: Embedded SQL DDL + Embedded HTML Template with Unbalanced String Braces',
    query: 'Inspect `BILLING_LEDGER_DDL` and `renderEscrowPortalHtml` in `web/billing-portal-ssr.ts`. Specifically: (1) In the embedded `enterprise_invoice_splits` SQL table, what `CHECK` constraint bounds `retainage_bps` (`BETWEEN 0 AND 2500`) and what are the allowed `settlement_state` values, and (2) in the embedded HTML template inside `renderEscrowPortalHtml`, what form `action` path (`/api/v2/escrow/release`) and hidden input `name` (`x_csrf_token`) are rendered? Cite `[span:...]` evidence.',
    files: makeTsPolyglotHtmlSqlRepo(),
    requiredWitnesses: [
      { file: 'web/billing-portal-ssr.ts', witness: 'enterprise_invoice_splits', description: 'Embedded SQL table enterprise_invoice_splits' },
      { file: 'web/billing-portal-ssr.ts', witness: '2500', description: 'retainage_bps BETWEEN 0 AND 2500' },
      { file: 'web/billing-portal-ssr.ts', witness: '/api/v2/escrow/release', description: 'Embedded HTML form action /api/v2/escrow/release' },
    ],
    rubricChecks: [
      { name: 'retainage_bps 0..2500 & settlement_state', re: /2500.*escrow_locked|escrow_locked.*2500/is },
      { name: '/api/v2/escrow/release form action', re: /\/api\/v2\/escrow\/release/ },
      { name: 'x_csrf_token hidden input', re: /x_csrf_token/ },
    ],
  },
  {
    id: 'ruler-4-multineedle-variable-tracking',
    suite: 'RULER-MultiNeedle-VT',
    language: 'ruler-haystack',
    title: 'RULER Multi-Needle + 3-Hop Variable Tracking Across 8 Telemetry Segments',
    query: 'Retrieve `[RULER_NEEDLE_1]`, `[RULER_NEEDLE_2]`, and `[RULER_NEEDLE_3]` across the telemetry segments. Report: (1) all three Vault Keys (`Vault-Key-Alpha`, `Vault-Key-Beta`, `Vault-Key-Gamma`), and (2) the exact numeric values of the 3-hop variable chain `X_SEED`, `Y_STAGE`, and `Z_FINAL`. Cite `[span:...]` evidence.',
    files: makeRulerMultiNeedleHaystack(),
    requiredWitnesses: [
      { file: 'haystack/segment-02.log', witness: 'KRYPTON-8841', description: 'Needle 1 KRYPTON-8841 and X_SEED = 1400' },
      { file: 'haystack/segment-05.log', witness: 'ARGON-3319', description: 'Needle 2 ARGON-3319 and Y_STAGE = 2025' },
      { file: 'haystack/segment-08.log', witness: 'XENON-9072', description: 'Needle 3 XENON-9072 and Z_FINAL = 1826' },
    ],
    rubricChecks: [
      { name: 'All 3 Vault Keys (KRYPTON-8841, ARGON-3319, XENON-9072)', re: /KRYPTON-8841[\s\S]*ARGON-3319[\s\S]*XENON-9072/i },
      { name: 'X_SEED = 1400 & Y_STAGE = 2025', re: /1400[\s\S]*2025/ },
      { name: 'Z_FINAL = 1826', re: /\b1826\b/ },
    ],
  },
];

export type LiveDispatcher = (messages: any[], maxOutput: number) => Promise<{ response: string; usage: any; latencyMs: number }>;

export async function runPolyglotAndRulerBenchmark(options: {
  windowTokens?: number;
  trancheTokenBudget?: number;
  maxOutput?: number;
  dispatch?: LiveDispatcher;
} = {}) {
  const windowTokens = options.windowTokens ?? 10000;
  const trancheTokenBudget = options.trancheTokenBudget ?? 8000;
  const maxOutput = options.maxOutput ?? 1024;
  const SYSTEM = 'You are a principal enterprise systems & mainframe modernization architect. Analyze the quoted code and telemetry spans, report exact identifiers, constants, SQL schemas, and numeric values, and cite [span:...] evidence.';

  const standardResults: any[] = [];
  const trancheResults: any[] = [];
  const start = performance.now();

  for (const task of POLYGLOT_AND_RULER_TASKS) {
    const dir = mkdtempSync(join(tmpdir(), `cf-poly-${task.id}-`));
    const store = new ContextForgeStore(join(dir, 'store.sqlite'));
    const compiler = new ContextForgeCompiler(store);

    try {
      const sourceIds: string[] = [];
      let partitionVerifiedAll = true;
      for (const f of task.files) {
        const tree = decomposeCodeSource(f.text, { originKey: f.path, maxBlockBytes: 2048 });
        if (!tree.partitionVerified) partitionVerifiedAll = false;
        sourceIds.push(store.ingestSource({ originKey: f.path, kind: 'document', role: 'user', text: f.text, observedAt: 1 }).sourceId);
      }
      compiler.compile();

      // 1. Standard FIFO / Truncation Baseline (CF OFF, 8K cap):
      // Standard sliding window concatenates queued files in order and truncates at fifoBudget.
      const fifoBudget = trancheTokenBudget - maxOutput - 800;
      let fifoUsed = estimateTokens(SYSTEM) + estimateTokens(task.query);
      const fifoTexts: string[] = [];
      for (const f of task.files) {
        const tok = estimateTokens(f.text);
        if (fifoUsed + tok > fifoBudget) break;
        fifoUsed += tok;
        fifoTexts.push(f.text);
      }
      const joinedFifo = fifoTexts.join('\n');
      const fifoChecks = task.requiredWitnesses.map(w => ({ ...w, present: joinedFifo.includes(w.witness) }));
      standardResults.push({
        taskId: task.id,
        suite: task.suite,
        language: task.language,
        required: fifoChecks.length,
        covered: fifoChecks.filter(c => c.present).length,
        allPremisesCovered: fifoChecks.every(c => c.present),
      });

      // 2. ContextForge Multi-Pass Tranche Stream + Universal Grammar Decomposer:
      const recall = analyzeRecallQuery(task.query);
      const codeIds = recall.facets.filter(f => f.origin === 'question' && (f.kind === 'identifier' || f.kind === 'number') && f.surface.length >= 3).map(f => f.surface);
      const stream = await executeTrancheStream(
        {
          store,
          sessionId: `s-${task.id}`,
          admissionId: `a-${task.id}`,
          query: task.query,
          rawSystemPrompt: SYSTEM,
          sourceIds,
          trancheTokenBudget,
          envelope: resolveCapabilityEnvelope({
            nativeContextTokens: windowTokens,
            hostTokenBudget: trancheTokenBudget,
            hostBudgetScope: 'total_input',
            input: ['text'],
            outputReserveTokens: maxOutput,
            safetyMarginTokens: 600,
            framingTokens: 32,
            pendingInputTokens: estimateTokens(task.query),
          }),
        },
        passPlan => {
          const keepSpanIds = passPlan.receipt.selections
            .filter(s => s.role === 'quoted_evidence')
            .flatMap(s => s.provenanceSpanIds)
            .filter(spanId => {
              const text = store.readEvidenceSpan(spanId).text;
              if (codeIds.some(id => text.includes(id))) return true;
              const cov = scoreFacetCoverage(recall, text);
              return cov.anchored && cov.score >= 0.25;
            });
          return { keepSpanIds };
        },
      );

      const finalWire = JSON.stringify(stream.finalPlan.messages);
      const cfChecks = task.requiredWitnesses.map(w => ({ ...w, present: finalWire.includes(w.witness) }));
      let liveResult: any = null;
      if (options.dispatch) {
        const msgs = [
          { role: 'system', content: stream.finalPlan.systemPrompt },
          ...stream.finalPlan.messages.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: task.query },
        ];
        const res = await options.dispatch(msgs, maxOutput);
        const rubric = task.rubricChecks.map(c => ({ name: c.name, pass: c.re.test(res.response) }));
        liveResult = {
          latencyMs: res.latencyMs,
          usage: res.usage,
          pass: rubric.every(r => r.pass),
          passedCount: rubric.filter(r => r.pass).length,
          totalChecks: rubric.length,
          hasCitation: /\[span:[a-f0-9]{64}\]/i.test(res.response),
          rubric,
          response: res.response,
        };
      }

      trancheResults.push({
        taskId: task.id,
        suite: task.suite,
        language: task.language,
        title: task.title,
        partitionVerifiedAll,
        passesCount: stream.passes.length,
        finalWireTokensHeuristic: stream.finalPlan.receipt.tokens.serializedInputTokens,
        required: cfChecks.length,
        covered: cfChecks.filter(c => c.present).length,
        allPremisesCovered: cfChecks.every(c => c.present),
        checks: cfChecks,
        live: liveResult,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    benchmark: BENCHMARK_VERSION,
    summary: {
      tasks: POLYGLOT_AND_RULER_TASKS.length,
      requiredPremisesTotal: trancheResults.reduce((n, r) => n + r.required, 0),
      standardFifoPremisesCovered: standardResults.reduce((n, r) => n + r.covered, 0),
      standardFifoTasksComplete: standardResults.filter(r => r.allPremisesCovered).length,
      cfTranchePremisesCovered: trancheResults.reduce((n, r) => n + r.covered, 0),
      cfTrancheTasksComplete: trancheResults.filter(r => r.allPremisesCovered).length,
      allPartitionsSha256Verified: trancheResults.every(r => r.partitionVerifiedAll),
      liveScreensPassed: options.dispatch ? trancheResults.filter(r => r.live?.pass).length : null,
      liveCitationsPassed: options.dispatch ? trancheResults.filter(r => r.live?.hasCitation).length : null,
      elapsedMs: Math.round(performance.now() - start),
    },
    standardResults,
    trancheResults,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPolyglotAndRulerBenchmark().then(r => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  });
}
