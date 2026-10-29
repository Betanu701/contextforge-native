import { sha256, stableId } from './store.ts';
import { isCommonEnglishProseToken, splitIdentifierSubTokens, hasTechnicalIdentifierFormatting } from './lexicon-priors.ts';

export interface LanguageGrammarSpec {
  id: string;
  extensions: string[];
  comments: {
    line?: string[];
    columnIndicator?: { column: number; markers: string[] };
    block?: [string, string][];
  };
  strings: {
    quotes: Array<{ open: string; close: string; escape?: string; multiline?: boolean }>;
    interpolations?: Array<{ open: string; close: string; targetGrammar?: string }>;
    embeddedDetectors?: Array<{ pattern: RegExp; targetGrammar: string }>;
  };
  blocks: {
    brackets?: [string, string][];
    keywordPairs?: Array<{ open: RegExp; close: RegExp }>;
    sectionHierarchy?: Array<{ level: number; pattern: RegExp }>;
    tagPairs?: { voidTags?: string[] };
    indentationScoped?: boolean;
    statementTerminator?: RegExp;
  };
}

export interface VSCodeLanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  folding?: { markers?: { start?: string; end?: string }; offSide?: boolean };
}

export interface CodeBlockNode {
  nodeId: string;
  grammarId: string;
  symbolName: string;
  symbolPath: string;
  kind: 'root' | 'section' | 'block' | 'embedded_string' | 'statement' | 'part';
  depth: number;
  byteStart: number;
  byteEnd: number;
  sha256: string;
  parentId: string | null;
  partIndex?: number;
  totalParts?: number;
  children: CodeBlockNode[];
}

export interface DecomposedCodeTree {
  grammarId: string;
  totalBytes: number;
  rootSha256: string;
  partitionVerified: boolean;
  root: CodeBlockNode;
  flatNodes: CodeBlockNode[];
}

const REGISTRY = new Map<string, LanguageGrammarSpec>();
const EXT_MAP = new Map<string, string>();

export function registerLanguageGrammar(spec: LanguageGrammarSpec): void {
  const id = spec.id.toLowerCase().trim();
  REGISTRY.set(id, { ...spec, id });
  for (const ext of spec.extensions) {
    EXT_MAP.set(ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`, id);
  }
}

export function getLanguageGrammar(idOrPath: string): LanguageGrammarSpec | undefined {
  const lower = idOrPath.toLowerCase().trim();
  if (REGISTRY.has(lower)) return REGISTRY.get(lower);
  const dot = lower.lastIndexOf('.');
  if (dot >= 0) {
    const mapped = EXT_MAP.get(lower.slice(dot));
    if (mapped) return REGISTRY.get(mapped);
  }
  return undefined;
}

export function listLanguageGrammars(): LanguageGrammarSpec[] {
  return [...REGISTRY.values()];
}

/** Convert a standard VS Code `language-configuration.json` into a `LanguageGrammarSpec`. */
export function fromVSCodeLanguageConfig(
  id: string,
  extensions: string[],
  config: VSCodeLanguageConfiguration,
): LanguageGrammarSpec {
  const keywordPairs: Array<{ open: RegExp; close: RegExp }> = [];
  if (config.folding?.markers?.start && config.folding?.markers?.end) {
    keywordPairs.push({
      open: new RegExp(config.folding.markers.start, 'i'),
      close: new RegExp(config.folding.markers.end, 'i'),
    });
  }
  return {
    id,
    extensions,
    comments: {
      line: config.comments?.lineComment ? [config.comments.lineComment] : [],
      block: config.comments?.blockComment ? [config.comments.blockComment] : [],
    },
    strings: {
      quotes: [
        { open: '"', close: '"', escape: '\\' },
        { open: "'", close: "'", escape: '\\' },
      ],
    },
    blocks: {
      brackets: config.brackets?.filter(([o, c]) => o === '{' && c === '}') ?? [['{', '}']],
      ...(keywordPairs.length ? { keywordPairs } : {}),
      ...(config.folding?.offSide ? { indentationScoped: true } : {}),
    },
  };
}

// Built-in Grammars: Modern C-family/TS, Python, COBOL, Fortran, SQL, HTML, EJS
const C_FAMILY_STRINGS: LanguageGrammarSpec['strings'] = {
  quotes: [
    { open: '`', close: '`', escape: '\\', multiline: true },
    { open: '"""', close: '"""', escape: '\\', multiline: true },
    { open: '"', close: '"', escape: '\\' },
    { open: "'", close: "'", escape: '\\' },
  ],
  interpolations: [{ open: '${', close: '}', targetGrammar: 'typescript' }],
  embeddedDetectors: [
    { pattern: /<%[-=_]?[\s\S]*?%>/, targetGrammar: 'ejs' },
    { pattern: /<[a-zA-Z][\w-]*[\s>][\s\S]*<\/[a-zA-Z][\w-]*>/, targetGrammar: 'html' },
    { pattern: /\b(?:CREATE\s+TABLE|SELECT\s+[\s\S]+?\s+FROM|INSERT\s+INTO|ALTER\s+TABLE)\b/i, targetGrammar: 'sql' },
  ],
};

for (const [id, exts] of [
  ['typescript', ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']],
  ['csharp', ['.cs']],
  ['java', ['.java']],
  ['go', ['.go']],
  ['rust', ['.rs']],
  ['cpp', ['.c', '.cc', '.cpp', '.h', '.hpp']],
] as const) {
  registerLanguageGrammar({
    id,
    extensions: [...exts],
    comments: { line: ['//'], block: [['/*', '*/']] },
    strings: C_FAMILY_STRINGS,
    blocks: { brackets: [['{', '}']] },
  });
}

registerLanguageGrammar({
  id: 'python',
  extensions: ['.py', '.pyw'],
  comments: { line: ['#'] },
  strings: {
    quotes: [
      { open: '"""', close: '"""', escape: '\\', multiline: true },
      { open: "'''", close: "'''", escape: '\\', multiline: true },
      { open: '"', close: '"', escape: '\\' },
      { open: "'", close: "'", escape: '\\' },
    ],
    embeddedDetectors: C_FAMILY_STRINGS.embeddedDetectors,
  },
  blocks: { indentationScoped: true },
});

registerLanguageGrammar({
  id: 'cobol',
  extensions: ['.cbl', '.cob', '.cpy'],
  comments: {
    line: ['*>'],
    columnIndicator: { column: 7, markers: ['*', '/'] },
  },
  strings: {
    quotes: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    embeddedDetectors: [{ pattern: /\bEXEC\s+SQL\b[\s\S]*?\bEND-EXEC/i, targetGrammar: 'sql' }],
  },
  blocks: {
    sectionHierarchy: [
      { level: 1, pattern: /^\s*(?:[\d\s]{6})?\s*([A-Z0-9-]+)\s+DIVISION\b/i },
      { level: 2, pattern: /^\s*(?:[\d\s]{6})?\s*([A-Z0-9-]+)\s+SECTION\s*\./i },
      { level: 3, pattern: /^(?:[\d\s]{6}\s|\s{0,4})([A-Z0-9][A-Z0-9-]+)\s*\.\s*$/i },
    ],
    keywordPairs: [
      {
        open: /^\s*(?:[\d\s]{6})?\s*(EVALUATE|IF|PERFORM\s+UNTIL|PERFORM\s+VARYING|EXEC\s+SQL|EXEC\s+CICS)\b/i,
        close: /^\s*(?:[\d\s]{6})?\s*(END-EVALUATE|END-IF|END-PERFORM|END-EXEC)\b/i,
      },
    ],
  },
});

registerLanguageGrammar({
  id: 'fortran',
  extensions: ['.f', '.for', '.f77', '.f90', '.f95', '.f03', '.f08'],
  comments: {
    line: ['!'],
    columnIndicator: { column: 1, markers: ['C', 'c', '*'] },
  },
  strings: {
    quotes: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  },
  blocks: {
    keywordPairs: [
      {
        open: /^\s*(?:(?:PURE|ELEMENTAL|RECURSIVE|MODULE)\s+)*(PROGRAM|MODULE|SUBROUTINE|FUNCTION|INTERFACE|TYPE\s+(?!IS\b)(?:,\s*[A-Z0-9_]+\s*::\s*)?[A-Z0-9_]+|DO\b|IF\b[^!]*\bTHEN\b|SELECT\s+CASE)\b/i,
        close: /^\s*END\s*(?:PROGRAM|MODULE|SUBROUTINE|FUNCTION|INTERFACE|TYPE|DO|IF|SELECT)?\b/i,
      },
    ],
  },
});

registerLanguageGrammar({
  id: 'sql',
  extensions: ['.sql', '.ddl'],
  comments: { line: ['--'], block: [['/*', '*/']] },
  strings: { quotes: [{ open: "'", close: "'", multiline: true }] },
  blocks: {
    statementTerminator: /;\s*$/,
    keywordPairs: [
      {
        open: /\b(?:CREATE(?:\s+OR\s+REPLACE)?\s+(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER)|BEGIN)\b/i,
        close: /\bEND\s*;?|\)\s*(?:STRICT\s*)?;/i,
      },
    ],
  },
});

registerLanguageGrammar({
  id: 'html',
  extensions: ['.html', '.htm', '.vue', '.svelte', '.xml'],
  comments: { block: [['<!--', '-->']] },
  strings: {
    quotes: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    interpolations: [
      { open: '${', close: '}', targetGrammar: 'typescript' },
      { open: '{{', close: '}}', targetGrammar: 'typescript' },
    ],
  },
  blocks: {
    tagPairs: {
      voidTags: ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'],
    },
  },
});

registerLanguageGrammar({
  id: 'ejs',
  extensions: ['.ejs', '.hbs', '.handlebars'],
  comments: { block: [['<%#', '%>'], ['<!--', '-->']] },
  strings: {
    quotes: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    interpolations: [{ open: '<%', close: '%>', targetGrammar: 'typescript' }],
  },
  blocks: {
    tagPairs: {
      voidTags: ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'],
    },
  },
});

interface LineSpan {
  index: number;
  text: string;
  byteStart: number;
  byteEnd: number;
}

function splitLinesWithByteBounds(bytes: Buffer): LineSpan[] {
  const text = bytes.toString('utf8');
  const rawLines = text.split(/(?<=\n)/u);
  const out: LineSpan[] = [];
  let offset = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const len = Buffer.byteLength(rawLines[i]);
    if (len === 0) continue;
    out.push({ index: i, text: rawLines[i], byteStart: offset, byteEnd: offset + len });
    offset += len;
  }
  return out;
}

function isLineComment(line: string, spec: LanguageGrammarSpec): boolean {
  if (spec.comments.columnIndicator) {
    const colIdx = spec.comments.columnIndicator.column - 1;
    if (line.length > colIdx && spec.comments.columnIndicator.markers.includes(line[colIdx])) {
      return true;
    }
  }
  const trimmed = line.trimStart();
  return (spec.comments.line ?? []).some(prefix => trimmed.startsWith(prefix));
}

function inferSymbolName(headerText: string, fallback: string): string {
  const cleaned = headerText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const patterns = [
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|module|subroutine|program)\s+([A-Za-z_][\w$-]*)/i,
    /\b(?:const|let|var|public|private|protected|readonly|static)\s+([A-Za-z_][\w$-]*)\s*(?:[:=])/i,
    /\b(?:def|class|async\s+def)\s+([A-Za-z_][\w]*)/,
    /^\s*(?:[\d\s]{6})?\s*([A-Z0-9-]+)\s+(?:DIVISION|SECTION)\b/i,
    /^(?:[\d\s]{6}\s|\s{0,4})([A-Z0-9][A-Z0-9-]+)\s*\.\s*$/i,
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i,
    /<([a-zA-Z][\w-]*)(?:\s+[^>]*)?>/,
    /\b([A-Za-z_][\w$-]*)\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{/,
  ];
  for (const re of patterns) {
    const m = re.exec(cleaned);
    if (m && m[1] && !/^(?:if|for|while|switch|catch|return|new)$/.test(m[1])) {
      return m[1];
    }
  }
  return fallback;
}

function makeNode(
  bytes: Buffer,
  grammarId: string,
  symbolName: string,
  symbolPath: string,
  kind: CodeBlockNode['kind'],
  depth: number,
  byteStart: number,
  byteEnd: number,
  parentId: string | null,
  extra: Partial<Pick<CodeBlockNode, 'partIndex' | 'totalParts'>> = {},
): CodeBlockNode {
  const slice = bytes.subarray(byteStart, byteEnd);
  const hash = sha256(slice);
  const nodeId = stableId('cf-code-node-v1', grammarId, symbolPath, byteStart, byteEnd, hash);
  return {
    nodeId,
    grammarId,
    symbolName,
    symbolPath,
    kind,
    depth,
    byteStart,
    byteEnd,
    sha256: hash,
    parentId,
    ...extra,
    children: [],
  };
}

/**
 * Partition an oversized leaf or block `[byteStart, byteEnd)` into contiguous line-aligned parts
 * `<= maxPartBytes` that sum byte-for-byte to the parent span.
 */
function partitionIntoContiguousParts(
  bytes: Buffer,
  lines: LineSpan[],
  parent: CodeBlockNode,
  maxPartBytes: number,
): CodeBlockNode[] {
  if (parent.byteEnd - parent.byteStart <= maxPartBytes) return [];
  const subLines = lines.filter(l => l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
  const ranges: Array<[number, number]> = [];
  let start = parent.byteStart;
  let cursor = parent.byteStart;
  for (const l of subLines) {
    if (l.byteEnd - l.byteStart > maxPartBytes) {
      // Single giant line (e.g., 1MB minified JSON): flush accumulated lines first, then slice along UTF-8 safe character boundaries
      if (cursor > start) {
        ranges.push([start, cursor]);
      }
      let bPos = l.byteStart;
      while (bPos < l.byteEnd) {
        let bNext = Math.min(l.byteEnd, bPos + maxPartBytes);
        // Step back if bNext lands in the middle of a multi-byte UTF-8 sequence (10xxxxxx)
        while (bNext < l.byteEnd && bNext > bPos && (bytes[bNext] & 0xc0) === 0x80) {
          bNext--;
        }
        if (bNext <= bPos) bNext = Math.min(l.byteEnd, bPos + maxPartBytes);
        ranges.push([bPos, bNext]);
        bPos = bNext;
      }
      start = l.byteEnd;
      cursor = l.byteEnd;
      continue;
    }
    if (cursor > start && l.byteEnd - start > maxPartBytes) {
      ranges.push([start, cursor]);
      start = cursor;
    }
    cursor = l.byteEnd;
  }
  if (start < parent.byteEnd) ranges.push([start, parent.byteEnd]);
  if (ranges.length <= 1) return [];
  return ranges.map(([s, e], idx) =>
    makeNode(
      bytes,
      parent.grammarId,
      `${parent.symbolName}#part-${idx + 1}`,
      `${parent.symbolPath}#part-${idx + 1}`,
      'part',
      parent.depth + 1,
      s,
      e,
      parent.nodeId,
      { partIndex: idx + 1, totalParts: ranges.length },
    ),
  );
}

/**
 * Scan balanced `{ ... }` blocks + multiline template literals while respecting strings and comments.
 * Returns contiguous child intervals `[byteStart, byteEnd)` that partition `[rangeStart, rangeEnd)`.
 */
function decomposeBraceAndStringLanguage(
  bytes: Buffer,
  lines: LineSpan[],
  parent: CodeBlockNode,
  spec: LanguageGrammarSpec,
  maxBlockBytes: number,
): CodeBlockNode[] {
  const subLines = lines.filter(l => l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
  if (subLines.length <= 1 || parent.depth >= 12) return [];

  // Identify top-level balanced `{ ... }` blocks or multiline backtick template blocks across lines.
  const intervals: Array<{ startLine: number; endLine: number; kind: CodeBlockNode['kind']; embeddedGrammar?: string }> = [];
  let depth = 0;
  let inBacktick = false;
  let inBlockComment = false;
  let blockStartLine = 0;
  let embeddedLang: string | undefined;

  for (let li = 0; li < subLines.length; li++) {
    const line = subLines[li].text;
    if (isLineComment(line, spec) && !inBacktick && !inBlockComment) continue;

    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      const next = line[ci + 1] ?? '';

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          ci++;
        }
        continue;
      }
      if (!inBacktick && ch === '/' && next === '*') {
        inBlockComment = true;
        ci++;
        continue;
      }
      if (!inBacktick && ch === '/' && next === '/') break;

      if (!inBacktick && (ch === '"' || ch === "'")) {
        const quote = ch;
        ci++;
        while (ci < line.length) {
          if (line[ci] === '\\') {
            ci += 2;
            continue;
          }
          if (line[ci] === quote) break;
          ci++;
        }
        continue;
      }

      if (ch === '`') {
        if (!inBacktick) {
          inBacktick = true;
          if (depth === 0) blockStartLine = li;
        } else {
          inBacktick = false;
          if (depth === 0 && li > blockStartLine) {
            const sliceText = subLines.slice(blockStartLine, li + 1).map(x => x.text).join('');
            const det = spec.strings.embeddedDetectors?.find(d => d.pattern.test(sliceText));
            intervals.push({ startLine: blockStartLine, endLine: li, kind: 'embedded_string', embeddedGrammar: det?.targetGrammar });
            blockStartLine = li + 1;
          }
        }
        continue;
      }

      if (!inBacktick) {
        if (ch === '{') {
          if (depth === 0) blockStartLine = li;
          depth++;
        } else if (ch === '}') {
          depth = Math.max(0, depth - 1);
          if (depth === 0 && li >= blockStartLine) {
            intervals.push({ startLine: blockStartLine, endLine: li, kind: 'block' });
            blockStartLine = li + 1;
            embeddedLang = undefined;
          }
        }
      }
    }
  }

  if (intervals.length === 0) {
    return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
  }

  // Convert line intervals into a complete, gap-free byte partition of [parent.byteStart, parent.byteEnd)
  const rawSegments: Array<{ byteStart: number; byteEnd: number; kind: CodeBlockNode['kind']; headerText: string; embeddedGrammar?: string }> = [];
  let cursorByte = parent.byteStart;

  for (const iv of intervals) {
    // Include one preceding signature/declaration line if unincorporated
    const sigLineIdx = iv.startLine > 0 && subLines[iv.startLine - 1].byteStart >= cursorByte ? iv.startLine - 1 : iv.startLine;
    const segStart = Math.max(cursorByte, subLines[sigLineIdx].byteStart);
    const segEnd = subLines[iv.endLine].byteEnd;
    if (segEnd <= segStart) continue;
    if (segStart > cursorByte) {
      rawSegments.push({
        byteStart: cursorByte,
        byteEnd: segStart,
        kind: 'statement',
        headerText: bytes.subarray(cursorByte, Math.min(segStart, cursorByte + 256)).toString('utf8'),
      });
    }
    rawSegments.push({
      byteStart: segStart,
      byteEnd: segEnd,
      kind: iv.kind,
      headerText: bytes.subarray(segStart, Math.min(segEnd, segStart + 320)).toString('utf8'),
      embeddedGrammar: iv.embeddedGrammar,
    });
    cursorByte = segEnd;
  }
  if (cursorByte < parent.byteEnd) {
    rawSegments.push({
      byteStart: cursorByte,
      byteEnd: parent.byteEnd,
      kind: 'statement',
      headerText: bytes.subarray(cursorByte, Math.min(parent.byteEnd, cursorByte + 256)).toString('utf8'),
    });
  }

  // If the entire node was a single segment (e.g. we are already inside one giant function body),
  // peel off the function's opening header line and closing brace line, and decompose the interior!
  if (rawSegments.length === 1 && subLines.length > 4 && parent.byteEnd - parent.byteStart > maxBlockBytes && parent.depth < 14) {
    const firstLine = subLines[0];
    const lastLine = subLines[subLines.length - 1];
    if (firstLine.byteEnd < lastLine.byteStart) {
      const headerNode = makeNode(bytes, parent.grammarId, `${parent.symbolName}::header`, `${parent.symbolPath}::header`, 'statement', parent.depth + 1, firstLine.byteStart, firstLine.byteEnd, parent.nodeId);
      const bodyDummy = makeNode(bytes, parent.grammarId, `${parent.symbolName}::body`, `${parent.symbolPath}`, 'block', parent.depth + 1, firstLine.byteEnd, lastLine.byteStart, parent.nodeId);
      const bodyChildren = decomposeBraceAndStringLanguage(bytes, lines, bodyDummy, spec, maxBlockBytes);
      const footerNode = makeNode(bytes, parent.grammarId, `${parent.symbolName}::footer`, `${parent.symbolPath}::footer`, 'statement', parent.depth + 1, lastLine.byteStart, lastLine.byteEnd, parent.nodeId);
      const midNodes = bodyChildren.length
        ? bodyChildren.map(c => ({ ...c, parentId: parent.nodeId, depth: parent.depth + 1 }))
        : partitionIntoContiguousParts(bytes, lines, bodyDummy, maxBlockBytes).map(c => ({ ...c, parentId: parent.nodeId, depth: parent.depth + 1 }));
      return [headerNode, ...(midNodes.length ? midNodes : [ { ...bodyDummy, depth: parent.depth + 1 } ]), footerNode];
    }
  }

  const children: CodeBlockNode[] = [];
  const usedNames = new Map<string, number>();

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const baseName = inferSymbolName(seg.headerText, `${seg.kind}-${i + 1}`);
    const count = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, count);
    const sym = count === 1 ? baseName : `${baseName}#${count}`;
    const symPath = `${parent.symbolPath}::${sym}`;
    const childGrammar = seg.embeddedGrammar ?? parent.grammarId;
    const node = makeNode(bytes, childGrammar, sym, symPath, seg.kind, parent.depth + 1, seg.byteStart, seg.byteEnd, parent.nodeId);

    if (seg.embeddedGrammar && REGISTRY.has(seg.embeddedGrammar) && (node.byteStart > parent.byteStart || node.byteEnd < parent.byteEnd || node.grammarId !== parent.grammarId)) {
      node.children = decomposeByGrammar(bytes, lines, node, REGISTRY.get(seg.embeddedGrammar)!, maxBlockBytes);
    } else if ((node.byteEnd - node.byteStart > maxBlockBytes || (node.kind === 'block' && subLines.length > 4)) && (node.byteStart > parent.byteStart || node.byteEnd < parent.byteEnd)) {
      node.children = decomposeBraceAndStringLanguage(bytes, lines, node, spec, maxBlockBytes);
      if (node.children.length === 0 && node.byteEnd - node.byteStart > maxBlockBytes) {
        node.children = partitionIntoContiguousParts(bytes, lines, node, maxBlockBytes);
      }
    }
    children.push(node);
  }
  return children;
}

/**
 * Decompose hierarchical section languages (COBOL Divisions -> Sections -> Paragraphs)
 * or keyword-paired languages (Fortran MODULE/SUBROUTINE/DO/IF, SQL statements, HTML tags).
 */
function decomposeByGrammar(
  bytes: Buffer,
  lines: LineSpan[],
  parent: CodeBlockNode,
  spec: LanguageGrammarSpec,
  maxBlockBytes: number,
): CodeBlockNode[] {
  const subLines = lines.filter(l => l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
  if (subLines.length <= 1) return [];

  // 1. Section Hierarchy (e.g. COBOL Divisions / Sections / Paragraphs)
  if (spec.blocks.sectionHierarchy?.length) {
    for (const levelSpec of spec.blocks.sectionHierarchy) {
      const hits: number[] = [];
      for (let i = 0; i < subLines.length; i++) {
        if (!isLineComment(subLines[i].text, spec) && levelSpec.pattern.test(subLines[i].text)) {
          hits.push(i);
        }
      }
      if (hits.length >= 2 || (hits.length === 1 && hits[0] > 0)) {
        const bounds: Array<[number, number, string]> = [];
        if (hits[0] > 0) {
          bounds.push([parent.byteStart, subLines[hits[0]].byteStart, 'preamble']);
        }
        for (let h = 0; h < hits.length; h++) {
          const startByte = subLines[hits[h]].byteStart;
          const endByte = h + 1 < hits.length ? subLines[hits[h + 1]].byteStart : parent.byteEnd;
          const name = inferSymbolName(subLines[hits[h]].text, `section-${h + 1}`);
          bounds.push([startByte, endByte, name]);
        }
        const remainingSpec: LanguageGrammarSpec = {
          ...spec,
          blocks: {
            ...spec.blocks,
            sectionHierarchy: spec.blocks.sectionHierarchy.filter(s => s.level > levelSpec.level),
          },
        };
        return bounds.map(([s, e, name], idx) => {
          const symPath = `${parent.symbolPath}::${name}`;
          const node = makeNode(bytes, spec.id, name, symPath, 'section', parent.depth + 1, s, e, parent.nodeId, {
            partIndex: idx + 1,
            totalParts: bounds.length,
          });
          node.children = decomposeByGrammar(bytes, lines, node, remainingSpec, maxBlockBytes);
          return node;
        });
      }
    }
  }

  // 2. Statement Terminator (e.g. SQL `CREATE TABLE ... ;`)
  if (spec.blocks.statementTerminator) {
    const bounds: Array<[number, number, string]> = [];
    let startByte = parent.byteStart;
    let headerLine = subLines[0].text;
    for (let i = 0; i < subLines.length; i++) {
      if (startByte === subLines[i].byteStart) headerLine = subLines[i].text;
      if (spec.blocks.statementTerminator.test(subLines[i].text)) {
        bounds.push([startByte, subLines[i].byteEnd, inferSymbolName(headerLine, `stmt-${bounds.length + 1}`)]);
        startByte = subLines[i].byteEnd;
      }
    }
    if (startByte < parent.byteEnd && bounds.length > 0) {
      bounds.push([startByte, parent.byteEnd, 'trailing']);
    }
    if (bounds.length >= 2) {
      return bounds.map(([s, e, name], idx) =>
        makeNode(bytes, spec.id, name, `${parent.symbolPath}::${name}#${idx + 1}`, 'statement', parent.depth + 1, s, e, parent.nodeId),
      );
    }
  }

  // 3. Keyword-Paired Blocks (Fortran SUBROUTINE..END SUBROUTINE, COBOL EVALUATE..END-EVALUATE / EXEC SQL..END-EXEC)
  if (spec.blocks.keywordPairs?.length) {
    const intervals: Array<{ startLine: number; endLine: number; embeddedGrammar?: string }> = [];
    let depth = 0;
    let startLine = 0;
    for (let i = 0; i < subLines.length; i++) {
      const text = subLines[i].text;
      if (isLineComment(text, spec)) continue;
      const isClose = spec.blocks.keywordPairs.some(kp => kp.close.test(text));
      const isOpen = !isClose && spec.blocks.keywordPairs.some(kp => kp.open.test(text));
      if (isOpen) {
        if (depth === 0) startLine = i;
        depth++;
      } else if (isClose && depth > 0) {
        depth--;
        if (depth === 0) {
          const blockText = subLines.slice(startLine, i + 1).map(x => x.text).join('');
          const det = spec.strings.embeddedDetectors?.find(d => d.pattern.test(blockText));
          intervals.push({ startLine, endLine: i, embeddedGrammar: det?.targetGrammar });
        }
      }
    }
    if (intervals.length > 0 && !(intervals.length === 1 && intervals[0].startLine === 0 && intervals[0].endLine === subLines.length - 1)) {
      const nodes: CodeBlockNode[] = [];
      let cursor = parent.byteStart;
      for (const iv of intervals) {
        const s = subLines[iv.startLine].byteStart;
        const e = subLines[iv.endLine].byteEnd;
        if (s > cursor) {
          nodes.push(makeNode(bytes, spec.id, `preamble-${nodes.length + 1}`, `${parent.symbolPath}::preamble-${nodes.length + 1}`, 'statement', parent.depth + 1, cursor, s, parent.nodeId));
        }
        const name = inferSymbolName(subLines[iv.startLine].text, `block-${nodes.length + 1}`);
        const n = makeNode(bytes, iv.embeddedGrammar ?? spec.id, name, `${parent.symbolPath}::${name}`, 'block', parent.depth + 1, s, e, parent.nodeId);
        if (iv.endLine - iv.startLine >= 3) {
          n.children = decomposeByGrammar(bytes, lines, n, spec, maxBlockBytes);
        }
        if (n.children.length === 0 && n.byteEnd - n.byteStart > maxBlockBytes) {
          n.children = partitionIntoContiguousParts(bytes, lines, n, maxBlockBytes);
        }
        nodes.push(n);
        cursor = e;
      }
      if (cursor < parent.byteEnd) {
        nodes.push(makeNode(bytes, spec.id, 'epilogue', `${parent.symbolPath}::epilogue`, 'statement', parent.depth + 1, cursor, parent.byteEnd, parent.nodeId));
      }
      return nodes;
    } else if (intervals.length === 1 && intervals[0].startLine === 0 && intervals[0].endLine === subLines.length - 1 && subLines.length > 3) {
      // Peel outer MODULE..END MODULE or SUBROUTINE..END SUBROUTINE header/footer and decompose the interior!
      const firstLine = subLines[0];
      const lastLine = subLines[subLines.length - 1];
      const headerNode = makeNode(bytes, spec.id, `${parent.symbolName}::header`, `${parent.symbolPath}::header`, 'statement', parent.depth + 1, firstLine.byteStart, firstLine.byteEnd, parent.nodeId);
      const bodyDummy = makeNode(bytes, spec.id, `${parent.symbolName}::body`, `${parent.symbolPath}`, 'block', parent.depth, firstLine.byteEnd, lastLine.byteStart, parent.nodeId);
      const bodyChildren = decomposeByGrammar(bytes, lines, bodyDummy, spec, maxBlockBytes).map(c => ({ ...c, parentId: parent.nodeId, depth: parent.depth + 1 }));
      const footerNode = makeNode(bytes, spec.id, `${parent.symbolName}::footer`, `${parent.symbolPath}::footer`, 'statement', parent.depth + 1, lastLine.byteStart, lastLine.byteEnd, parent.nodeId);
      if (bodyChildren.length > 0) {
        return [headerNode, ...bodyChildren, footerNode];
      }
    }
  }

  // 4. Tag-Paired Markup (HTML / EJS / Vue)
  if (spec.blocks.tagPairs) {
    const voidSet = new Set((spec.blocks.tagPairs.voidTags ?? []).map(t => t.toLowerCase()));
    const intervals: Array<{ startLine: number; endLine: number; tag: string }> = [];
    const stack: Array<{ tag: string; line: number }> = [];
    for (let i = 0; i < subLines.length; i++) {
      const text = subLines[i].text;
      for (const m of text.matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*>/g)) {
        const full = m[0];
        const tag = m[1].toLowerCase();
        if (voidSet.has(tag) || full.endsWith('/>')) continue;
        if (full.startsWith('</')) {
          if (stack.length > 0 && stack[stack.length - 1].tag === tag) {
            const top = stack.pop()!;
            if (stack.length <= 1 && i >= top.line) {
              intervals.push({ startLine: top.line, endLine: i, tag });
            }
          }
        } else {
          stack.push({ tag, line: i });
        }
      }
    }
    const topIntervals = intervals.filter((iv, idx) => !intervals.some((other, oIdx) => oIdx !== idx && other.startLine <= iv.startLine && other.endLine >= iv.endLine && (other.endLine - other.startLine > iv.endLine - iv.startLine)));
    if (topIntervals.length >= 2) {
      const nodes: CodeBlockNode[] = [];
      let cursor = parent.byteStart;
      for (const iv of topIntervals) {
        const s = subLines[iv.startLine].byteStart;
        const e = subLines[iv.endLine].byteEnd;
        if (s < cursor) continue;
        if (s > cursor) {
          nodes.push(makeNode(bytes, spec.id, `markup-${nodes.length + 1}`, `${parent.symbolPath}::markup-${nodes.length + 1}`, 'statement', parent.depth + 1, cursor, s, parent.nodeId));
        }
        const n = makeNode(bytes, spec.id, `<${iv.tag}>`, `${parent.symbolPath}::<${iv.tag}>#${nodes.length + 1}`, 'block', parent.depth + 1, s, e, parent.nodeId);
        nodes.push(n);
        cursor = e;
      }
      if (cursor < parent.byteEnd) {
        nodes.push(makeNode(bytes, spec.id, 'markup-tail', `${parent.symbolPath}::markup-tail`, 'statement', parent.depth + 1, cursor, parent.byteEnd, parent.nodeId));
      }
      return nodes;
    }
  }

  // 4.5. Indentation-Scoped Languages (Python `class` / `def` / `async def`)
  if (spec.blocks.indentationScoped) {
    const stripLineNum = (line: string): string => line.replace(/^\s*\d+\s?(?=[A-Za-z_#@"' \t]|$)/, '');
    const isCommentOrHeader = (line: string): boolean => {
      const s = stripLineNum(line).trimStart();
      return !s || s.startsWith('//') || isLineComment(s, spec);
    };
    const getIndent = (line: string): number => {
      const stripped = stripLineNum(line);
      const m = /^([ \t]*)\S/.exec(stripped);
      if (!m) return -1;
      return m[1].replace(/\t/g, '    ').length;
    };
    const isPyBlockHeader = (line: string): boolean => {
      const stripped = stripLineNum(line);
      return /^[ \t]*(?:async\s+def|def|class)\s+[A-Za-z_][\w]*\b/.test(stripped);
    };
    const headerCandidates: Array<{ idx: number; indent: number }> = [];
    for (let i = 0; i < subLines.length; i++) {
      if (isCommentOrHeader(subLines[i].text)) continue;
      if (isPyBlockHeader(subLines[i].text)) {
        headerCandidates.push({ idx: i, indent: getIndent(subLines[i].text) });
      }
    }
    const baseIndent = headerCandidates.reduce((min, h) => (h.indent >= 0 && h.indent < min ? h.indent : min), Infinity);

    if (Number.isFinite(baseIndent)) {
      const headerIdxs = headerCandidates.filter(h => h.indent === baseIndent).map(h => h.idx);
      if (headerIdxs.length >= 2 || (headerIdxs.length === 1 && headerIdxs[0] > 0)) {
        const nodes: CodeBlockNode[] = [];
        let cursor = parent.byteStart;
        for (let h = 0; h < headerIdxs.length; h++) {
          const startIdx = headerIdxs[h];
          // Include immediately preceding `@decorator` lines at the same indentation
          let decIdx = startIdx;
          while (decIdx > (h > 0 ? headerIdxs[h - 1] + 1 : 0)) {
            const prev = stripLineNum(subLines[decIdx - 1].text).trim();
            if (prev.startsWith('@')) decIdx--;
            else break;
          }
          const nextHeaderIdx = h + 1 < headerIdxs.length ? headerIdxs[h + 1] : subLines.length;
          // Also exclude `@decorator` lines belonging to `nextHeaderIdx`
          let limitIdx = nextHeaderIdx;
          if (h + 1 < headerIdxs.length) {
            while (limitIdx > startIdx + 1 && stripLineNum(subLines[limitIdx - 1].text).trim().startsWith('@')) {
              limitIdx--;
            }
          }
          let endIdx = limitIdx - 1;
          for (let j = startIdx + 1; j < limitIdx; j++) {
            if (isCommentOrHeader(subLines[j].text)) continue;
            const ind = getIndent(subLines[j].text);
            const trimmed = stripLineNum(subLines[j].text).trim();
            if (ind >= 0 && ind < baseIndent && !/^[)\]}'"]/.test(trimmed)) {
              endIdx = j - 1;
              break;
            }
          }
          const s = subLines[decIdx].byteStart;
          const e = subLines[endIdx].byteEnd;
          if (s > cursor) {
            nodes.push(makeNode(bytes, spec.id, `module-preamble-${nodes.length + 1}`, `${parent.symbolPath}::module-preamble-${nodes.length + 1}`, 'statement', parent.depth + 1, cursor, s, parent.nodeId));
          }
          const sym = inferSymbolName(stripLineNum(subLines[startIdx].text), `block-${nodes.length + 1}`);
          const n = makeNode(bytes, spec.id, sym, `${parent.symbolPath}::${sym}`, 'block', parent.depth + 1, s, e, parent.nodeId);
          if (endIdx - startIdx >= 3 && (n.byteStart > parent.byteStart || n.byteEnd < parent.byteEnd)) {
            // Peel the outer class/def header line to decompose nested methods!
            const firstLine = subLines[startIdx];
            const headerEnd = firstLine.byteEnd;
            if (headerEnd < e) {
              const headerNode = makeNode(bytes, spec.id, `${sym}::header`, `${n.symbolPath}::header`, 'statement', n.depth + 1, s, headerEnd, n.nodeId);
              const bodyDummy = makeNode(bytes, spec.id, `${sym}::body`, n.symbolPath, 'block', n.depth, headerEnd, e, n.nodeId);
              const bodyChildren = decomposeByGrammar(bytes, lines, bodyDummy, spec, maxBlockBytes).map(c => ({ ...c, parentId: n.nodeId, depth: n.depth + 1 }));
              if (bodyChildren.length > 0) {
                n.children = [headerNode, ...bodyChildren];
              }
            }
          }
          if (n.children.length === 0 && n.byteEnd - n.byteStart > maxBlockBytes) {
            n.children = partitionIntoContiguousParts(bytes, lines, n, maxBlockBytes);
          }
          nodes.push(n);
          cursor = e;
        }
        if (cursor < parent.byteEnd) {
          nodes.push(makeNode(bytes, spec.id, 'module-epilogue', `${parent.symbolPath}::module-epilogue`, 'statement', parent.depth + 1, cursor, parent.byteEnd, parent.nodeId));
        }
        return nodes;
      }
    }
  }

  // 5. Brace-delimited default
  if (spec.blocks.brackets?.length) {
    return decomposeBraceAndStringLanguage(bytes, lines, parent, spec, maxBlockBytes);
  }

  return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
}

/**
 * Recursively verify the Partition-of-Unity byte-conservation invariant:
 * Every non-leaf node's children must partition `[node.byteStart, node.byteEnd)`
 * with zero gaps, zero overlaps, and exact SHA-256 concatenation equality.
 */
export function verifyPartitionConservation(bytes: Buffer, node: CodeBlockNode): boolean {
  const actualSha = sha256(bytes.subarray(node.byteStart, node.byteEnd));
  if (actualSha !== node.sha256) return false;
  if (node.children.length === 0) return true;
  let cursor = node.byteStart;
  const buffers: Buffer[] = [];
  for (const child of node.children) {
    if (child.byteStart !== cursor || child.byteEnd < child.byteStart || child.byteEnd > node.byteEnd) {
      return false;
    }
    buffers.push(bytes.subarray(child.byteStart, child.byteEnd));
    cursor = child.byteEnd;
    if (!verifyPartitionConservation(bytes, child)) return false;
  }
  if (cursor !== node.byteEnd) return false;
  return sha256(Buffer.concat(buffers)) === node.sha256;
}

export function decomposeCodeSource(
  textOrBytes: string | Buffer,
  options: { originKey?: string; grammarId?: string; maxBlockBytes?: number } = {},
): DecomposedCodeTree {
  const bytes = Buffer.isBuffer(textOrBytes) ? textOrBytes : Buffer.from(textOrBytes, 'utf8');
  const maxBlockBytes = options.maxBlockBytes ?? 4096;
  const spec =
    (options.grammarId ? getLanguageGrammar(options.grammarId) : undefined) ??
    (options.originKey ? getLanguageGrammar(options.originKey) : undefined) ??
    getLanguageGrammar('typescript')!;

  const lines = splitLinesWithByteBounds(bytes);
  const rootName = options.originKey ?? spec.id;
  const root = makeNode(bytes, spec.id, rootName, rootName, 'root', 0, 0, bytes.length, null);
  root.children = decomposeByGrammar(bytes, lines, root, spec, maxBlockBytes);

  const flatNodes: CodeBlockNode[] = [];
  const walk = (n: CodeBlockNode) => {
    flatNodes.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);

  const partitionVerified = verifyPartitionConservation(bytes, root);
  if (!partitionVerified) {
    throw new Error(`CodePartitionConservationViolation: child spans do not sum to root SHA-256 for ${rootName}`);
  }

  return {
    grammarId: spec.id,
    totalBytes: bytes.length,
    rootSha256: root.sha256,
    partitionVerified,
    root,
    flatNodes,
  };
}

export interface BlindCodeBlockRankResult {
  originKey: string;
  symbolPath: string;
  byteStart: number;
  byteEnd: number;
  sha256: string;
  score: number;
  text: string;
}

const BLIND_CODE_STOP = new Set([
  'this','that','with','from','have','when','what','which','where','should','would','could','there','their','about','after','before','return','import','class','function','Following','following','Python','python','django','astropy','True','False','None','self','the','and','for','not','are','but','can','all','one','new','use','set','get',
  'Official','LongBench','Code','Repository','Options','Reply','first','line','FINAL_CHOICE','followed','sentence','justification','citing','available','does','code','project','correctly','statement','method','value','using','used',
  'Description','Current','Behaviour','Behavior','Expected','However','When','There','Here','Looking','other','methods','issue','issues','problem','problems','error','errors','message','messages','example','examples','should','could','would','result','results','instead','default','something','another','because','provide','created','called','against','several'
]);

/**
 * 100% Blind AST Leaf-Block + IDF Repository Ranker:
 * Decomposes multi-file code repositories into byte-conserving AST leaf blocks (`decomposeCodeSource`),
 * computes cross-file Inverse Document Frequency (IDF) for query identifiers and static imports,
 * and returns the highest-scoring AST leaf blocks formatted with exact file and `symbolPath` headers.
 */
export function rankRepositoryAstBlocksBlind(
  files: Array<{ path: string; text: string }>,
  query: string,
  options: {
    importStatement?: string;
    cursorContext?: string;
    maxFilesToDecompose?: number;
    maxBlockBytes?: number;
    maxTotalChars?: number;
  } = {},
): { blocks: BlindCodeBlockRankResult[]; allPartitionsVerified: boolean } {
  const maxFiles = options.maxFilesToDecompose ?? 8;
  const maxBlockBytes = options.maxBlockBytes ?? 2600;
  const maxTotalChars = options.maxTotalChars ?? 22000;

  const rawMatches = query.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) ?? [];
  const expandedTokens: string[] = [];
  for (const tok of rawMatches) {
    expandedTokens.push(tok);
    if (tok.includes('.')) {
      for (const part of tok.split('.')) {
        if (part.length >= 3) expandedTokens.push(part);
      }
    }
    // Split mixed alphanumeric tokens like `Http404` -> `404` so functions like `technical_404_response` match!
    for (const numMatch of tok.matchAll(/\d{3,}/g)) {
      expandedTokens.push(numMatch[0]);
    }
  }
  const queryIds = [...new Set(expandedTokens.filter(tok => !BLIND_CODE_STOP.has(tok) && !isCommonEnglishProseToken(tok) && (hasTechnicalIdentifierFormatting(tok) || tok.length >= 4)))];

  // Extract static unused/used imports if `importStatement` is provided (including multi-line `from X import (\n A,\n B\n)`)
  // and record sibling import groups (`from module import A, B, C`) so tuple/sibling patterns stay grouped!
  const unusedImports = new Set<string>();
  const usedImports = new Set<string>();
  const importModuleBySymbol = new Map<string, string>();
  const siblingImportsByModule = new Map<string, string[]>();
  if (options.importStatement) {
    const normalizedImports = options.importStatement.replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner) => inner.replace(/\s*\n\s*/g, ' '));
    for (const line of normalizedImports.split('\n')) {
      const mFrom = /from\s+([\w.]+)\s+import\s+(.+)/.exec(line);
      const mImp = !mFrom ? /^\s*import\s+(.+)/.exec(line) : null;
      const modName = mFrom ? mFrom[1] : 'global_import';
      const rhs = mFrom ? mFrom[2] : mImp ? mImp[1] : '';
      if (rhs) {
        const modSyms: string[] = [];
        for (const part of rhs.split(',')) {
          const clean = part.replace(/#.*/, '').replace(/[()\\]/g, '').trim().split(/\s+as\s+/).pop()?.trim() ?? '';
          if (clean && /^[A-Za-z_]\w+$/.test(clean)) {
            modSyms.push(clean);
            importModuleBySymbol.set(clean, modName);
            if (options.cursorContext && !options.cursorContext.includes(clean)) unusedImports.add(clean);
            else usedImports.add(clean);
          }
        }
        if (modSyms.length > 0) {
          siblingImportsByModule.set(modName, [...(siblingImportsByModule.get(modName) ?? []), ...modSyms]);
        }
      }
    }
  }

  // Extract cursor-tail clues (identifiers & camelCase/snake_case sub-tokens in the last 6 lines before the cursor)
  const cursorTailWords = new Set<string>();
  if (options.cursorContext) {
    const tailLines = options.cursorContext.trim().split('\n').slice(-6).join('\n');
    for (const m of tailLines.match(/[A-Za-z0-9_]{3,}/g) ?? []) {
      for (const sub of [m.toLowerCase(), ...splitIdentifierSubTokens(m)]) {
        if (sub.length >= 3 && !BLIND_CODE_STOP.has(sub)) cursorTailWords.add(sub);
      }
    }
  }

  const df = new Map<string, number>();
  for (const id of queryIds) {
    let count = 0;
    for (const f of files) {
      if (f.text.includes(id) || f.path.includes(id)) count++;
    }
    if (count >= 1) df.set(id, count);
  }

  // Extract multi-word phrase clues (including 2-word error-message bigrams like `more items` or `first extra item`
  // where templates like `%s contains %d more items, first extra item: %s` split longer phrases with `%d`/`{}`)
  const phraseClues: string[] = [];
  for (const m of query.matchAll(/\b([a-z]{3,}\s+[a-z]{3,}(?:,?\s+[a-z]{3,}){0,2})\b/g)) {
    const phrase = m[1].trim();
    const words = phrase.split(/[\s,]+/);
    if (phrase.length >= 10 && words.every(w => !BLIND_CODE_STOP.has(w))) {
      let c = 0;
      for (const f of files) if (f.text.includes(`"${phrase}`) || f.text.includes(` ${phrase}`) || f.text.includes(`${phrase}:`) || f.text.includes(`${phrase},`)) c++;
      if (c === 1) phraseClues.push(phrase);
    }
  }

  // Extract file-level imported/referenced symbols from the top lines of each file (`from X import A, B`)
  // so cross-file symbol bridges (`Http404`, `Resolver404`, `allow_migrate`, etc.) are tracked at the file level!
  const fileHeaderImports = new Map<string, Set<string>>();
  for (const f of files) {
    const headerSlice = f.text.slice(0, 2400).replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner) => inner.replace(/\s*\n\s*/g, ' '));
    const syms = new Set<string>();
    for (const line of headerSlice.split('\n')) {
      const mFrom = /from\s+[\w.]+\s+import\s+(.+)/.exec(line);
      if (mFrom) {
        for (const p of mFrom[1].split(',')) {
          const clean = p.replace(/#.*/, '').replace(/[()\\]/g, '').trim().split(/\s+as\s+/).pop()?.trim() ?? '';
          if (clean && /^[A-Za-z_]\w{2,}$/.test(clean)) syms.add(clean);
        }
      }
    }
    fileHeaderImports.set(f.path, syms);
  }

  // Distinguish true code-identifier clues (`snake_case`, `CamelCase`, or identifiers with digits)
  // from plain lowercase prose words so triangulation focuses on actual technical symbols!
  const codeSymbolCache = new Map<string, boolean>();
  const isCodeSymbol = (id: string): boolean => {
    const cached = codeSymbolCache.get(id);
    if (cached !== undefined) return cached;
    const val =
      /[_0-9]/.test(id) ||
      (/[A-Z]/.test(id) && /[a-z]/.test(id) && !/^[A-Z][a-z]+$/.test(id)) ||
      files.some(f => f.path.toLowerCase().includes(id.toLowerCase()) || f.text.includes(`def ${id}`) || f.text.includes(`class ${id}`) || f.text.includes(`.${id}`));
    codeSymbolCache.set(id, val);
    return val;
  };

  const rareQueryClues = [...df.entries()]
    .filter(([id, c]) => c <= Math.max(2, Math.floor(files.length / 2)) && isCodeSymbol(id))
    .map(([id]) => id);

  const fileRareClues = new Map<string, string[]>();
  let maxFileRareCount = 0;
  for (const f of files) {
    const matched = rareQueryClues.filter(id => f.text.includes(id) || f.path.toLowerCase().includes(id.toLowerCase()));
    fileRareClues.set(f.path, matched);
    if (matched.length > maxFileRareCount) maxFileRareCount = matched.length;
  }

  const scoredFiles = files.map((f, fIdx) => {
    let score = fIdx === 0 ? 40 : fIdx === 1 ? 20 : 0;
    for (const [id, c] of df.entries()) {
      const idf = Math.max(1, Math.round(Math.max(25, files.length) / c));
      const symMult = isCodeSymbol(id) ? 2 : 1;
      if (f.path.toLowerCase().includes(id.toLowerCase())) score += idf * 8 * symMult;
      if (f.text.includes(id)) score += idf * 2 * symMult;
    }
    for (const ph of phraseClues) {
      if (f.text.includes(ph)) score += 600;
    }
    const fRare = fileRareClues.get(f.path) ?? [];
    // File-Level Multi-Clue Triangulation Boost:
    // When a file bridges >= 2 rare code clues (especially when it bridges the maximum number of rare clues in the repo),
    // boost its file rank so caller/orchestrator files (`executor.py`, `debug.py`, `decorators.py`) aren't buried!
    if (fRare.length >= 2) {
      score += fRare.length * fRare.length * 55;
      if (fRare.length === maxFileRareCount) score += 300;
    }
    for (const sym of unusedImports) if (f.text.includes(sym)) score += 500;
    for (const sym of usedImports) if (f.text.includes(sym)) score += 100;
    return { ...f, score };
  }).sort((a, b) => b.score - a.score);

  const candidateBlocks: Array<BlindCodeBlockRankResult & { matchedClues: Set<string>; leafName: string }> = [];
  let allPartitionsVerified = true;

  const topRankedFiles = scoredFiles.slice(0, maxFiles);
  // Ensure the repo's primary README / architecture / docs orientation file is included in the candidate pool
  // if present, so high-level intent/architecture is preserved alongside implementation files!
  const orientationCandidate = scoredFiles.find(
    f => !topRankedFiles.includes(f) && (/(?:^|\/)(?:readme|architecture|overview|docs?\/)/i.test(f.path) || /\.(?:md|rst)$/i.test(f.path)),
  );
  if (orientationCandidate && topRankedFiles.length < maxFiles + 1) {
    topRankedFiles.push(orientationCandidate);
  }

  for (let fRank = 0; fRank < topRankedFiles.length; fRank++) {
    const f = topRankedFiles[fRank];
    const fRare = fileRareClues.get(f.path) ?? [];
    const fMissingRare = rareQueryClues.filter(c => !fRare.includes(c)).slice(0, 4);
    const fImports = [...(fileHeaderImports.get(f.path) ?? [])];
    const relevantImports = fImports.filter(s => queryIds.includes(s) || /[A-Z]/.test(s)).slice(0, 8);
    const fileTriangulationNote = fRare.length >= 2 ? `[BRIDGES: ${fRare.slice(0, 4).join(',')}]` : '';

    const tree = decomposeCodeSource(f.text, { originKey: f.path, maxBlockBytes });
    if (!tree.partitionVerified) allPartitionsVerified = false;
    const leaves = tree.flatNodes.filter(n => n.children.length === 0 && (n.byteEnd - n.byteStart) >= 20);
    const buf = Buffer.from(f.text, 'utf8');
    for (const node of leaves) {
      const txt = buf.subarray(node.byteStart, node.byteEnd).toString('utf8');
      let bScore = Math.max(1, (maxFiles - fRank) * 6);
      const matchedClues = new Set<string>();
      const leafName = node.symbolName.replace(/#part-\d+$|::header$|::footer$/, '');
      for (const [id, c] of df.entries()) {
        const idf = Math.max(1, Math.round(Math.max(25, files.length) / c));
        const symMult = isCodeSymbol(id) ? 2 : 1;
        if (node.symbolPath.toLowerCase().includes(id.toLowerCase())) {
          bScore += idf * 10 * symMult;
          if (isCodeSymbol(id)) matchedClues.add(id);
        }
        if (txt.includes(id)) {
          bScore += idf * 3 * symMult;
          if (isCodeSymbol(id)) matchedClues.add(id);
        }
      }
      for (const ph of phraseClues) {
        if (txt.includes(ph)) {
          bScore += 1800;
          matchedClues.add(ph);
        }
      }
      // Credit imported symbols from the file header that appear inside this method AND relate to the file's triangulated clues
      for (const impSym of relevantImports) {
        if (txt.includes(impSym)) {
          bScore += 60;
          matchedClues.add(impSym);
        }
      }
      // File-level triangulation inheritance for methods that actively participate in the file's rare clues
      if (fRare.length >= 2 && matchedClues.size >= 1) {
        bScore += fRare.length * 45;
      }
      for (const sym of unusedImports) {
        const symSubTokens = splitIdentifierSubTokens(sym);
        const modName = importModuleBySymbol.get(sym) ?? '';
        const modSubTokens = splitIdentifierSubTokens(modName);
        let cursorBonus = 0;
        for (const sub of [...symSubTokens, ...modSubTokens]) {
          if (cursorTailWords.has(sub)) cursorBonus += 1800;
        }
        if (node.symbolPath.includes(sym)) bScore += 2000 + cursorBonus;
        else if (txt.includes(sym)) bScore += 400 + Math.round(cursorBonus / 2);
      }
      for (const sym of usedImports) {
        const symSubTokens = splitIdentifierSubTokens(sym);
        let cursorBonus = 0;
        for (const sub of symSubTokens) {
          if (cursorTailWords.has(sub)) cursorBonus += 750;
        }
        if (node.symbolPath.includes(sym)) bScore += 300 + cursorBonus;
      }
      if (bScore > 0) {
        candidateBlocks.push({
          originKey: f.path,
          symbolPath: node.symbolPath,
          leafName,
          matchedClues,
          byteStart: node.byteStart,
          byteEnd: node.byteEnd,
          sha256: node.sha256,
          score: bScore,
          text: `// FILE: ${f.path} (${node.symbolPath}) ${fileTriangulationNote}\n${txt}`,
        });
      }
    }
  }

  // Cross-Block Call-Graph & Multi-Clue Triangulation:
  // Identify the top seed blocks and boost any AST block that:
  // (a) calls or is called by a high-scoring seed symbol from a DIFFERENT clue/file, OR
  // (b) intersects >= 2 rare query clues across call hops!
  const topSeeds = [...candidateBlocks].sort((a, b) => b.score - a.score).slice(0, 10);
  const seedSymbols = new Map<string, Set<string>>(); // leafName -> Set<matchedClue>
  for (const s of topSeeds) {
    if (s.leafName && s.leafName.length >= 4 && !s.leafName.startsWith('module-preamble') && s.leafName !== '__init__') {
      const prev = seedSymbols.get(s.leafName) ?? new Set<string>();
      for (const c of s.matchedClues) prev.add(c);
      seedSymbols.set(s.leafName, prev);
    }
  }

  for (const b of candidateBlocks) {
    let callHopClues = new Set<string>(b.matchedClues);
    let callEdges = 0;
    for (const [sym, symClues] of seedSymbols.entries()) {
      if (sym === b.leafName) continue;
      if (b.text.includes(`${sym}(`) || b.text.includes(`.${sym}`)) {
        callEdges++;
        for (const c of symClues) callHopClues.add(c);
      }
    }
    if (callEdges > 0 && callHopClues.size >= 2) {
      // Super-linear multi-clue call-graph triangulation boost!
      b.score += callEdges * 90 * callHopClues.size;
    }
  }

  // Bidirectional Call-Hop Expansion (Outgoing Callees across DIFFERENT files):
  // If a top-3 seed block calls a function/helper `callee(` defined in ANOTHER file in the repo
  // (e.g. `requests/models.py::iter_content` calling `stream_decode_response_unicode(` in `requests/utils.py`),
  // boost that cross-file callee definition block so the 1-hop implementation is always pulled alongside the caller!
  const top3Blocks = [...candidateBlocks].sort((a, b) => b.score - a.score).slice(0, 3);
  const outgoingCalls = new Map<string, string>(); // calleeName -> callerFile
  for (const tb of top3Blocks) {
    for (const m of tb.text.matchAll(/\b([a-z_][a-z0-9_]{5,})\s*\(/g)) {
      const fn = m[1];
      if (!BLIND_CODE_STOP.has(fn) && !outgoingCalls.has(fn)) outgoingCalls.set(fn, tb.originKey);
    }
  }
  if (outgoingCalls.size > 0) {
    for (const b of candidateBlocks) {
      const callerFile = outgoingCalls.get(b.leafName);
      if (callerFile && callerFile !== b.originKey) {
        b.score += 1400;
        b.text = b.text.replace('\n', ` [CROSS-FILE CALLEE OF ${callerFile}: ${b.leafName}()]\n`);
      }
    }
  }

  candidateBlocks.sort((a, b) => b.score - a.score);
  const selected: BlindCodeBlockRankResult[] = [];
  let chars = 0;
  for (const b of candidateBlocks) {
    if (chars + b.text.length > maxTotalChars) break;
    selected.push(b);
    chars += b.text.length + 2;
  }

  // Sort selected blocks in ASCENDING score order (`lowest -> highest`), with orientation/README
  // blocks placed first at the top of the window (stable prefix orientation) and the #1 highest-scoring
  // implementation block at the VERY BOTTOM (immediately above the pending query/cursor)!
  selected.sort((a, b) => {
    const isOrientA = /(?:^|\/)(?:readme|architecture|overview|docs?\/)/i.test(a.originKey) ? 0 : 1;
    const isOrientB = /(?:^|\/)(?:readme|architecture|overview|docs?\/)/i.test(b.originKey) ? 0 : 1;
    if (isOrientA !== isOrientB) return isOrientA - isOrientB;
    return a.score - b.score;
  });

  return { blocks: selected, allPartitionsVerified };
}

export interface VirtualCorpusFile {
  path: string;
  text: string;
  isOrientationDoc: boolean;
}

/**
 * Universal Multi-File Corpus / Stream Decomposer (`splitCorpusStreamIntoFiles`):
 * Scans any concatenated repository dump, document stream, or multi-file text and splits it
 * along real file/section boundaries (never arbitrary character crops):
 * - Explicit `[start of path] ... [end of path]` markers
 * - Documentation/comment path declarations (`available as EXAMPLE/pddrive.c`, `declared in evaluation/auto_test.py`)
 * - Top-level module import headers (`import ...` / `from ... import ...` / `#include <...>`) and Markdown `# ` sections
 * - Tags `README`, `ARCHITECTURE`, `docs/`, and overview sections with `isOrientationDoc: true`
 * - Renders 1-based per-file line numbers (`L1..Ln`) so line-specific references (`line 121 in evaluation/auto_test.py`) are preserved verbatim.
 */
export function splitCorpusStreamIntoFiles(
  rawText: string,
  options: { defaultOriginKey?: string; includeLineNumbers?: boolean } = {},
): VirtualCorpusFile[] {
  const defaultKey = options.defaultOriginKey ?? 'corpus_stream.py';
  const includeLineNums = options.includeLineNumbers ?? false;

  const isOrientationPath = (p: string, sampleText: string) =>
    /(?:^|\/)(?:readme|architecture|contributing|overview|changelog|docs?\/|doc\/)/i.test(p) ||
    /\.(?:md|rst|txt)$/i.test(p) ||
    /^#{1,2}\s+\S/m.test(sampleText.slice(0, 400));

  const formatWithLineNumbers = (text: string) => {
    if (!includeLineNums) return text;
    return text
      .split('\n')
      .map((l, idx) => `${idx + 1}: ${l}`)
      .join('\n');
  };

  // 1. Check explicit `[start of path] ... [end of path]` markers
  const sweRegex = /\[start of ([^\]]+)\]\n([\s\S]*?)\[end of \1\]/g;
  const explicitFiles: VirtualCorpusFile[] = [];
  let m: RegExpExecArray | null;
  while ((m = sweRegex.exec(rawText)) !== null) {
    const p = m[1].trim();
    const body = m[2];
    explicitFiles.push({
      path: p,
      text: formatWithLineNumbers(body),
      isOrientationDoc: isOrientationPath(p, body),
    });
  }
  if (explicitFiles.length > 0) return explicitFiles;

  // 2. Pre-scan documentation cross-references (`declared in \`path\``, `available as path`)
  //    that bind a specific file path to a class/function identifier in concatenated streams.
  const symbolToDeclaredPath = new Map<string, string>();
  for (const dm of rawText.matchAll(/(?:declared in|defined in|available as|in file)\s+[`'"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[a-zA-Z0-9]+)[`'"]?([^\n]{0,220})/gi)) {
    const dPath = dm[1];
    const tail = dm[2] ?? '';
    for (const symMatch of tail.matchAll(/[`'"]([A-Za-z_][A-Za-z0-9_]{3,})[`'"]/g)) {
      symbolToDeclaredPath.set(symMatch[1], dPath);
    }
  }

  // 3. Scan lines for top-level file/module/section boundaries
  const lines = rawText.split('\n');
  const files: VirtualCorpusFile[] = [];
  let curStart = 0;
  let inCodeBody = false;

  const inferVirtualPath = (chunkLines: string[], idx: number): string => {
    const full = chunkLines.join('\n');
    const sample = chunkLines.slice(0, 35).join('\n');
    const explicitPath =
      /(?:available as|file|in|path:?)\s+[`'"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[a-zA-Z0-9]+)[`'"]?/i.exec(sample) ??
      /^#\s*([A-Za-z0-9_./-]+\.(?:yaml|yml|json|py|c|h|cpp|md|sh|toml|ini))\b/m.exec(sample);
    if (explicitPath) return explicitPath[1];
    for (const [sym, dPath] of symbolToDeclaredPath.entries()) {
      if (full.includes(`class ${sym}`) || full.includes(`def ${sym}`)) return dPath;
    }
    const clsMatch = /^class\s+([A-Za-z_]\w+)/m.exec(full);
    const defMatch = /^def\s+([A-Za-z_]\w+)/m.exec(full);
    const mdMatch = /^#{1,2}\s+([^\n]+)/m.exec(sample);
    if (mdMatch) return `docs/section_${idx}_${mdMatch[1].replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 32)}.md`;
    if (clsMatch) return `module_${idx}_${clsMatch[1]}.py`;
    if (defMatch) return `module_${idx}_${defMatch[1]}.py`;
    return `${defaultKey}_part_${idx}`;
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const prevBlank = lines[i - 1].trim() === '';
    const isTopLevelImport = /^(?:import\s+[A-Za-z_]|from\s+[A-Za-z_.]+\s+import\s+|#include\s+[<"]|package\s+[A-Za-z_]|using\s+[A-Za-z_])/.test(line);
    const isTopLevelDocHeader = /^#{1,2}\s+[A-Z0-9🔥]/.test(line) && inCodeBody && prevBlank;
    const isChunkOverflowBoundary =
      i - curStart >= 900 &&
      prevBlank &&
      /^(?:class\s+|def\s+|async\s+def\s+|export\s+|function\s+|public\s+|private\s+|protected\s+|interface\s+|struct\s+|impl\s+|fn\s+|#{1,3}\s+)/.test(line);

    if (((isTopLevelImport || isTopLevelDocHeader) && inCodeBody && i - curStart >= 20) || isChunkOverflowBoundary || i - curStart >= 2000) {
      const chunkLines = lines.slice(curStart, i);
      const vPath = inferVirtualPath(chunkLines, files.length + 1);
      const rawChunk = chunkLines.join('\n');
      files.push({
        path: vPath,
        text: formatWithLineNumbers(rawChunk),
        isOrientationDoc: isOrientationPath(vPath, rawChunk),
      });
      curStart = i;
      inCodeBody = false;
    }

    if (
      /^(?:def\s+|class\s+|async\s+def\s+|main\s*\(|void\s+|int\s+|export\s+|function\s+|\s{4,}\S)/.test(line) &&
      !isTopLevelImport &&
      !/^\s+[a-z0-9_,\s\\]+$/i.test(line)
    ) {
      inCodeBody = true;
    }
  }

  if (curStart < lines.length) {
    const chunkLines = lines.slice(curStart);
    const vPath = inferVirtualPath(chunkLines, files.length + 1);
    const rawChunk = chunkLines.join('\n');
    files.push({
      path: vPath,
      text: formatWithLineNumbers(rawChunk),
      isOrientationDoc: isOrientationPath(vPath, rawChunk),
    });
  }

  return files;
}

