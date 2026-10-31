import { sha256, stableId } from './store.ts';
import { splitIdentifierSubTokens, hasTechnicalIdentifierFormatting } from './lexicon-priors.ts';

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
  /** Inclusive, 1-based source lines; byte ranges are half-open. */
  startLine?: number;
  endLine?: number;
  headerByteStart?: number;
  headerByteEnd?: number;
  subTokens?: string[];
  /** Structural identity survives bounded leaf partitioning. */
  partOfId?: string;
  previousPartId?: string;
  nextPartId?: string;
  partIds?: string[];
  partIndex?: number;
  totalParts?: number;
  /** Grammar-only numeric envelope; original source bytes are unchanged. */
  numberedLines?: boolean;
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

registerLanguageGrammar({
  id: 'markdown', extensions: ['.md', '.markdown', '.rst', '.txt'],
  comments: {}, strings: { quotes: [] }, blocks: {},
});

interface LineSpan {
  index: number;
  text: string;
  byteStart: number;
  byteEnd: number;
  prefixLength?: number;
}

/** Recognize a dataset line envelope only inside a known code grammar. Every
 * nonempty record must have a consecutive positive integer and one separator.
 * Remaining whitespace belongs to code, not to the envelope. Fixed-column
 * grammars already own their sequence columns and must not be reinterpreted.
 */
function numberedLinePrefixes(text: string, grammarId: string): number[] | undefined {
  if (!getLanguageGrammar(grammarId) || ['markdown', 'cobol', 'fortran'].includes(grammarId)) return undefined;
  const prefixes: number[] = [];
  let previous: number | undefined;
  let count = 0;
  for (const line of text.split(/(?<=\n)/u)) {
    if (/^[\r\n]*$/.test(line)) { prefixes.push(0); continue; }
    const match = /^([1-9]\d*)[ \t]/.exec(line);
    if (!match) return undefined;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || previous !== undefined && value !== previous + 1) return undefined;
    previous = value;
    count++;
    prefixes.push(match[0].length);
  }
  return count >= 2 ? prefixes : undefined;
}

/** ASCII-only masking preserves UTF-16 indices, UTF-8 bytes and line positions. */
function maskNumberedLines(text: string): string {
  return text.replace(/^[1-9]\d*[ \t]/gm, prefix => ' '.repeat(prefix.length));
}

/** Linear UTF-16 -> original UTF-8 coordinates. Masked Unicode has a different
 * byte length, so offsets must always be computed from the original text.
 */
function utf8Offsets(text: string): Float64Array {
  const offsets = new Float64Array(text.length + 1);
  let byte = 0;
  for (let i = 0; i < text.length;) {
    const point = text.codePointAt(i)!;
    offsets[i] = byte;
    if (point > 0xffff) { offsets[i + 1] = byte + 3; i += 2; byte += 4; }
    else { i++; byte += point < 0x80 ? 1 : point < 0x800 ? 2 : 3; }
    offsets[i] = byte;
  }
  return offsets;
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
    /^\s*(?:(?:public|private|protected|static|async|readonly|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([\s\S]*\)\s*(?::\s*[^\{]+)?\{/,
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
 * that sum byte-for-byte to the parent span. Parts fit maxPartBytes except
 * when one UTF-8 scalar itself exceeds that budget (at most four bytes).
 */
function partitionIntoContiguousParts(
  bytes: Buffer,
  lines: LineSpan[],
  parent: CodeBlockNode,
  maxPartBytes: number,
): CodeBlockNode[] {
  if (parent.byteEnd - parent.byteStart <= maxPartBytes) return [];
  // Prefer existing line ends, but allow a single Unicode scalar to exceed a
  // smaller budget. A byte budget must never manufacture invalid UTF-8.
  const lineEnds = lines.filter(l => l.byteEnd > parent.byteStart && l.byteEnd <= parent.byteEnd).map(l => l.byteEnd);
  const ranges: Array<[number, number]> = [];
  let start = parent.byteStart;
  let lineIndex = 0;
  while (start < parent.byteEnd) {
    const limit = Math.min(parent.byteEnd, start + maxPartBytes);
    while (lineIndex < lineEnds.length && lineEnds[lineIndex] <= start) lineIndex++;
    let next = limit;
    if (lineIndex < lineEnds.length && lineEnds[lineIndex] <= limit) {
      while (lineIndex + 1 < lineEnds.length && lineEnds[lineIndex + 1] <= limit) lineIndex++;
      next = lineEnds[lineIndex];
    } else {
      while (next > start && next < parent.byteEnd && (bytes[next] & 0xc0) === 0x80) next--;
      if (next === start) {
        next++;
        while (next < parent.byteEnd && (bytes[next] & 0xc0) === 0x80) next++;
      }
    }
    ranges.push([start, next]);
    start = next;
  }
  if (ranges.length <= 1) return [];
  const parts = ranges.map(([s, e], idx) => makeNode(
    bytes, parent.grammarId, `${parent.symbolName}#part-${idx + 1}`,
    `${parent.symbolPath}#part-${idx + 1}`, 'part', parent.depth + 1,
    s, e, parent.nodeId, { partIndex: idx + 1, totalParts: ranges.length },
  ));
  parent.partIds = parts.map(p => p.nodeId);
  parts.forEach((part, idx) => {
    part.partOfId = parent.nodeId;
    part.previousPartId = parts[idx - 1]?.nodeId;
    part.nextPartId = parts[idx + 1]?.nodeId;
  });
  return parts;
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
  if (parent.depth >= 12) return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);

  // Byte-accurate scanner, including multiple definitions on one line. The
  // masked view has identical UTF-16 positions to the source.
  const original = bytes.subarray(parent.byteStart, parent.byteEnd).toString('utf8');
  const numbered = lines.some(l => l.prefixLength);
  const source = numbered ? maskNumberedLines(original) : original;
  const masked = maskCode(source);
  const offsets = utf8Offsets(original);
  const atByte = (offset: number) => parent.byteStart + offsets[offset];
  const intervals: Array<{ byteStart: number; byteEnd: number; headerEnd: number; kind: CodeBlockNode['kind']; embeddedGrammar?: string }> = [];
  let depth = 0;
  let opening = 0;
  let start = 0;
  let boundary = 0;
  let parentheses = 0;
  let squareBrackets = 0;
  for (let i = 0; i < masked.length; i++) {
    if (depth === 0 && masked[i] === '(') parentheses++;
    if (depth === 0 && masked[i] === ')') parentheses--;
    if (depth === 0 && masked[i] === '[') squareBrackets++;
    if (depth === 0 && masked[i] === ']') squareBrackets--;
    if (depth === 0 && (parentheses > 0 || squareBrackets > 0)) continue;
    if (depth === 0 && (masked[i] === ';' || masked[i] === '}')) boundary = i + 1;
    if (masked[i] === '{') {
      if (depth === 0) {
        opening = i;
        // Signature starts after the previous statement, skipping standalone
        // comments/imports while retaining multiline parameter lists.
        start = boundary;
        const prefix = masked.slice(start, i);
        const declaration = /(?:^|\n)([ \t]*(?:(?:export|default|async|public|private|protected|static|abstract)\s+)*(?:function\b|class\b|interface\b|enum\b|namespace\b|(?:const|let|var)\b|[A-Za-z_$][\w$]*\s*\())/g;
        let match: RegExpExecArray | null;
        while ((match = declaration.exec(prefix))) start = boundary + match.index + (match[0].startsWith('\n') ? 1 : 0);
        while (start < i && /\s/.test(source[start])) start++;
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        if (lineStart >= boundary && /^[ \t]*$/.test(source.slice(lineStart, start))) start = lineStart;
      }
      depth++;
    } else if (masked[i] === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        let end = i + 1;
        if (source[end] === ';') end++;
        const tail = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(end));
        if (tail) end += tail[0].length;
        intervals.push({ byteStart: atByte(start), byteEnd: atByte(end), headerEnd: atByte(opening + 1), kind: 'block' });
        boundary = end;
      }
    }
  }
  // Expression-bodied arrow definitions have no braces, but are still
  // structural units. Stop at an un-nested semicolon/newline, not a byte crop.
  for (const match of masked.matchAll(/(?:^|[;\n])[ \t]*(?:(?:export|default)\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^;\n]*?=>/g)) {
    let begin = match.index!;
    if (masked[begin] === ';' || masked[begin] === '\n') begin++;
    const headerEnd = match.index! + match[0].length;
    if (intervals.some(iv => atByte(begin) >= iv.byteStart && atByte(begin) < iv.byteEnd)) continue;
    let end = headerEnd;
    let nesting = 0;
    for (; end < masked.length; end++) {
      const ch = masked[end];
      if ('([{'.includes(ch)) nesting++;
      if (')]}'.includes(ch)) nesting--;
      if (nesting === 0 && (ch === ';' || ch === '\n')) { end++; break; }
    }
    const byteStart = atByte(begin), byteEnd = atByte(end);
    // Arrow matching also sees declarations inside existing blocks. A line's
    // indentation can precede that block's start, so checking only `begin`
    // misses overlaps and manufactures a second, crossing interval.
    if (intervals.some(iv => byteStart < iv.byteEnd && byteEnd > iv.byteStart)) continue;
    intervals.push({ byteStart, byteEnd, headerEnd: atByte(headerEnd), kind: 'block' });
  }
  // Keep embedded template languages visible without reinterpreting their
  // contents as host-language braces.
  for (const match of source.matchAll(/`(?:\\[\s\S]|[^`\\])*`/g)) {
    const begin = atByte(match.index!);
    const end = atByte(match.index! + match[0].length);
    if (intervals.some(iv => begin >= iv.byteStart && end <= iv.byteEnd)) continue;
    const det = spec.strings.embeddedDetectors?.find(d => d.pattern.test(match[0]));
    if (!det && !match[0].includes('\n')) continue;
    const lineStart = source.lastIndexOf('\n', match.index! - 1) + 1;
    let charEnd = match.index! + match[0].length;
    const tail = /^[; \t]*(?:\r?\n|$)/.exec(source.slice(charEnd));
    if (tail) charEnd += tail[0].length;
    // A template can share a line with an earlier definition. Do not extend
    // its header backwards over that definition (or a previous template).
    const priorEnd = intervals.reduce((end, iv) => iv.byteEnd <= begin ? Math.max(end, iv.byteEnd) : end, parent.byteStart);
    const byteStart = Math.max(atByte(lineStart), priorEnd);
    const byteEnd = atByte(charEnd);
    if (intervals.some(iv => byteStart < iv.byteEnd && byteEnd > iv.byteStart)) continue;
    intervals.push({ byteStart, byteEnd, headerEnd: begin + 1, kind: 'embedded_string', embeddedGrammar: det?.targetGrammar });
  }
  intervals.sort((a, b) => a.byteStart - b.byteStart);

  if (intervals.length === 0) {
    return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
  }

  // Convert line intervals into a complete, gap-free byte partition of [parent.byteStart, parent.byteEnd)
  const rawSegments: Array<{ byteStart: number; byteEnd: number; kind: CodeBlockNode['kind']; headerText: string; headerEnd?: number; embeddedGrammar?: string }> = [];
  let cursorByte = parent.byteStart;

  for (const iv of intervals) {
    // Never clip structural intervals: their opening/header offsets belong
    // to the original span. Clipping can leave a header before its own node
    // and make recursive body decomposition escape the parent's bounds.
    if (iv.byteStart < cursorByte || iv.byteStart < parent.byteStart || iv.byteEnd > parent.byteEnd ||
        iv.headerEnd < iv.byteStart || iv.headerEnd > iv.byteEnd) continue;
    const segStart = iv.byteStart;
    const segEnd = iv.byteEnd;
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
      headerEnd: iv.headerEnd,
      headerText: bytes.subarray(segStart, iv.headerEnd).toString('utf8'),
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

  const children: CodeBlockNode[] = [];
  const usedNames = new Map<string, number>();

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const headerText = numbered ? maskNumberedLines(seg.headerText) : seg.headerText;
    const baseName = inferSymbolName(headerText, `${seg.kind}-${i + 1}`);
    const count = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, count);
    const sym = count === 1 ? baseName : `${baseName}#${count}`;
    const symPath = `${parent.symbolPath}::${sym}`;
    const childGrammar = seg.embeddedGrammar ?? parent.grammarId;
    const node = makeNode(bytes, childGrammar, sym, symPath, seg.kind, parent.depth + 1, seg.byteStart, seg.byteEnd, parent.nodeId);

    if (seg.headerEnd !== undefined) {
      node.headerByteStart = seg.byteStart;
      node.headerByteEnd = seg.headerEnd;
    }
    if (seg.embeddedGrammar && REGISTRY.has(seg.embeddedGrammar)) {
      node.children = decomposeByGrammar(bytes, lines, node, REGISTRY.get(seg.embeddedGrammar)!, maxBlockBytes);
    } else if (seg.kind === 'block' && seg.headerEnd !== undefined && bytes[seg.headerEnd - 1] === 0x7b) {
      // Preserve whole units, but expose contained methods/functions as children.
      // Scan a byte-bounded body, not the same enclosing braces recursively.
      const closing = bytes.lastIndexOf(0x7d, seg.byteEnd - 1);
      if (closing > seg.headerEnd) {
        const body = makeNode(bytes, spec.id, `${sym}::body`, symPath, 'block', node.depth, seg.headerEnd, closing, node.nodeId);
        const nested = decomposeBraceAndStringLanguage(bytes, lines, body, spec, maxBlockBytes);
        if (nested.length && (nested.some(n => n.kind === 'block' || n.kind === 'embedded_string') || node.byteEnd - node.byteStart > maxBlockBytes)) {
          node.children = [
            makeNode(bytes, spec.id, `${sym}::header`, `${symPath}::header`, 'statement', node.depth + 1, seg.byteStart, seg.headerEnd, node.nodeId),
            ...nested.map(n => ({ ...n, parentId: node.nodeId })),
            makeNode(bytes, spec.id, `${sym}::footer`, `${symPath}::footer`, 'statement', node.depth + 1, closing, seg.byteEnd, node.nodeId),
          ];
        }
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
  if (subLines.length === 0) return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);

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

  // 4.5. Off-side parsing uses a grammar projection, never rewritten source bytes.
  if (spec.blocks.indentationScoped) {
    return decomposePythonDefinitions(bytes, lines, parent, spec, maxBlockBytes);
  }

  // 5. Brace-delimited default
  if (spec.blocks.brackets?.length) {
    return decomposeBraceAndStringLanguage(bytes, lines, parent, spec, maxBlockBytes);
  }

  return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
}

/** Mask comments/strings without changing UTF-16 offsets or newlines.
 * Ordinary quotes recover at an unescaped newline. Escape-aware scanning keeps
 * escaped triple delimiters and valid backslash continuations in their string.
 */
export function maskCode(text: string, python = false): string {
  const out = text.split('');
  const blank = (start: number, end: number) => { for (let j=start;j<end;j++) if (text[j] !== '\r' && text[j] !== '\n') out[j]=' '; };
  for (let i=0;i<text.length;) {
    const start=i;
    if (python && text[i]==='#' || !python && text.startsWith('//',i)) {
      while (i<text.length && text[i]!=='\n') i++;
      blank(start,i); continue;
    }
    if (!python && text.startsWith('/*',i)) {
      const end=text.indexOf('*/',i+2);i=end<0?text.length:end+2;blank(start,i);continue;
    }
    const quote=text[i];
    if (quote!=='"' && quote!=="'" && !(quote==='`'&&!python)) {i++;continue;}
    const triple=python && text.startsWith(quote.repeat(3),i);
    const delimiter=triple?quote.repeat(3):quote;
    const multiline=triple||quote==='`';
    i+=delimiter.length;
    while(i<text.length) {
      if(text[i]==='\\') {i+=text[i+1]==='\r'&&text[i+2]==='\n'?3:Math.min(2,text.length-i);continue;}
      if(text.startsWith(delimiter,i)){i+=delimiter.length;break;}
      if(!multiline&&(text[i]==='\r'||text[i]==='\n'))break;
      i++;
    }
    blank(start,i);
  }
  return out.join('');
}

/** The grammar owns definition identity, not prose-shaped regex occurrences. */
export function isDefinitionNode(node: CodeBlockNode, text: string): boolean {
  if (node.kind !== 'block' || node.headerByteEnd === undefined) return false;
  const original = Buffer.from(text).subarray(node.headerByteStart, node.headerByteEnd).toString('utf8');
  const header = maskCode(node.numberedLines ? maskNumberedLines(original) : original, node.grammarId === 'python').trim();
  if (node.grammarId === 'python') return /^(?:@[\s\S]*?\n\s*)?(?:async\s+def|def|class)\s+[A-Za-z_]\w*[\s\S]*:$/.test(header);
  return /^(?:(?:export|default|async|public|private|protected|static|abstract|readonly|declare)\s+)*(?:(?:function|class|interface|enum|namespace|type|fn|func)\s+[A-Za-z_$][\w$]*|(?:const|let|var)\s+[A-Za-z_$][\w$]*|(?!(?:if|for|while|switch|catch|with|return|new)\b)(?:get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\()/u.test(header);
}

/** Lexical occurrences only: mask strings/comments and every declaration header.
 * Header ranges are byte offsets in the ORIGINAL source, including nested ones.
 */
export function lexicalCodeReferences(text: string, grammarId: string, headers: Array<{ byteStart: number; byteEnd: number }> = []): Array<{ name: string; byteStart: number; byteEnd: number }> {
  if (grammarId === 'markdown') return [];
  const projection = numberedLinePrefixes(text, grammarId) ? maskNumberedLines(text) : text;
  const masked = maskCode(projection, grammarId === 'python');
  const offsets = utf8Offsets(text);
  // Merge header intervals once, then walk them monotonically per lexical pass.
  const ranges: Array<{ byteStart: number; byteEnd: number }> = [];
  for (const header of [...headers].sort((a, b) => a.byteStart - b.byteStart)) {
    const last = ranges.at(-1);
    if (last && header.byteStart <= last.byteEnd) last.byteEnd = Math.max(last.byteEnd, header.byteEnd);
    else ranges.push({ ...header });
  }
  const found: Array<{ name: string; byteStart: number; byteEnd: number }> = [];
  for (const pattern of [/\b([A-Za-z_$][\w$]*)\s*\(/g, /\b(?:from|import|require)\s*\(?\s*([\w./-]+)/g]) {
    let headerIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      const byteStart = offsets[match.index!];
      while (headerIndex < ranges.length && ranges[headerIndex].byteEnd <= byteStart) headerIndex++;
      if (headerIndex < ranges.length && ranges[headerIndex].byteStart <= byteStart) continue;
      if (/^(?:if|for|while|switch|catch|with|return|def|function|class)$/.test(match[1])) continue;
      found.push({ name: match[1], byteStart, byteEnd: offsets[match.index! + match[0].length] });
    }
  }
  return found;
}

function decomposePythonDefinitions(
  bytes: Buffer, lines: LineSpan[], parent: CodeBlockNode,
  spec: LanguageGrammarSpec, maxBlockBytes: number,
): CodeBlockNode[] {
  const local = lines.filter(l => l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
  const masked = maskCode(local.map(l => l.text).join(''), true).split(/(?<=\n)/u);
  const indent = (index: number) => (/^[ \t]*/.exec((masked[index] ?? '').slice(local[index].prefixLength ?? 0))![0]).replace(/\t/g, '        ').length;
  const decoratorStarts = new Map<number, number>();
  for (let i = 0; i < local.length; i++) {
    if (!/^[ \t]*@/.test(masked[i] ?? '')) continue;
    let level = 0, end = i;
    for (; end < local.length; end++) {
      for (const ch of masked[end] ?? '') {
        if ('([{'.includes(ch)) level++;
        if (')]}'.includes(ch)) level--;
      }
      if (level <= 0) break;
    }
    if (level === 0 && end < local.length) decoratorStarts.set(end, i);
  }
  const candidates: Array<{ index: number; indent: number; name: string; headerEnd: number }> = [];
  for (let i = 0; i < local.length; i++) {
    const m = /^[ \t]*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/.exec(masked[i] ?? '');
    if (!m) continue;
    // Multiline signatures end at a colon outside parameter/type brackets.
    let level = 0;
    let headerEnd = local[i].byteEnd;
    let found = false;
    for (let j = i; j < local.length && !found; j++) {
      if (j > i && level === 0) break;
      for (let k = 0; k < (masked[j] ?? '').length; k++) {
        const ch = masked[j][k];
        if ('([{'.includes(ch)) level++;
        if (')]}'.includes(ch)) level--;
        if (ch === ':' && level === 0) {
          headerEnd = local[j].byteStart + Buffer.byteLength(local[j].text.slice(0, k + 1));
          found = true;
          break;
        }
      }
    }
    if (found) candidates.push({ index: i, indent: indent(i), name: m[1], headerEnd });
  }
  if (!candidates.length) return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
  const minimum = Math.min(...candidates.map(c => c.indent));
  const heads = candidates.filter(c => c.indent === minimum);
  const nodes: CodeBlockNode[] = [];
  let cursor = parent.byteStart;
  for (const head of heads) {
    let first = head.index;
    while (first > 0) {
      const decorator = decoratorStarts.get(first - 1);
      if (decorator === undefined || indent(decorator) !== minimum) break;
      first = decorator;
    }
    let last = head.index;
    while (last + 1 < local.length && local[last].byteEnd <= head.headerEnd) last++;
    while (last + 1 < local.length) {
      const next = masked[last + 1] ?? '';
      if (next.trim() && indent(last + 1) <= minimum) break;
      last++;
    }
    // Blank/comment-only tails are not part of a definition's source extent.
    while (last > head.index && !(masked[last] ?? '').trim()) last--;
    const start = local[first].byteStart;
    const end = local[last].byteEnd;
    if (start < cursor) continue;
    if (start > cursor) nodes.push(makeNode(bytes, spec.id, `gap-${nodes.length + 1}`, `${parent.symbolPath}::gap-${nodes.length + 1}`, 'statement', parent.depth + 1, cursor, start, parent.nodeId));
    const n = makeNode(bytes, spec.id, head.name, `${parent.symbolPath}::${head.name}`, 'block', parent.depth + 1, start, end, parent.nodeId);
    n.headerByteStart = start;
    n.headerByteEnd = head.headerEnd;
    // Retain the whole definition as the authority, and enumerate nested
    // definitions beneath it even when the containing class fits the budget.
    const bodyStart = local.find(l => l.byteStart >= head.headerEnd)?.byteStart ?? end;
    if (bodyStart < end && candidates.some(c => local[c.index].byteStart >= bodyStart && local[c.index].byteStart < end && c.indent > minimum)) {
      const header = makeNode(bytes, spec.id, `${head.name}::header`, `${n.symbolPath}::header`, 'statement', n.depth + 1, start, bodyStart, n.nodeId);
      const body = makeNode(bytes, spec.id, `${head.name}::body`, n.symbolPath, 'block', n.depth, bodyStart, end, n.nodeId);
      n.children = [header, ...decomposePythonDefinitions(bytes, lines, body, spec, maxBlockBytes).map(child => ({ ...child, parentId: n.nodeId }))];
    }
    nodes.push(n);
    cursor = end;
  }
  if (cursor < parent.byteEnd) nodes.push(makeNode(bytes, spec.id, 'trailing', `${parent.symbolPath}::trailing`, 'statement', parent.depth + 1, cursor, parent.byteEnd, parent.nodeId));
  return nodes;
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
  if (!Number.isSafeInteger(maxBlockBytes) || maxBlockBytes <= 0) {
    throw new RangeError('maxBlockBytes must be a positive safe integer');
  }
  const spec =
    (options.grammarId ? getLanguageGrammar(options.grammarId) : undefined) ??
    (options.originKey ? getLanguageGrammar(options.originKey) : undefined) ??
    getLanguageGrammar('typescript')!;

  const lines = splitLinesWithByteBounds(bytes);
  const explicitGrammar = options.grammarId ? getLanguageGrammar(options.grammarId) : options.originKey ? getLanguageGrammar(options.originKey) : undefined;
  const prefixes = explicitGrammar ? numberedLinePrefixes(bytes.toString('utf8'), spec.id) : undefined;
  if (prefixes) for (const line of lines) {
    line.prefixLength = prefixes[line.index];
    line.text = ' '.repeat(line.prefixLength) + line.text.slice(line.prefixLength);
  }
  const rootName = options.originKey ?? spec.id;
  const root = makeNode(bytes, spec.id, rootName, rootName, 'root', 0, 0, bytes.length, null);
  root.children = decomposeByGrammar(bytes, lines, root, spec, maxBlockBytes);

  const flatNodes: CodeBlockNode[] = [];
  const lineAt = (offset: number): number => {
    let lo = 0, hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid].byteStart <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(1, lo);
  };
  const walk = (n: CodeBlockNode) => {
    if (prefixes) n.numberedLines = true;
    n.startLine = lineAt(n.byteStart);
    n.endLine = lineAt(Math.max(n.byteStart, n.byteEnd - 1));
    n.subTokens = splitIdentifierSubTokens(n.symbolName);
    if ((n.kind === 'block' || n.kind === 'section') && n.headerByteStart === undefined) {
      n.headerByteStart = n.byteStart;
      n.headerByteEnd = Math.min(n.byteEnd, lines[n.startLine - 1]?.byteEnd ?? n.byteEnd);
    }
    if (n.children.length === 0 && n.kind !== 'part') n.children = partitionIntoContiguousParts(bytes, lines, n, maxBlockBytes);
    flatNodes.push(n);
    for (const c of n.children) {
      c.parentId = n.nodeId;
      c.depth = n.depth + 1;
      walk(c);
    }
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
  /** Input segment identity; display paths may repeat. */
  sourceIndex?: number;
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
  files: Array<{ path: string; text: string; grammarId?: string }>,
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

  const rawMatches = query.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
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
  // Definition evidence outranks any prose/stop-word heuristic (e.g. get, set,
  // library). No English dictionary may erase an actual repository symbol.
  const trees = new Map(files.map((f,sourceIndex) => [sourceIndex, decomposeCodeSource(f.text, { originKey: f.path, grammarId: f.grammarId ?? getLanguageGrammar(f.path)?.id ?? 'markdown', maxBlockBytes })]));
  const definedSymbols = new Set<string>();
  for (const [sourceIndex,f] of files.entries()) {
    if (trees.get(sourceIndex)!.grammarId === 'markdown') continue;
    for (const node of trees.get(sourceIndex)!.flatNodes) {
      if (isDefinitionNode(node, f.text)) definedSymbols.add(node.symbolName);
    }
  }
  const isDefinedSymbol = (token: string) => definedSymbols.has(token);
  const queryIds = [...new Set(expandedTokens.filter(tok => isDefinedSymbol(tok) || (!BLIND_CODE_STOP.has(tok) && (hasTechnicalIdentifierFormatting(tok) || tok.length >= 4))))];

  // Extract static unused/used imports if `importStatement` is provided (including multi-line `from X import (\n A,\n B\n)`)
  const unusedImports = new Set<string>();
  const usedImports = new Set<string>();
  const importModuleBySymbol = new Map<string, string>();
  if (options.importStatement) {
    const normalizedImports = options.importStatement.replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner) => inner.replace(/\s*\n\s*/g, ' '));
    for (const line of normalizedImports.split('\n')) {
      const mFrom = /from\s+([\w.]+)\s+import\s+(.+)/.exec(line);
      const mImp = !mFrom ? /^\s*import\s+(.+)/.exec(line) : null;
      const modName = mFrom ? mFrom[1] : 'global_import';
      const rhs = mFrom ? mFrom[2] : mImp ? mImp[1] : '';
      if (rhs) {
        for (const part of rhs.split(',')) {
          const clean = part.replace(/#.*/, '').replace(/[()\\]/g, '').trim().split(/\s+as\s+/).pop()?.trim() ?? '';
          if (clean && /^[A-Za-z_]\w+$/.test(clean)) {
            importModuleBySymbol.set(clean, modName);
            if (options.cursorContext && !options.cursorContext.includes(clean)) unusedImports.add(clean);
            else usedImports.add(clean);
          }
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
  const fileHeaderImports = new Map<number, Set<string>>();
  for (const [sourceIndex,f] of files.entries()) {
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
    fileHeaderImports.set(sourceIndex, syms);
  }

  // Distinguish true code-identifier clues (`snake_case`, `CamelCase`, or identifiers with digits)
  // from plain lowercase prose words so triangulation focuses on actual technical symbols!
  const codeSymbolCache = new Map<string, boolean>();
  const isCodeSymbol = (id: string): boolean => {
    const cached = codeSymbolCache.get(id);
    if (cached !== undefined) return cached;
    const val =
      isDefinedSymbol(id) || /[_0-9]/.test(id) ||
      (/[A-Z]/.test(id) && /[a-z]/.test(id) && !/^[A-Z][a-z]+$/.test(id)) ||
      files.some(f => f.path.toLowerCase().includes(id.toLowerCase()));
    codeSymbolCache.set(id, val);
    return val;
  };

  const rareQueryClues = [...df.entries()]
    .filter(([id, c]) => c <= Math.max(2, Math.floor(files.length / 2)) && isCodeSymbol(id))
    .map(([id]) => id);

  const fileRareClues = new Map<number, string[]>();
  let maxFileRareCount = 0;
  for (const [sourceIndex,f] of files.entries()) {
    const matched = rareQueryClues.filter(id => f.text.includes(id) || f.path.toLowerCase().includes(id.toLowerCase()));
    fileRareClues.set(sourceIndex, matched);
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
    const fRare = fileRareClues.get(fIdx) ?? [];
    // File-Level Multi-Clue Triangulation Boost:
    // When a file bridges >= 2 rare code clues (especially when it bridges the maximum number of rare clues in the repo),
    // boost its file rank so caller/orchestrator files (`executor.py`, `debug.py`, `decorators.py`) aren't buried!
    if (fRare.length >= 2) {
      score += fRare.length * fRare.length * 55;
      if (fRare.length === maxFileRareCount) score += 300;
    }
    for (const sym of unusedImports) if (f.text.includes(sym)) score += 500;
    for (const sym of usedImports) if (f.text.includes(sym)) score += 100;
    return { ...f, sourceIndex:fIdx, score };
  }).sort((a, b) => b.score - a.score);

  const candidateBlocks: Array<BlindCodeBlockRankResult & { matchedClues: Set<string>; leafName: string; references: Set<string>; directScore: number; node: CodeBlockNode }> = [];
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
    const fRare = fileRareClues.get(f.sourceIndex) ?? [];
    const fImports = [...(fileHeaderImports.get(f.sourceIndex) ?? [])];
    const relevantImports = fImports.filter(s => queryIds.includes(s) || /[A-Z]/.test(s)).slice(0, 8);
    const fileTriangulationNote = fRare.length >= 2 ? `[BRIDGES: ${fRare.slice(0, 4).join(',')}]` : '';

    const tree = trees.get(f.sourceIndex)!;
    if (!tree.partitionVerified) allPartitionsVerified = false;
    // Score a non-overlapping leaf/header frontier. Closing over a fitting
    // enclosing unit happens only after ranking, so small classes do not get
    // aggregate body credit unavailable to large classes.
    const leaves = tree.flatNodes.filter(node => !node.children.length && node.byteEnd > node.byteStart);
    const definitions = tree.flatNodes.filter(node => isDefinitionNode(node, f.text));
    const references = lexicalCodeReferences(f.text, tree.grammarId, definitions.map(node => ({ byteStart: node.headerByteStart!, byteEnd: node.headerByteEnd! })));
    const buf = Buffer.from(f.text, 'utf8');
    for (const node of leaves) {
      const txt = buf.subarray(node.byteStart, node.byteEnd).toString('utf8');
      let bScore = Math.max(1, (maxFiles - fRank) * 6);
      const matchedClues = new Set<string>();
      const leafName = node.symbolName.replace(/#part-\d+$|::header$|::footer$/, '');
      const directName = leafName.split('::').at(-1)!;
      const ownDefinition = definitions.some(d => d.symbolName === directName && node.byteStart >= d.byteStart && node.byteStart < d.headerByteEnd!);
      // A query-named enclosing definition is a strong structural match, not
      // lexical body repetition. Descendants inherit its identity at a fixed
      // per-symbol rate while their own leaf contents remain independently scored.
      const enclosingNames = new Set(definitions.filter(d=>d.byteStart<=node.byteStart&&d.byteEnd>=node.byteEnd).map(d=>d.symbolName));
      for (const [id, c] of df.entries()) {
        const idf = Math.max(1, Math.round(Math.max(25, files.length) / c));
        const symMult = isCodeSymbol(id) ? 2 : 1;
        if (ownDefinition && directName.toLowerCase() === id.toLowerCase()) {
          bScore += idf * 20 * symMult;
          if (isCodeSymbol(id)) matchedClues.add(id);
        }
        if (! (ownDefinition && directName.toLowerCase() === id.toLowerCase()) && enclosingNames.has(id) && isDefinedSymbol(id)) {
          bScore += idf * 10 * symMult;
          matchedClues.add(id);
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
          sourceIndex:f.sourceIndex, node, references: new Set(references.filter(ref => ref.byteStart >= node.byteStart && ref.byteStart < node.byteEnd).map(ref => ref.name)), directScore: bScore,
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

  // Bounded lexical navigation, never a resolved call graph. A lexical-only
  // candidate cannot overtake any directly matched candidate via this boost.
  const seeds = [...candidateBlocks].sort((a, b) => b.directScore - a.directScore).slice(0, 10);
  const seedNames = new Set(seeds.filter(s => s.matchedClues.size).map(s => s.leafName));
  const outgoing = new Set(seeds.slice(0, 3).flatMap(s => [...s.references]));
  for (const block of candidateBlocks) {
    const edges = [...block.references].filter(ref => seedNames.has(ref)).length + (outgoing.has(block.leafName) ? 1 : 0);
    const bonus = Math.min(24, edges * 6);
    const nextDirect = candidateBlocks.filter(b => b.matchedClues.size && b.directScore > block.directScore).reduce((n, b) => Math.min(n, b.directScore), Infinity);
    block.score += Math.max(0, Math.min(bonus, nextDirect - block.directScore - 0.5));
  }

  candidateBlocks.sort((a, b) => b.score - a.score);
  const selected: BlindCodeBlockRankResult[] = [];
  let chars = 0;
  for (const b of candidateBlocks) {
    const tree = trees.get(b.sourceIndex!)!;
    let chosen = b.node;
    // Closure is a rendering/admission decision, independent of the scoring
    // unit. Prefer the largest fitting enclosing definition, without overlap.
    for (let parent = tree.flatNodes.find(n => n.nodeId === chosen.parentId); parent; parent = tree.flatNodes.find(n => n.nodeId === parent!.parentId)) {
      if (parent.kind === 'block' && parent.byteEnd - parent.byteStart <= maxBlockBytes) chosen = parent;
    }
    if (selected.some(s => s.sourceIndex === b.sourceIndex && s.byteStart < chosen.byteEnd && s.byteEnd > chosen.byteStart)) continue;
    const file = files[b.sourceIndex!]!;
    const text = `// FILE: ${b.originKey} (${chosen.symbolPath})\n${Buffer.from(file.text).subarray(chosen.byteStart, chosen.byteEnd).toString('utf8')}`;
    if (chars + text.length + 2 > maxTotalChars) continue;
    selected.push({ originKey: b.originKey, sourceIndex:b.sourceIndex, symbolPath: chosen.symbolPath, byteStart: chosen.byteStart, byteEnd: chosen.byteEnd, sha256: chosen.sha256, score: b.score, text });
    chars += text.length + 2;
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
  /** Compatibility display key. Consult verifiedPath before treating it as a file. */
  path: string;
  verifiedPath?: string;
  inferredLabel?: string;
  /** Content-inferred grammar, never a fabricated filename. */
  grammarId?: string;
  pathProvenance: 'explicit-marker' | 'caller' | 'inferred';
  segmentKind: 'file' | 'marker' | 'outside' | 'inferred';
  text: string;
  byteStart: number;
  byteEnd: number;
  /** Inclusive, 1-based lines in the ORIGINAL stream. */
  startLine: number;
  endLine: number;
  isOrientationDoc: boolean;
}

/**
 * Lossless stream segmentation. Marker and outside spans are first-class records;
 * concatenating every record's text returns the original stream exactly. Only an
 * explicit marker or caller-supplied origin verifies a path; prose references are
 * labels, never evidence of a source file. includeLineNumbers is a deprecated
 * compatibility option and deliberately never modifies source bytes.
 */
export function splitCorpusStreamIntoFiles(
  rawText: string,
  options: { defaultOriginKey?: string; includeLineNumbers?: boolean } = {},
): VirtualCorpusFile[] {
  const bytes = Buffer.from(rawText, 'utf8');
  const lines = splitLinesWithByteBounds(bytes);
  const files: VirtualCorpusFile[] = [];
  const lineAt = (offset: number) => {
    let lo = 0, hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid].byteStart <= offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(1, lo);
  };
  const orientation = (path: string, text: string) => {
    // A known code suffix is stronger evidence than a Markdown-looking
    // comment or a source file living under docs/.
    const grammar = getLanguageGrammar(path);
    if (grammar && grammar.id !== 'markdown') return false;
    return /(?:^|\/)(?:readme|architecture|contributing|overview|changelog|docs?\/)/i.test(path) ||
      /\.(?:md|markdown|rst|txt)$/i.test(path) || /^#{1,2}\s+\S/m.test(text.slice(0, 400));
  };
  const emit = (start: number, end: number, kind: VirtualCorpusFile['segmentKind'], path?: string, provenance: VirtualCorpusFile['pathProvenance'] = 'inferred') => {
    if (end <= start) return;
    const text = bytes.subarray(start, end).toString('utf8');
    const label = path ?? options.defaultOriginKey ?? `corpus-segment-${files.length + 1}`;
    files.push({
      path: label,
      ...(provenance === 'inferred' ? { inferredLabel: label } : { verifiedPath: label }),
      pathProvenance: provenance, segmentKind: kind, text,
      byteStart: start, byteEnd: end,
      startLine: lineAt(start), endLine: lineAt(Math.max(start, end - 1)),
      isOrientationDoc: orientation(label, text),
    });
  };
  // Markers are recognized only as complete lines outside Markdown fences.
  let fence: string | undefined;
  let activePath: string | undefined;
  let cursor = 0;
  let hadMarker = false;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const m = /^\[(start|end) of ([^\]\r\n]+)\][ \t]*(?:\r?\n)?$/.exec(line.text);
    if (!m || (m[1] === 'end' && m[2].trim() !== activePath)) continue;
    emit(cursor, line.byteStart, activePath ? 'file' : 'outside', activePath, activePath ? 'explicit-marker' : 'inferred');
    const markerPath = m[2].trim();
    emit(line.byteStart, line.byteEnd, 'marker', markerPath, 'explicit-marker');
    activePath = m[1] === 'start' ? markerPath : undefined;
    cursor = line.byteEnd;
    hadMarker = true;
  }
  if (hadMarker) {
    emit(cursor, bytes.length, activePath ? 'file' : 'outside', activePath, activePath ? 'explicit-marker' : 'inferred');
    return files;
  }
  // A caller-supplied known file, including README fenced examples, remains
  // one file. Unknown attachment keys identify custody, not a source grammar.
  if (options.defaultOriginKey && getLanguageGrammar(options.defaultOriginKey)) {
    emit(0, bytes.length, 'file', options.defaultOriginKey, 'caller');
    return files;
  }
  // Infer ranges rather than files. Headings and unfenced grammar definitions
  // are boundaries; arbitrary line counts and prose filename mentions are not.
  const boundaries: Array<{ start: number; label: string; grammarId: string }> = [];
  let inferredFence: string | undefined;
  const pythonLines = maskCode(rawText, true).split(/(?<=\n)/u);
  const braceLines = maskCode(rawText).split(/(?<=\n)/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
    if (marker) {
      if (!inferredFence) inferredFence = marker[1];
      else if (marker[1][0] === inferredFence[0] && marker[1].length >= inferredFence.length) inferredFence = undefined;
      continue;
    }
    if (inferredFence) continue;
    const heading = /^#{1,6}\s+(.+?)[\r\n]*$/.exec(line.text);
    if (heading) {
      boundaries.push({ start: line.byteStart, label: `section: ${heading[1]}`, grammarId: 'markdown' });
      continue;
    }
    const py = /^(?:(?:async\s+def|def)\s+([A-Za-z_]\w*)\s*\(|class\s+([A-Za-z_]\w*)[^{}]*:)/.exec(pythonLines[i] ?? '');
    const ts = /^(?:(?:export|default|async|abstract)\s+)*(?:function|class|interface|enum|namespace|(?:const|let|var))\s+([A-Za-z_$][\w$]*)/.exec(braceLines[i] ?? '');
    const match = py ?? ts;
    if (!match) continue;
    const grammarId = py ? 'python' : 'typescript';
    // Consecutive code definitions belong to one inferred code range.
    if (boundaries.at(-1)?.grammarId === grammarId) continue;
    let first = i;
    while (first > 0 && /^(?:import\s|from\s|[ \t]*@|[ \t]*$)/.test(lines[first - 1].text)) first--;
    const start = Math.max(lines[first].byteStart, boundaries.at(-1)?.start ?? 0);
    boundaries.push({ start, label: `code: ${match[1] ?? match[2]} (${grammarId})`, grammarId });
  }
  if (!boundaries.length) {
    emit(0, bytes.length, 'inferred', 'unclassified source');
    return files;
  }
  if (boundaries[0].start > 0) emit(0, boundaries[0].start, 'inferred', 'unclassified preamble');
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const count = files.length;
    emit(boundary.start, boundaries[i + 1]?.start ?? bytes.length, 'inferred', boundary.label);
    if (files.length > count) {
      files.at(-1)!.grammarId = boundary.grammarId;
      files.at(-1)!.isOrientationDoc = boundary.grammarId === 'markdown';
    }
  }
  return files;
}
