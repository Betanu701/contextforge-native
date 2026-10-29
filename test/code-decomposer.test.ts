import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decomposeCodeSource,
  registerLanguageGrammar,
  getLanguageGrammar,
  listLanguageGrammars,
  fromVSCodeLanguageConfig,
  verifyPartitionConservation,
  rankRepositoryAstBlocksBlind,
  splitCorpusStreamIntoFiles,
} from '../src/code-decomposer.ts';
import { ContextForgeStore, sha256 } from '../src/store.ts';
import { isCommonEnglishProseToken, splitIdentifierSubTokens } from '../src/lexicon-priors.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('LanguageGrammarRegistry ships modern, markup, SQL, and legacy mainframe grammars (COBOL, Fortran) and imports VS Code language-configuration.json', () => {
  const ids = new Set(listLanguageGrammars().map(g => g.id));
  for (const expected of ['typescript', 'python', 'csharp', 'java', 'go', 'rust', 'cpp', 'cobol', 'fortran', 'sql', 'html', 'ejs']) {
    assert.ok(ids.has(expected), `Missing built-in grammar: ${expected}`);
  }
  assert.equal(getLanguageGrammar('program.cbl')?.id, 'cobol');
  assert.equal(getLanguageGrammar('solver.f90')?.id, 'fortran');
  assert.equal(getLanguageGrammar('view.ejs')?.id, 'ejs');

  // Convert a VS Code language-configuration.json (e.g. Ada / PL/I region markers)
  const adaSpec = fromVSCodeLanguageConfig('ada', ['.adb', '.ads'], {
    comments: { lineComment: '--' },
    brackets: [['(', ')']],
    folding: { markers: { start: '^\\s*(?:procedure|function|package|begin)\\b', end: '^\\s*end\\b' } },
  });
  registerLanguageGrammar(adaSpec);
  assert.equal(getLanguageGrammar('flight_control.adb')?.id, 'ada');
});

test('TypeScript with embedded String.raw SQL DDL and HTML template strings preserves Partition-of-Unity SHA-256 byte conservation', () => {
  const schemaBytes = readFileSync(new URL('../src/schema.ts', import.meta.url));
  const tree = decomposeCodeSource(schemaBytes, { originKey: 'src/schema.ts', maxBlockBytes: 2048 });
  assert.equal(tree.partitionVerified, true);
  assert.equal(tree.rootSha256, sha256(schemaBytes));
  assert.ok(tree.flatNodes.some(n => n.grammarId === 'sql' && n.kind === 'embedded_string'), 'Must detect embedded SQL DDL string');
  assert.ok(tree.flatNodes.some(n => n.grammarId === 'sql' && n.symbolName.includes('blobs')), 'Must decompose individual CREATE TABLE statements inside embedded SQL');

  // Test TypeScript component with embedded HTML + ${...} interpolation and unbalanced braces inside strings
  const tsWithHtml = `export class CheckoutView {
  private trickString = "if (unbalanced > 0) {{{";
  render(items: Array<{ name: string; price: number }>) {
    const htmlTemplate = \`
      <section class="checkout-container">
        <header><h1>Order Summary</h1></header>
        <div class="line-items">
          <ul>
            \${items.map(i => \`<li data-name="\${i.name}">\${i.price}</li>\`).join("")}
          </ul>
        </div>
        <footer><button id="pay-now">Submit Payment</button></footer>
      </section>
    \`;
    return htmlTemplate;
  }
}
`;
  const htmlTree = decomposeCodeSource(tsWithHtml, { originKey: 'CheckoutView.ts', maxBlockBytes: 256 });
  assert.equal(htmlTree.partitionVerified, true);
  assert.equal(verifyPartitionConservation(Buffer.from(tsWithHtml), htmlTree.root), true);
  assert.ok(htmlTree.flatNodes.some(n => n.symbolPath.includes('CheckoutView')));
});

test('COBOL Divisions, Sections, Paragraphs, EVALUATE blocks, and embedded EXEC SQL decompose with 100% byte conservation', () => {
  const cobol = `000100 IDENTIFICATION DIVISION.
000200 PROGRAM-ID. VA-BENEFIT-LEDGER.
000300 DATA DIVISION.
000400 WORKING-STORAGE SECTION.
000500 01 WS-VET-RECORD.
000600    05 WS-CLAIM-ID      PIC X(12).
000700    05 WS-BASE-AWARD    PIC 9(7)V99 VALUE 0.
000800    05 WS-NET-PAY       PIC 9(7)V99 VALUE 0.
000900 PROCEDURE DIVISION.
001000 1000-DISPATCH-SECTION SECTION.
001100 1100-FETCH-CLAIM.
001200     EXEC SQL
001300         SELECT BASE_AWARD INTO :WS-BASE-AWARD
001400         FROM VETERAN_CLAIMS WHERE CLAIM_ID = :WS-CLAIM-ID
001500     END-EXEC.
001600 1200-COMPUTE-AWARD.
001700     EVALUATE TRUE
001800         WHEN WS-BASE-AWARD > 25000
001900             COMPUTE WS-NET-PAY = WS-BASE-AWARD * 1.15
002000         WHEN OTHER
002100             COMPUTE WS-NET-PAY = WS-BASE-AWARD
002200     END-EVALUATE.
002300     STOP RUN.
`;
  const tree = decomposeCodeSource(cobol, { originKey: 'VA-BENEFIT-LEDGER.cbl', maxBlockBytes: 300 });
  assert.equal(tree.partitionVerified, true);
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('IDENTIFICATION')));
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('WORKING-STORAGE')));
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('1100-FETCH-CLAIM')));
  assert.ok(tree.flatNodes.some(n => n.grammarId === 'sql'), 'Embedded EXEC SQL inside COBOL must switch to sql grammar');
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('1200-COMPUTE-AWARD')));
});

test('Fortran 90 Modules, Subroutines, Functions, and nested DO/IF blocks decompose with 100% byte conservation', () => {
  const fortran = `! High-order finite difference kernel
MODULE STENCIL_KERNEL
  IMPLICIT NONE
CONTAINS
  SUBROUTINE APPLY_LAPLACIAN(PHI, LAPH, NX, DX)
    INTEGER, INTENT(IN) :: NX
    REAL(8), INTENT(IN) :: PHI(NX), DX
    REAL(8), INTENT(OUT) :: LAPH(NX)
    INTEGER :: I
    DO I = 2, NX - 1
      IF (DX > 0.0D0) THEN
        LAPH(I) = (PHI(I+1) - 2.0D0*PHI(I) + PHI(I-1)) / (DX * DX)
      END IF
    END DO
  END SUBROUTINE APPLY_LAPLACIAN

  PURE FUNCTION L2_RESIDUAL(LAPH, NX) RESULT(RES)
    INTEGER, INTENT(IN) :: NX
    REAL(8), INTENT(IN) :: LAPH(NX)
    REAL(8) :: RES
    RES = SQRT(SUM(LAPH * LAPH))
  END FUNCTION L2_RESIDUAL
END MODULE STENCIL_KERNEL
`;
  const tree = decomposeCodeSource(fortran, { originKey: 'stencil.f90', maxBlockBytes: 256 });
  assert.equal(tree.partitionVerified, true);
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('STENCIL_KERNEL')));
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('APPLY_LAPLACIAN')));
  assert.ok(tree.flatNodes.some(n => n.symbolPath.includes('L2_RESIDUAL')));
});

test('25,000-byte giant monolithic function decomposes into contiguous parts that reconstruct the exact function SHA-256', () => {
  const lines = ['export function giantLegacyOrderProcessor(order: any) {'];
  for (let i = 0; i < 400; i++) {
    lines.push(`  if (order.step === ${i}) { order.total += ${i * 3}; order.auditLog.push("step-${i}-verified"); }`);
  }
  lines.push('  return order;\n}\n');
  const giantCode = lines.join('\n');
  const bytes = Buffer.from(giantCode, 'utf8');
  assert.ok(bytes.length > 30000);

  const tree = decomposeCodeSource(bytes, { originKey: 'giantOrderProcessor.ts', maxBlockBytes: 4096 });
  assert.equal(tree.partitionVerified, true);
  assert.equal(tree.rootSha256, sha256(bytes));
  const leaves = tree.flatNodes.filter(n => n.children.length === 0);
  assert.ok(leaves.length >= 8, 'Giant function must split into >=8 bounded parts');
  for (const leaf of leaves) {
    assert.ok(leaf.byteEnd - leaf.byteStart <= 4096, `Leaf exceeded maxBlockBytes: ${leaf.byteEnd - leaf.byteStart}`);
  }
  const reconstructed = Buffer.concat(leaves.map(l => bytes.subarray(l.byteStart, l.byteEnd)));
  assert.equal(sha256(reconstructed), sha256(bytes), 'Concatenated leaf parts must equal exact original file SHA-256');
});

test('SQLite lexicon_priors + symbol_bm25_index, camelCase/snake_case sub-token triangulation, virtual file stream splitter, and orientation-first/recency-last ordering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-lex-test-'));
  try {
    const store = new ContextForgeStore(join(dir, 's.sqlite'));
    const lexCount = Number((store.db.prepare('SELECT count(*) AS cnt FROM lexicon_priors').get() as any).cnt);
    assert.ok(lexCount >= 10000, `Expected >=10,000 lexicon_priors rows, got ${lexCount}`);

    // Common English prose words from LongBench questions must be recognized as prose
    for (const prose of ['mainly', 'important', 'provides', 'library', 'documents', 'refinement', 'factors']) {
      assert.equal(isCommonEnglishProseToken(prose), true, `Expected "${prose}" to be classified as common English prose`);
    }
    // Technical symbols must NOT be classified as prose
    for (const sym of ['ContrastiveEmbed', 'start_port', 'load_audio', 'Http404', 'HPGMG']) {
      assert.equal(isCommonEnglishProseToken(sym), false, `Expected "${sym}" to be classified as technical symbol`);
    }
    assert.deepEqual(splitIdentifierSubTokens('ContrastiveEmbed'), ['contrastive', 'embed']);
    assert.deepEqual(splitIdentifierSubTokens('convert_ldm_vae_checkpoint'), ['convert', 'ldm', 'vae', 'checkpoint']);

    // Ingesting a code file indexes its AST definitions and sub-tokens into symbol_bm25_index
    const src = store.ingestSource({
      originKey: 'models/utils.py',
      kind: 'document',
      role: 'user',
      text: 'from .blocks import UpBlock3D\nclass ContrastiveEmbed:\n    def forward(self, x):\n        return x\n',
    });
    const indexed = store.db.prepare('SELECT symbol_lower, role FROM symbol_bm25_index WHERE source_id=?').all(src.sourceId) as any[];
    assert.ok(indexed.some(r => r.symbol_lower === 'contrastiveembed' && r.role === 'definition'));
    assert.ok(indexed.some(r => r.symbol_lower === 'contrastive' && r.role === 'definition_subtoken'));
    assert.ok(indexed.some(r => r.symbol_lower === 'upblock3d' && r.role === 'import'));

    // Multi-line imports + cursor comment sub-token triangulation + orientation-first / recency-last ordering
    const files = [
      { path: 'README.md', text: '# Project Architecture\nThis repository implements contrastive vision-language grounding.\n' },
      { path: 'models/unrelated.py', text: 'class COCOVisualizer:\n    def draw(self):\n        pass\n' },
      { path: 'models/utils.py', text: 'class ContrastiveEmbed:\n    def __init__(self):\n        self.proj = 256\n' },
    ];
    const importStmt = `from models.utils import (\n    COCOVisualizer,\n    ContrastiveEmbed,\n)`;
    const cursorCtx = `    # prepare class & box embed\n`;
    const ranked = rankRepositoryAstBlocksBlind(files, 'Complete next line after prepare class & box embed', {
      importStatement: importStmt,
      cursorContext: cursorCtx,
    });
    assert.equal(ranked.allPartitionsVerified, true);
    assert.ok(ranked.blocks.length >= 2);
    // Orientation doc (README.md) sits at index 0 (top of window), while #1 highest-scoring implementation block (ContrastiveEmbed) sits at the VERY BOTTOM!
    assert.equal(ranked.blocks[0].originKey, 'README.md');
    assert.equal(ranked.blocks[ranked.blocks.length - 1].originKey, 'models/utils.py');
    assert.ok(ranked.blocks[ranked.blocks.length - 1].text.includes('ContrastiveEmbed'));
    assert.ok(ranked.blocks[ranked.blocks.length - 1].score > ranked.blocks[1].score * 2);

    // Virtual file stream splitter preserves 1-based per-file line numbers and binds declared paths
    const docSection = Array.from({ length: 22 }, (_, i) =>
      i === 0
        ? '# Overview'
        : i === 1
          ? 'The task class must be declared in `evaluation/auto_test.py`. For basic evaluation we use `"TextOnlyMobileTask_AutoTest"`.'
          : `- documentation bullet ${i}`,
    ).join('\n');
    const stream = [
      docSection,
      '',
      'import os\nimport socket\nclass TextOnlyMobileTask_AutoTest:\n    def init_worker(self):\n        port = find_free_ports(start_port=6060)',
    ].join('\n');
    const vFiles = splitCorpusStreamIntoFiles(stream, { includeLineNumbers: true });
    assert.equal(vFiles.length, 2);
    assert.equal(vFiles[0].isOrientationDoc, true);
    assert.equal(vFiles[1].path, 'evaluation/auto_test.py');
    assert.ok(vFiles[1].text.includes('5:         port = find_free_ports(start_port=6060)'));

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

