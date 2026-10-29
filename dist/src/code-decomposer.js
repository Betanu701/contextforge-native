import { sha256, stableId } from './store.js';
import { splitIdentifierSubTokens, hasTechnicalIdentifierFormatting } from './lexicon-priors.js';
const REGISTRY = new Map();
const EXT_MAP = new Map();
export function registerLanguageGrammar(spec) {
    const id = spec.id.toLowerCase().trim();
    REGISTRY.set(id, {
        ...spec,
        id
    });
    for (const ext of spec.extensions){
        EXT_MAP.set(ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`, id);
    }
}
export function getLanguageGrammar(idOrPath) {
    const lower = idOrPath.toLowerCase().trim();
    if (REGISTRY.has(lower)) return REGISTRY.get(lower);
    const dot = lower.lastIndexOf('.');
    if (dot >= 0) {
        const mapped = EXT_MAP.get(lower.slice(dot));
        if (mapped) return REGISTRY.get(mapped);
    }
    return undefined;
}
export function listLanguageGrammars() {
    return [
        ...REGISTRY.values()
    ];
}
export function fromVSCodeLanguageConfig(id, extensions, config) {
    const keywordPairs = [];
    if (config.folding?.markers?.start && config.folding?.markers?.end) {
        keywordPairs.push({
            open: new RegExp(config.folding.markers.start, 'i'),
            close: new RegExp(config.folding.markers.end, 'i')
        });
    }
    return {
        id,
        extensions,
        comments: {
            line: config.comments?.lineComment ? [
                config.comments.lineComment
            ] : [],
            block: config.comments?.blockComment ? [
                config.comments.blockComment
            ] : []
        },
        strings: {
            quotes: [
                {
                    open: '"',
                    close: '"',
                    escape: '\\'
                },
                {
                    open: "'",
                    close: "'",
                    escape: '\\'
                }
            ]
        },
        blocks: {
            brackets: config.brackets?.filter(([o, c])=>o === '{' && c === '}') ?? [
                [
                    '{',
                    '}'
                ]
            ],
            ...keywordPairs.length ? {
                keywordPairs
            } : {},
            ...config.folding?.offSide ? {
                indentationScoped: true
            } : {}
        }
    };
}
const C_FAMILY_STRINGS = {
    quotes: [
        {
            open: '`',
            close: '`',
            escape: '\\',
            multiline: true
        },
        {
            open: '"""',
            close: '"""',
            escape: '\\',
            multiline: true
        },
        {
            open: '"',
            close: '"',
            escape: '\\'
        },
        {
            open: "'",
            close: "'",
            escape: '\\'
        }
    ],
    interpolations: [
        {
            open: '${',
            close: '}',
            targetGrammar: 'typescript'
        }
    ],
    embeddedDetectors: [
        {
            pattern: /<%[-=_]?[\s\S]*?%>/,
            targetGrammar: 'ejs'
        },
        {
            pattern: /<[a-zA-Z][\w-]*[\s>][\s\S]*<\/[a-zA-Z][\w-]*>/,
            targetGrammar: 'html'
        },
        {
            pattern: /\b(?:CREATE\s+TABLE|SELECT\s+[\s\S]+?\s+FROM|INSERT\s+INTO|ALTER\s+TABLE)\b/i,
            targetGrammar: 'sql'
        }
    ]
};
for (const [id, exts] of [
    [
        'typescript',
        [
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
            '.mjs',
            '.cjs'
        ]
    ],
    [
        'csharp',
        [
            '.cs'
        ]
    ],
    [
        'java',
        [
            '.java'
        ]
    ],
    [
        'go',
        [
            '.go'
        ]
    ],
    [
        'rust',
        [
            '.rs'
        ]
    ],
    [
        'cpp',
        [
            '.c',
            '.cc',
            '.cpp',
            '.h',
            '.hpp'
        ]
    ]
]){
    registerLanguageGrammar({
        id,
        extensions: [
            ...exts
        ],
        comments: {
            line: [
                '//'
            ],
            block: [
                [
                    '/*',
                    '*/'
                ]
            ]
        },
        strings: C_FAMILY_STRINGS,
        blocks: {
            brackets: [
                [
                    '{',
                    '}'
                ]
            ]
        }
    });
}
registerLanguageGrammar({
    id: 'python',
    extensions: [
        '.py',
        '.pyw'
    ],
    comments: {
        line: [
            '#'
        ]
    },
    strings: {
        quotes: [
            {
                open: '"""',
                close: '"""',
                escape: '\\',
                multiline: true
            },
            {
                open: "'''",
                close: "'''",
                escape: '\\',
                multiline: true
            },
            {
                open: '"',
                close: '"',
                escape: '\\'
            },
            {
                open: "'",
                close: "'",
                escape: '\\'
            }
        ],
        embeddedDetectors: C_FAMILY_STRINGS.embeddedDetectors
    },
    blocks: {
        indentationScoped: true
    }
});
registerLanguageGrammar({
    id: 'cobol',
    extensions: [
        '.cbl',
        '.cob',
        '.cpy'
    ],
    comments: {
        line: [
            '*>'
        ],
        columnIndicator: {
            column: 7,
            markers: [
                '*',
                '/'
            ]
        }
    },
    strings: {
        quotes: [
            {
                open: '"',
                close: '"'
            },
            {
                open: "'",
                close: "'"
            }
        ],
        embeddedDetectors: [
            {
                pattern: /\bEXEC\s+SQL\b[\s\S]*?\bEND-EXEC/i,
                targetGrammar: 'sql'
            }
        ]
    },
    blocks: {
        sectionHierarchy: [
            {
                level: 1,
                pattern: /^\s*(?:[\d\s]{6})?\s*([A-Z0-9-]+)\s+DIVISION\b/i
            },
            {
                level: 2,
                pattern: /^\s*(?:[\d\s]{6})?\s*([A-Z0-9-]+)\s+SECTION\s*\./i
            },
            {
                level: 3,
                pattern: /^(?:[\d\s]{6}\s|\s{0,4})([A-Z0-9][A-Z0-9-]+)\s*\.\s*$/i
            }
        ],
        keywordPairs: [
            {
                open: /^\s*(?:[\d\s]{6})?\s*(EVALUATE|IF|PERFORM\s+UNTIL|PERFORM\s+VARYING|EXEC\s+SQL|EXEC\s+CICS)\b/i,
                close: /^\s*(?:[\d\s]{6})?\s*(END-EVALUATE|END-IF|END-PERFORM|END-EXEC)\b/i
            }
        ]
    }
});
registerLanguageGrammar({
    id: 'fortran',
    extensions: [
        '.f',
        '.for',
        '.f77',
        '.f90',
        '.f95',
        '.f03',
        '.f08'
    ],
    comments: {
        line: [
            '!'
        ],
        columnIndicator: {
            column: 1,
            markers: [
                'C',
                'c',
                '*'
            ]
        }
    },
    strings: {
        quotes: [
            {
                open: '"',
                close: '"'
            },
            {
                open: "'",
                close: "'"
            }
        ]
    },
    blocks: {
        keywordPairs: [
            {
                open: /^\s*(?:(?:PURE|ELEMENTAL|RECURSIVE|MODULE)\s+)*(PROGRAM|MODULE|SUBROUTINE|FUNCTION|INTERFACE|TYPE\s+(?!IS\b)(?:,\s*[A-Z0-9_]+\s*::\s*)?[A-Z0-9_]+|DO\b|IF\b[^!]*\bTHEN\b|SELECT\s+CASE)\b/i,
                close: /^\s*END\s*(?:PROGRAM|MODULE|SUBROUTINE|FUNCTION|INTERFACE|TYPE|DO|IF|SELECT)?\b/i
            }
        ]
    }
});
registerLanguageGrammar({
    id: 'sql',
    extensions: [
        '.sql',
        '.ddl'
    ],
    comments: {
        line: [
            '--'
        ],
        block: [
            [
                '/*',
                '*/'
            ]
        ]
    },
    strings: {
        quotes: [
            {
                open: "'",
                close: "'",
                multiline: true
            }
        ]
    },
    blocks: {
        statementTerminator: /;\s*$/,
        keywordPairs: [
            {
                open: /\b(?:CREATE(?:\s+OR\s+REPLACE)?\s+(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER)|BEGIN)\b/i,
                close: /\bEND\s*;?|\)\s*(?:STRICT\s*)?;/i
            }
        ]
    }
});
registerLanguageGrammar({
    id: 'html',
    extensions: [
        '.html',
        '.htm',
        '.vue',
        '.svelte',
        '.xml'
    ],
    comments: {
        block: [
            [
                '<!--',
                '-->'
            ]
        ]
    },
    strings: {
        quotes: [
            {
                open: '"',
                close: '"'
            },
            {
                open: "'",
                close: "'"
            }
        ],
        interpolations: [
            {
                open: '${',
                close: '}',
                targetGrammar: 'typescript'
            },
            {
                open: '{{',
                close: '}}',
                targetGrammar: 'typescript'
            }
        ]
    },
    blocks: {
        tagPairs: {
            voidTags: [
                'area',
                'base',
                'br',
                'col',
                'embed',
                'hr',
                'img',
                'input',
                'link',
                'meta',
                'param',
                'source',
                'track',
                'wbr'
            ]
        }
    }
});
registerLanguageGrammar({
    id: 'ejs',
    extensions: [
        '.ejs',
        '.hbs',
        '.handlebars'
    ],
    comments: {
        block: [
            [
                '<%#',
                '%>'
            ],
            [
                '<!--',
                '-->'
            ]
        ]
    },
    strings: {
        quotes: [
            {
                open: '"',
                close: '"'
            },
            {
                open: "'",
                close: "'"
            }
        ],
        interpolations: [
            {
                open: '<%',
                close: '%>',
                targetGrammar: 'typescript'
            }
        ]
    },
    blocks: {
        tagPairs: {
            voidTags: [
                'area',
                'base',
                'br',
                'col',
                'embed',
                'hr',
                'img',
                'input',
                'link',
                'meta',
                'param',
                'source',
                'track',
                'wbr'
            ]
        }
    }
});
registerLanguageGrammar({
    id: 'markdown',
    extensions: [
        '.md',
        '.markdown',
        '.rst',
        '.txt'
    ],
    comments: {},
    strings: {
        quotes: []
    },
    blocks: {}
});
function splitLinesWithByteBounds(bytes) {
    const text = bytes.toString('utf8');
    const rawLines = text.split(/(?<=\n)/u);
    const out = [];
    let offset = 0;
    for(let i = 0; i < rawLines.length; i++){
        const len = Buffer.byteLength(rawLines[i]);
        if (len === 0) continue;
        out.push({
            index: i,
            text: rawLines[i],
            byteStart: offset,
            byteEnd: offset + len
        });
        offset += len;
    }
    return out;
}
function isLineComment(line, spec) {
    if (spec.comments.columnIndicator) {
        const colIdx = spec.comments.columnIndicator.column - 1;
        if (line.length > colIdx && spec.comments.columnIndicator.markers.includes(line[colIdx])) {
            return true;
        }
    }
    const trimmed = line.trimStart();
    return (spec.comments.line ?? []).some((prefix)=>trimmed.startsWith(prefix));
}
function inferSymbolName(headerText, fallback) {
    const cleaned = headerText.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const patterns = [
        /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|module|subroutine|program)\s+([A-Za-z_][\w$-]*)/i,
        /\b(?:const|let|var|public|private|protected|readonly|static)\s+([A-Za-z_][\w$-]*)\s*(?:[:=])/i,
        /\b(?:def|class|async\s+def)\s+([A-Za-z_][\w]*)/,
        /^\s*(?:[\d\s]{6})?\s*([A-Z0-9-]+)\s+(?:DIVISION|SECTION)\b/i,
        /^(?:[\d\s]{6}\s|\s{0,4})([A-Z0-9][A-Z0-9-]+)\s*\.\s*$/i,
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/i,
        /<([a-zA-Z][\w-]*)(?:\s+[^>]*)?>/,
        /\b([A-Za-z_][\w$-]*)\s*\([^)]*\)\s*(?::\s*[^\{]+)?\{/
    ];
    for (const re of patterns){
        const m = re.exec(cleaned);
        if (m && m[1] && !/^(?:if|for|while|switch|catch|return|new)$/.test(m[1])) {
            return m[1];
        }
    }
    return fallback;
}
function makeNode(bytes, grammarId, symbolName, symbolPath, kind, depth, byteStart, byteEnd, parentId, extra = {}) {
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
        children: []
    };
}
function partitionIntoContiguousParts(bytes, lines, parent, maxPartBytes) {
    if (parent.byteEnd - parent.byteStart <= maxPartBytes) return [];
    const lineEnds = lines.filter((l)=>l.byteEnd > parent.byteStart && l.byteEnd <= parent.byteEnd).map((l)=>l.byteEnd);
    const ranges = [];
    let start = parent.byteStart;
    let lineIndex = 0;
    while(start < parent.byteEnd){
        const limit = Math.min(parent.byteEnd, start + maxPartBytes);
        while(lineIndex < lineEnds.length && lineEnds[lineIndex] <= start)lineIndex++;
        let next = limit;
        if (lineIndex < lineEnds.length && lineEnds[lineIndex] <= limit) {
            while(lineIndex + 1 < lineEnds.length && lineEnds[lineIndex + 1] <= limit)lineIndex++;
            next = lineEnds[lineIndex];
        } else {
            while(next > start && next < parent.byteEnd && (bytes[next] & 0xc0) === 0x80)next--;
            if (next === start) {
                next++;
                while(next < parent.byteEnd && (bytes[next] & 0xc0) === 0x80)next++;
            }
        }
        ranges.push([
            start,
            next
        ]);
        start = next;
    }
    if (ranges.length <= 1) return [];
    const parts = ranges.map(([s, e], idx)=>makeNode(bytes, parent.grammarId, `${parent.symbolName}#part-${idx + 1}`, `${parent.symbolPath}#part-${idx + 1}`, 'part', parent.depth + 1, s, e, parent.nodeId, {
            partIndex: idx + 1,
            totalParts: ranges.length
        }));
    parent.partIds = parts.map((p)=>p.nodeId);
    parts.forEach((part, idx)=>{
        part.partOfId = parent.nodeId;
        part.previousPartId = parts[idx - 1]?.nodeId;
        part.nextPartId = parts[idx + 1]?.nodeId;
    });
    return parts;
}
function decomposeBraceAndStringLanguage(bytes, lines, parent, spec, maxBlockBytes) {
    if (parent.depth >= 12) return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
    const source = bytes.subarray(parent.byteStart, parent.byteEnd).toString('utf8');
    const masked = maskCode(source);
    const atByte = (offset)=>parent.byteStart + Buffer.byteLength(source.slice(0, offset));
    const intervals = [];
    let depth = 0;
    let opening = 0;
    let start = 0;
    let boundary = 0;
    let parentheses = 0;
    let squareBrackets = 0;
    for(let i = 0; i < masked.length; i++){
        if (depth === 0 && masked[i] === '(') parentheses++;
        if (depth === 0 && masked[i] === ')') parentheses--;
        if (depth === 0 && masked[i] === '[') squareBrackets++;
        if (depth === 0 && masked[i] === ']') squareBrackets--;
        if (depth === 0 && (parentheses > 0 || squareBrackets > 0)) continue;
        if (depth === 0 && (masked[i] === ';' || masked[i] === '}')) boundary = i + 1;
        if (masked[i] === '{') {
            if (depth === 0) {
                opening = i;
                start = boundary;
                const prefix = source.slice(start, i);
                const declaration = /(?:^|\n)([ \t]*(?:(?:export|default|async|public|private|protected|static|abstract)\s+)*(?:function\b|class\b|interface\b|enum\b|namespace\b|(?:const|let|var)\b|[A-Za-z_$][\w$]*\s*\())/g;
                let match;
                while(match = declaration.exec(prefix))start = boundary + match.index + (match[0].startsWith('\n') ? 1 : 0);
                while(start < i && /\s/.test(source[start]))start++;
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
                intervals.push({
                    byteStart: atByte(start),
                    byteEnd: atByte(end),
                    headerEnd: atByte(opening + 1),
                    kind: 'block'
                });
                boundary = end;
            }
        }
    }
    for (const match of masked.matchAll(/(?:^|[;\n])[ \t]*(?:(?:export|default)\s+)*(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^;\n]*?=>/g)){
        let begin = match.index;
        if (masked[begin] === ';' || masked[begin] === '\n') begin++;
        const headerEnd = match.index + match[0].length;
        if (intervals.some((iv)=>atByte(begin) >= iv.byteStart && atByte(begin) < iv.byteEnd)) continue;
        let end = headerEnd;
        let nesting = 0;
        for(; end < masked.length; end++){
            const ch = masked[end];
            if ('([{'.includes(ch)) nesting++;
            if (')]}'.includes(ch)) nesting--;
            if (nesting === 0 && (ch === ';' || ch === '\n')) {
                end++;
                break;
            }
        }
        const byteStart = atByte(begin), byteEnd = atByte(end);
        if (intervals.some((iv)=>byteStart < iv.byteEnd && byteEnd > iv.byteStart)) continue;
        intervals.push({
            byteStart,
            byteEnd,
            headerEnd: atByte(headerEnd),
            kind: 'block'
        });
    }
    for (const match of source.matchAll(/`(?:\\[\s\S]|[^`\\])*`/g)){
        const begin = atByte(match.index);
        const end = atByte(match.index + match[0].length);
        if (intervals.some((iv)=>begin >= iv.byteStart && end <= iv.byteEnd)) continue;
        const det = spec.strings.embeddedDetectors?.find((d)=>d.pattern.test(match[0]));
        if (!det && !match[0].includes('\n')) continue;
        const lineStart = source.lastIndexOf('\n', match.index - 1) + 1;
        let charEnd = match.index + match[0].length;
        const tail = /^[; \t]*(?:\r?\n|$)/.exec(source.slice(charEnd));
        if (tail) charEnd += tail[0].length;
        const priorEnd = intervals.reduce((end, iv)=>iv.byteEnd <= begin ? Math.max(end, iv.byteEnd) : end, parent.byteStart);
        const byteStart = Math.max(atByte(lineStart), priorEnd);
        const byteEnd = atByte(charEnd);
        if (intervals.some((iv)=>byteStart < iv.byteEnd && byteEnd > iv.byteStart)) continue;
        intervals.push({
            byteStart,
            byteEnd,
            headerEnd: begin + 1,
            kind: 'embedded_string',
            embeddedGrammar: det?.targetGrammar
        });
    }
    intervals.sort((a, b)=>a.byteStart - b.byteStart);
    if (intervals.length === 0) {
        return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
    }
    const rawSegments = [];
    let cursorByte = parent.byteStart;
    for (const iv of intervals){
        if (iv.byteStart < cursorByte || iv.byteStart < parent.byteStart || iv.byteEnd > parent.byteEnd || iv.headerEnd < iv.byteStart || iv.headerEnd > iv.byteEnd) continue;
        const segStart = iv.byteStart;
        const segEnd = iv.byteEnd;
        if (segEnd <= segStart) continue;
        if (segStart > cursorByte) {
            rawSegments.push({
                byteStart: cursorByte,
                byteEnd: segStart,
                kind: 'statement',
                headerText: bytes.subarray(cursorByte, Math.min(segStart, cursorByte + 256)).toString('utf8')
            });
        }
        rawSegments.push({
            byteStart: segStart,
            byteEnd: segEnd,
            kind: iv.kind,
            headerEnd: iv.headerEnd,
            headerText: bytes.subarray(segStart, Math.min(segEnd, segStart + 320)).toString('utf8'),
            embeddedGrammar: iv.embeddedGrammar
        });
        cursorByte = segEnd;
    }
    if (cursorByte < parent.byteEnd) {
        rawSegments.push({
            byteStart: cursorByte,
            byteEnd: parent.byteEnd,
            kind: 'statement',
            headerText: bytes.subarray(cursorByte, Math.min(parent.byteEnd, cursorByte + 256)).toString('utf8')
        });
    }
    const children = [];
    const usedNames = new Map();
    for(let i = 0; i < rawSegments.length; i++){
        const seg = rawSegments[i];
        const baseName = inferSymbolName(seg.headerText, `${seg.kind}-${i + 1}`);
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
            node.children = decomposeByGrammar(bytes, lines, node, REGISTRY.get(seg.embeddedGrammar), maxBlockBytes);
        } else if (seg.kind === 'block' && seg.headerEnd !== undefined && bytes[seg.headerEnd - 1] === 0x7b) {
            const closing = bytes.lastIndexOf(0x7d, seg.byteEnd - 1);
            if (closing > seg.headerEnd) {
                const body = makeNode(bytes, spec.id, `${sym}::body`, symPath, 'block', node.depth, seg.headerEnd, closing, node.nodeId);
                const nested = decomposeBraceAndStringLanguage(bytes, lines, body, spec, maxBlockBytes);
                if (nested.length && (nested.some((n)=>n.kind === 'block' || n.kind === 'embedded_string') || node.byteEnd - node.byteStart > maxBlockBytes)) {
                    node.children = [
                        makeNode(bytes, spec.id, `${sym}::header`, `${symPath}::header`, 'statement', node.depth + 1, seg.byteStart, seg.headerEnd, node.nodeId),
                        ...nested.map((n)=>({
                                ...n,
                                parentId: node.nodeId
                            })),
                        makeNode(bytes, spec.id, `${sym}::footer`, `${symPath}::footer`, 'statement', node.depth + 1, closing, seg.byteEnd, node.nodeId)
                    ];
                }
            }
        }
        children.push(node);
    }
    return children;
}
function decomposeByGrammar(bytes, lines, parent, spec, maxBlockBytes) {
    const subLines = lines.filter((l)=>l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
    if (subLines.length === 0) return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
    if (spec.blocks.sectionHierarchy?.length) {
        for (const levelSpec of spec.blocks.sectionHierarchy){
            const hits = [];
            for(let i = 0; i < subLines.length; i++){
                if (!isLineComment(subLines[i].text, spec) && levelSpec.pattern.test(subLines[i].text)) {
                    hits.push(i);
                }
            }
            if (hits.length >= 2 || hits.length === 1 && hits[0] > 0) {
                const bounds = [];
                if (hits[0] > 0) {
                    bounds.push([
                        parent.byteStart,
                        subLines[hits[0]].byteStart,
                        'preamble'
                    ]);
                }
                for(let h = 0; h < hits.length; h++){
                    const startByte = subLines[hits[h]].byteStart;
                    const endByte = h + 1 < hits.length ? subLines[hits[h + 1]].byteStart : parent.byteEnd;
                    const name = inferSymbolName(subLines[hits[h]].text, `section-${h + 1}`);
                    bounds.push([
                        startByte,
                        endByte,
                        name
                    ]);
                }
                const remainingSpec = {
                    ...spec,
                    blocks: {
                        ...spec.blocks,
                        sectionHierarchy: spec.blocks.sectionHierarchy.filter((s)=>s.level > levelSpec.level)
                    }
                };
                return bounds.map(([s, e, name], idx)=>{
                    const symPath = `${parent.symbolPath}::${name}`;
                    const node = makeNode(bytes, spec.id, name, symPath, 'section', parent.depth + 1, s, e, parent.nodeId, {
                        partIndex: idx + 1,
                        totalParts: bounds.length
                    });
                    node.children = decomposeByGrammar(bytes, lines, node, remainingSpec, maxBlockBytes);
                    return node;
                });
            }
        }
    }
    if (spec.blocks.statementTerminator) {
        const bounds = [];
        let startByte = parent.byteStart;
        let headerLine = subLines[0].text;
        for(let i = 0; i < subLines.length; i++){
            if (startByte === subLines[i].byteStart) headerLine = subLines[i].text;
            if (spec.blocks.statementTerminator.test(subLines[i].text)) {
                bounds.push([
                    startByte,
                    subLines[i].byteEnd,
                    inferSymbolName(headerLine, `stmt-${bounds.length + 1}`)
                ]);
                startByte = subLines[i].byteEnd;
            }
        }
        if (startByte < parent.byteEnd && bounds.length > 0) {
            bounds.push([
                startByte,
                parent.byteEnd,
                'trailing'
            ]);
        }
        if (bounds.length >= 2) {
            return bounds.map(([s, e, name], idx)=>makeNode(bytes, spec.id, name, `${parent.symbolPath}::${name}#${idx + 1}`, 'statement', parent.depth + 1, s, e, parent.nodeId));
        }
    }
    if (spec.blocks.keywordPairs?.length) {
        const intervals = [];
        let depth = 0;
        let startLine = 0;
        for(let i = 0; i < subLines.length; i++){
            const text = subLines[i].text;
            if (isLineComment(text, spec)) continue;
            const isClose = spec.blocks.keywordPairs.some((kp)=>kp.close.test(text));
            const isOpen = !isClose && spec.blocks.keywordPairs.some((kp)=>kp.open.test(text));
            if (isOpen) {
                if (depth === 0) startLine = i;
                depth++;
            } else if (isClose && depth > 0) {
                depth--;
                if (depth === 0) {
                    const blockText = subLines.slice(startLine, i + 1).map((x)=>x.text).join('');
                    const det = spec.strings.embeddedDetectors?.find((d)=>d.pattern.test(blockText));
                    intervals.push({
                        startLine,
                        endLine: i,
                        embeddedGrammar: det?.targetGrammar
                    });
                }
            }
        }
        if (intervals.length > 0 && !(intervals.length === 1 && intervals[0].startLine === 0 && intervals[0].endLine === subLines.length - 1)) {
            const nodes = [];
            let cursor = parent.byteStart;
            for (const iv of intervals){
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
            const firstLine = subLines[0];
            const lastLine = subLines[subLines.length - 1];
            const headerNode = makeNode(bytes, spec.id, `${parent.symbolName}::header`, `${parent.symbolPath}::header`, 'statement', parent.depth + 1, firstLine.byteStart, firstLine.byteEnd, parent.nodeId);
            const bodyDummy = makeNode(bytes, spec.id, `${parent.symbolName}::body`, `${parent.symbolPath}`, 'block', parent.depth, firstLine.byteEnd, lastLine.byteStart, parent.nodeId);
            const bodyChildren = decomposeByGrammar(bytes, lines, bodyDummy, spec, maxBlockBytes).map((c)=>({
                    ...c,
                    parentId: parent.nodeId,
                    depth: parent.depth + 1
                }));
            const footerNode = makeNode(bytes, spec.id, `${parent.symbolName}::footer`, `${parent.symbolPath}::footer`, 'statement', parent.depth + 1, lastLine.byteStart, lastLine.byteEnd, parent.nodeId);
            if (bodyChildren.length > 0) {
                return [
                    headerNode,
                    ...bodyChildren,
                    footerNode
                ];
            }
        }
    }
    if (spec.blocks.tagPairs) {
        const voidSet = new Set((spec.blocks.tagPairs.voidTags ?? []).map((t)=>t.toLowerCase()));
        const intervals = [];
        const stack = [];
        for(let i = 0; i < subLines.length; i++){
            const text = subLines[i].text;
            for (const m of text.matchAll(/<\/?([a-zA-Z][\w-]*)[^>]*>/g)){
                const full = m[0];
                const tag = m[1].toLowerCase();
                if (voidSet.has(tag) || full.endsWith('/>')) continue;
                if (full.startsWith('</')) {
                    if (stack.length > 0 && stack[stack.length - 1].tag === tag) {
                        const top = stack.pop();
                        if (stack.length <= 1 && i >= top.line) {
                            intervals.push({
                                startLine: top.line,
                                endLine: i,
                                tag
                            });
                        }
                    }
                } else {
                    stack.push({
                        tag,
                        line: i
                    });
                }
            }
        }
        const topIntervals = intervals.filter((iv, idx)=>!intervals.some((other, oIdx)=>oIdx !== idx && other.startLine <= iv.startLine && other.endLine >= iv.endLine && other.endLine - other.startLine > iv.endLine - iv.startLine));
        if (topIntervals.length >= 2) {
            const nodes = [];
            let cursor = parent.byteStart;
            for (const iv of topIntervals){
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
    if (spec.blocks.indentationScoped) {
        return decomposePythonDefinitions(bytes, lines, parent, spec, maxBlockBytes);
    }
    if (spec.blocks.brackets?.length) {
        return decomposeBraceAndStringLanguage(bytes, lines, parent, spec, maxBlockBytes);
    }
    return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
}
function maskCode(text, python = false) {
    return text.replace(python ? /("""[\s\S]*?(?:"""|$)|\x27\x27\x27[\s\S]*?(?:\x27\x27\x27|$)|"(?:\\[\s\S]|[^"\\])*"|\x27(?:\\[\s\S]|[^\x27\\])*\x27|#[^\n]*)/g : /("(?:\\[\s\S]|[^"\\])*"|\x27(?:\\[\s\S]|[^\x27\\])*\x27|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*)/g, (match)=>match.replace(/[^\n\r]/g, ' '));
}
function decomposePythonDefinitions(bytes, lines, parent, spec, maxBlockBytes) {
    const local = lines.filter((l)=>l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
    const masked = maskCode(bytes.subarray(parent.byteStart, parent.byteEnd).toString('utf8'), true).split(/(?<=\n)/u);
    const indent = (s)=>/^[ \t]*/.exec(s)[0].replace(/\t/g, '        ').length;
    const candidates = [];
    for(let i = 0; i < local.length; i++){
        const m = /^[ \t]*(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/.exec(masked[i] ?? '');
        if (!m) continue;
        let level = 0;
        let headerEnd = local[i].byteEnd;
        let found = false;
        for(let j = i; j < local.length && !found; j++){
            for(let k = 0; k < (masked[j] ?? '').length; k++){
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
        candidates.push({
            index: i,
            indent: indent(masked[i]),
            name: m[1],
            headerEnd
        });
    }
    if (!candidates.length) return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
    const minimum = Math.min(...candidates.map((c)=>c.indent));
    const heads = candidates.filter((c)=>c.indent === minimum);
    const nodes = [];
    let cursor = parent.byteStart;
    for (const head of heads){
        let first = head.index;
        while(first > 0 && /^[ \t]*@/.test(masked[first - 1] ?? '') && indent(masked[first - 1]) === minimum)first--;
        let last = head.index;
        while(last + 1 < local.length && local[last].byteEnd <= head.headerEnd)last++;
        while(last + 1 < local.length){
            const next = masked[last + 1] ?? '';
            if (next.trim() && indent(next) <= minimum) break;
            last++;
        }
        while(last > head.index && !(masked[last] ?? '').trim())last--;
        const start = local[first].byteStart;
        const end = local[last].byteEnd;
        if (start < cursor) continue;
        if (start > cursor) nodes.push(makeNode(bytes, spec.id, `gap-${nodes.length + 1}`, `${parent.symbolPath}::gap-${nodes.length + 1}`, 'statement', parent.depth + 1, cursor, start, parent.nodeId));
        const n = makeNode(bytes, spec.id, head.name, `${parent.symbolPath}::${head.name}`, 'block', parent.depth + 1, start, end, parent.nodeId);
        n.headerByteStart = start;
        n.headerByteEnd = head.headerEnd;
        const bodyStart = local.find((l)=>l.byteStart >= head.headerEnd)?.byteStart ?? end;
        if (bodyStart < end && candidates.some((c)=>local[c.index].byteStart >= bodyStart && local[c.index].byteStart < end && c.indent > minimum)) {
            const header = makeNode(bytes, spec.id, `${head.name}::header`, `${n.symbolPath}::header`, 'statement', n.depth + 1, start, bodyStart, n.nodeId);
            const body = makeNode(bytes, spec.id, `${head.name}::body`, n.symbolPath, 'block', n.depth, bodyStart, end, n.nodeId);
            n.children = [
                header,
                ...decomposePythonDefinitions(bytes, lines, body, spec, maxBlockBytes).map((child)=>({
                        ...child,
                        parentId: n.nodeId
                    }))
            ];
        }
        nodes.push(n);
        cursor = end;
    }
    if (cursor < parent.byteEnd) nodes.push(makeNode(bytes, spec.id, 'trailing', `${parent.symbolPath}::trailing`, 'statement', parent.depth + 1, cursor, parent.byteEnd, parent.nodeId));
    return nodes;
}
export function verifyPartitionConservation(bytes, node) {
    const actualSha = sha256(bytes.subarray(node.byteStart, node.byteEnd));
    if (actualSha !== node.sha256) return false;
    if (node.children.length === 0) return true;
    let cursor = node.byteStart;
    const buffers = [];
    for (const child of node.children){
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
export function decomposeCodeSource(textOrBytes, options = {}) {
    const bytes = Buffer.isBuffer(textOrBytes) ? textOrBytes : Buffer.from(textOrBytes, 'utf8');
    const maxBlockBytes = options.maxBlockBytes ?? 4096;
    if (!Number.isSafeInteger(maxBlockBytes) || maxBlockBytes <= 0) {
        throw new RangeError('maxBlockBytes must be a positive safe integer');
    }
    const spec = (options.grammarId ? getLanguageGrammar(options.grammarId) : undefined) ?? (options.originKey ? getLanguageGrammar(options.originKey) : undefined) ?? getLanguageGrammar('typescript');
    const lines = splitLinesWithByteBounds(bytes);
    const rootName = options.originKey ?? spec.id;
    const root = makeNode(bytes, spec.id, rootName, rootName, 'root', 0, 0, bytes.length, null);
    root.children = decomposeByGrammar(bytes, lines, root, spec, maxBlockBytes);
    const flatNodes = [];
    const lineAt = (offset)=>{
        let lo = 0, hi = lines.length;
        while(lo < hi){
            const mid = lo + hi >>> 1;
            if (lines[mid].byteStart <= offset) lo = mid + 1;
            else hi = mid;
        }
        return Math.max(1, lo);
    };
    const walk = (n)=>{
        n.startLine = lineAt(n.byteStart);
        n.endLine = lineAt(Math.max(n.byteStart, n.byteEnd - 1));
        n.subTokens = splitIdentifierSubTokens(n.symbolName);
        if ((n.kind === 'block' || n.kind === 'section') && n.headerByteStart === undefined) {
            n.headerByteStart = n.byteStart;
            n.headerByteEnd = Math.min(n.byteEnd, lines[n.startLine - 1]?.byteEnd ?? n.byteEnd);
        }
        if (n.children.length === 0 && n.kind !== 'part') n.children = partitionIntoContiguousParts(bytes, lines, n, maxBlockBytes);
        flatNodes.push(n);
        for (const c of n.children){
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
        flatNodes
    };
}
const BLIND_CODE_STOP = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'when',
    'what',
    'which',
    'where',
    'should',
    'would',
    'could',
    'there',
    'their',
    'about',
    'after',
    'before',
    'return',
    'import',
    'class',
    'function',
    'Following',
    'following',
    'Python',
    'python',
    'django',
    'astropy',
    'True',
    'False',
    'None',
    'self',
    'the',
    'and',
    'for',
    'not',
    'are',
    'but',
    'can',
    'all',
    'one',
    'new',
    'use',
    'set',
    'get',
    'Official',
    'LongBench',
    'Code',
    'Repository',
    'Options',
    'Reply',
    'first',
    'line',
    'FINAL_CHOICE',
    'followed',
    'sentence',
    'justification',
    'citing',
    'available',
    'does',
    'code',
    'project',
    'correctly',
    'statement',
    'method',
    'value',
    'using',
    'used',
    'Description',
    'Current',
    'Behaviour',
    'Behavior',
    'Expected',
    'However',
    'When',
    'There',
    'Here',
    'Looking',
    'other',
    'methods',
    'issue',
    'issues',
    'problem',
    'problems',
    'error',
    'errors',
    'message',
    'messages',
    'example',
    'examples',
    'should',
    'could',
    'would',
    'result',
    'results',
    'instead',
    'default',
    'something',
    'another',
    'because',
    'provide',
    'created',
    'called',
    'against',
    'several'
]);
export function rankRepositoryAstBlocksBlind(files, query, options = {}) {
    const maxFiles = options.maxFilesToDecompose ?? 8;
    const maxBlockBytes = options.maxBlockBytes ?? 2600;
    const maxTotalChars = options.maxTotalChars ?? 22000;
    const rawMatches = query.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
    const expandedTokens = [];
    for (const tok of rawMatches){
        expandedTokens.push(tok);
        if (tok.includes('.')) {
            for (const part of tok.split('.')){
                if (part.length >= 3) expandedTokens.push(part);
            }
        }
        for (const numMatch of tok.matchAll(/\d{3,}/g)){
            expandedTokens.push(numMatch[0]);
        }
    }
    const definedSymbols = new Set();
    for (const f of files){
        for (const m of f.text.matchAll(/\b(?:def|class|function|interface|enum|type|const|let|var|fn|func)\s+([A-Za-z_$][\w$]*)/g))definedSymbols.add(m[1]);
        for (const m of f.text.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::[^{}]+)?\{/gm))definedSymbols.add(m[1]);
    }
    const isDefinedSymbol = (token)=>definedSymbols.has(token);
    const queryIds = [
        ...new Set(expandedTokens.filter((tok)=>isDefinedSymbol(tok) || !BLIND_CODE_STOP.has(tok) && (hasTechnicalIdentifierFormatting(tok) || tok.length >= 4)))
    ];
    const unusedImports = new Set();
    const usedImports = new Set();
    const importModuleBySymbol = new Map();
    if (options.importStatement) {
        const normalizedImports = options.importStatement.replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner)=>inner.replace(/\s*\n\s*/g, ' '));
        for (const line of normalizedImports.split('\n')){
            const mFrom = /from\s+([\w.]+)\s+import\s+(.+)/.exec(line);
            const mImp = !mFrom ? /^\s*import\s+(.+)/.exec(line) : null;
            const modName = mFrom ? mFrom[1] : 'global_import';
            const rhs = mFrom ? mFrom[2] : mImp ? mImp[1] : '';
            if (rhs) {
                for (const part of rhs.split(',')){
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
    const cursorTailWords = new Set();
    if (options.cursorContext) {
        const tailLines = options.cursorContext.trim().split('\n').slice(-6).join('\n');
        for (const m of tailLines.match(/[A-Za-z0-9_]{3,}/g) ?? []){
            for (const sub of [
                m.toLowerCase(),
                ...splitIdentifierSubTokens(m)
            ]){
                if (sub.length >= 3 && !BLIND_CODE_STOP.has(sub)) cursorTailWords.add(sub);
            }
        }
    }
    const df = new Map();
    for (const id of queryIds){
        let count = 0;
        for (const f of files){
            if (f.text.includes(id) || f.path.includes(id)) count++;
        }
        if (count >= 1) df.set(id, count);
    }
    const phraseClues = [];
    for (const m of query.matchAll(/\b([a-z]{3,}\s+[a-z]{3,}(?:,?\s+[a-z]{3,}){0,2})\b/g)){
        const phrase = m[1].trim();
        const words = phrase.split(/[\s,]+/);
        if (phrase.length >= 10 && words.every((w)=>!BLIND_CODE_STOP.has(w))) {
            let c = 0;
            for (const f of files)if (f.text.includes(`"${phrase}`) || f.text.includes(` ${phrase}`) || f.text.includes(`${phrase}:`) || f.text.includes(`${phrase},`)) c++;
            if (c === 1) phraseClues.push(phrase);
        }
    }
    const fileHeaderImports = new Map();
    for (const f of files){
        const headerSlice = f.text.slice(0, 2400).replace(/\(\s*([\s\S]*?)\s*\)/g, (_, inner)=>inner.replace(/\s*\n\s*/g, ' '));
        const syms = new Set();
        for (const line of headerSlice.split('\n')){
            const mFrom = /from\s+[\w.]+\s+import\s+(.+)/.exec(line);
            if (mFrom) {
                for (const p of mFrom[1].split(',')){
                    const clean = p.replace(/#.*/, '').replace(/[()\\]/g, '').trim().split(/\s+as\s+/).pop()?.trim() ?? '';
                    if (clean && /^[A-Za-z_]\w{2,}$/.test(clean)) syms.add(clean);
                }
            }
        }
        fileHeaderImports.set(f.path, syms);
    }
    const codeSymbolCache = new Map();
    const isCodeSymbol = (id)=>{
        const cached = codeSymbolCache.get(id);
        if (cached !== undefined) return cached;
        const val = isDefinedSymbol(id) || /[_0-9]/.test(id) || /[A-Z]/.test(id) && /[a-z]/.test(id) && !/^[A-Z][a-z]+$/.test(id) || files.some((f)=>f.path.toLowerCase().includes(id.toLowerCase()) || f.text.includes(`def ${id}`) || f.text.includes(`class ${id}`) || f.text.includes(`.${id}`));
        codeSymbolCache.set(id, val);
        return val;
    };
    const rareQueryClues = [
        ...df.entries()
    ].filter(([id, c])=>c <= Math.max(2, Math.floor(files.length / 2)) && isCodeSymbol(id)).map(([id])=>id);
    const fileRareClues = new Map();
    let maxFileRareCount = 0;
    for (const f of files){
        const matched = rareQueryClues.filter((id)=>f.text.includes(id) || f.path.toLowerCase().includes(id.toLowerCase()));
        fileRareClues.set(f.path, matched);
        if (matched.length > maxFileRareCount) maxFileRareCount = matched.length;
    }
    const scoredFiles = files.map((f, fIdx)=>{
        let score = fIdx === 0 ? 40 : fIdx === 1 ? 20 : 0;
        for (const [id, c] of df.entries()){
            const idf = Math.max(1, Math.round(Math.max(25, files.length) / c));
            const symMult = isCodeSymbol(id) ? 2 : 1;
            if (f.path.toLowerCase().includes(id.toLowerCase())) score += idf * 8 * symMult;
            if (f.text.includes(id)) score += idf * 2 * symMult;
        }
        for (const ph of phraseClues){
            if (f.text.includes(ph)) score += 600;
        }
        const fRare = fileRareClues.get(f.path) ?? [];
        if (fRare.length >= 2) {
            score += fRare.length * fRare.length * 55;
            if (fRare.length === maxFileRareCount) score += 300;
        }
        for (const sym of unusedImports)if (f.text.includes(sym)) score += 500;
        for (const sym of usedImports)if (f.text.includes(sym)) score += 100;
        return {
            ...f,
            score
        };
    }).sort((a, b)=>b.score - a.score);
    const candidateBlocks = [];
    let allPartitionsVerified = true;
    const topRankedFiles = scoredFiles.slice(0, maxFiles);
    const orientationCandidate = scoredFiles.find((f)=>!topRankedFiles.includes(f) && (/(?:^|\/)(?:readme|architecture|overview|docs?\/)/i.test(f.path) || /\.(?:md|rst)$/i.test(f.path)));
    if (orientationCandidate && topRankedFiles.length < maxFiles + 1) {
        topRankedFiles.push(orientationCandidate);
    }
    for(let fRank = 0; fRank < topRankedFiles.length; fRank++){
        const f = topRankedFiles[fRank];
        const fRare = fileRareClues.get(f.path) ?? [];
        const fMissingRare = rareQueryClues.filter((c)=>!fRare.includes(c)).slice(0, 4);
        const fImports = [
            ...fileHeaderImports.get(f.path) ?? []
        ];
        const relevantImports = fImports.filter((s)=>queryIds.includes(s) || /[A-Z]/.test(s)).slice(0, 8);
        const fileTriangulationNote = fRare.length >= 2 ? `[BRIDGES: ${fRare.slice(0, 4).join(',')}]` : '';
        const tree = decomposeCodeSource(f.text, {
            originKey: f.path,
            maxBlockBytes
        });
        if (!tree.partitionVerified) allPartitionsVerified = false;
        const leaves = [];
        const selectUnits = (node)=>{
            const size = node.byteEnd - node.byteStart;
            if ((node.kind === 'block' || node.kind === 'embedded_string' || node.kind === 'section') && size <= maxBlockBytes) {
                if (size > 0) leaves.push(node);
            } else if (node.children.length) {
                for (const child of node.children)selectUnits(child);
            } else if (size > 0) leaves.push(node);
        };
        selectUnits(tree.root);
        const buf = Buffer.from(f.text, 'utf8');
        for (const node of leaves){
            const txt = buf.subarray(node.byteStart, node.byteEnd).toString('utf8');
            let bScore = Math.max(1, (maxFiles - fRank) * 6);
            const matchedClues = new Set();
            const leafName = node.symbolName.replace(/#part-\d+$|::header$|::footer$/, '');
            for (const [id, c] of df.entries()){
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
            for (const ph of phraseClues){
                if (txt.includes(ph)) {
                    bScore += 1800;
                    matchedClues.add(ph);
                }
            }
            for (const impSym of relevantImports){
                if (txt.includes(impSym)) {
                    bScore += 60;
                    matchedClues.add(impSym);
                }
            }
            if (fRare.length >= 2 && matchedClues.size >= 1) {
                bScore += fRare.length * 45;
            }
            for (const sym of unusedImports){
                const symSubTokens = splitIdentifierSubTokens(sym);
                const modName = importModuleBySymbol.get(sym) ?? '';
                const modSubTokens = splitIdentifierSubTokens(modName);
                let cursorBonus = 0;
                for (const sub of [
                    ...symSubTokens,
                    ...modSubTokens
                ]){
                    if (cursorTailWords.has(sub)) cursorBonus += 1800;
                }
                if (node.symbolPath.includes(sym)) bScore += 2000 + cursorBonus;
                else if (txt.includes(sym)) bScore += 400 + Math.round(cursorBonus / 2);
            }
            for (const sym of usedImports){
                const symSubTokens = splitIdentifierSubTokens(sym);
                let cursorBonus = 0;
                for (const sub of symSubTokens){
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
                    text: `// FILE: ${f.path} (${node.symbolPath}) ${fileTriangulationNote}\n${txt}`
                });
            }
        }
    }
    const topSeeds = [
        ...candidateBlocks
    ].sort((a, b)=>b.score - a.score).slice(0, 10);
    const seedSymbols = new Map();
    for (const s of topSeeds){
        if (s.leafName && s.leafName.length >= 4 && !s.leafName.startsWith('module-preamble')) {
            const prev = seedSymbols.get(s.leafName) ?? new Set();
            for (const c of s.matchedClues)prev.add(c);
            seedSymbols.set(s.leafName, prev);
        }
    }
    for (const b of candidateBlocks){
        let callHopClues = new Set(b.matchedClues);
        let callEdges = 0;
        for (const [sym, symClues] of seedSymbols.entries()){
            if (sym === b.leafName) continue;
            if (b.text.includes(`${sym}(`) || b.text.includes(`.${sym}`)) {
                callEdges++;
                for (const c of symClues)callHopClues.add(c);
            }
        }
        if (callEdges > 0 && callHopClues.size >= 2) {
            b.score += callEdges * 90 * callHopClues.size;
        }
    }
    const top3Blocks = [
        ...candidateBlocks
    ].sort((a, b)=>b.score - a.score).slice(0, 3);
    const outgoingCalls = new Map();
    for (const tb of top3Blocks){
        for (const m of tb.text.matchAll(/\b([a-z_][a-z0-9_]{5,})\s*\(/g)){
            const fn = m[1];
            if (!BLIND_CODE_STOP.has(fn) && !outgoingCalls.has(fn)) outgoingCalls.set(fn, tb.originKey);
        }
    }
    if (outgoingCalls.size > 0) {
        for (const b of candidateBlocks){
            const callerFile = outgoingCalls.get(b.leafName);
            if (callerFile && callerFile !== b.originKey) {
                b.score += 1400;
                b.text = b.text.replace('\n', ` [CROSS-FILE CALLEE OF ${callerFile}: ${b.leafName}()]\n`);
            }
        }
    }
    candidateBlocks.sort((a, b)=>b.score - a.score);
    const selected = [];
    let chars = 0;
    for (const b of candidateBlocks){
        if (chars + b.text.length > maxTotalChars) break;
        selected.push(b);
        chars += b.text.length + 2;
    }
    selected.sort((a, b)=>{
        const isOrientA = /(?:^|\/)(?:readme|architecture|overview|docs?\/)/i.test(a.originKey) ? 0 : 1;
        const isOrientB = /(?:^|\/)(?:readme|architecture|overview|docs?\/)/i.test(b.originKey) ? 0 : 1;
        if (isOrientA !== isOrientB) return isOrientA - isOrientB;
        return a.score - b.score;
    });
    return {
        blocks: selected,
        allPartitionsVerified
    };
}
export function splitCorpusStreamIntoFiles(rawText, options = {}) {
    const bytes = Buffer.from(rawText, 'utf8');
    const lines = splitLinesWithByteBounds(bytes);
    const files = [];
    const lineAt = (offset)=>{
        let lo = 0, hi = lines.length;
        while(lo < hi){
            const mid = lo + hi >>> 1;
            if (lines[mid].byteStart <= offset) lo = mid + 1;
            else hi = mid;
        }
        return Math.max(1, lo);
    };
    const orientation = (path, text)=>{
        const grammar = getLanguageGrammar(path);
        if (grammar && grammar.id !== 'markdown') return false;
        return /(?:^|\/)(?:readme|architecture|contributing|overview|changelog|docs?\/)/i.test(path) || /\.(?:md|markdown|rst|txt)$/i.test(path) || /^#{1,2}\s+\S/m.test(text.slice(0, 400));
    };
    const emit = (start, end, kind, path, provenance = 'inferred')=>{
        if (end <= start) return;
        const text = bytes.subarray(start, end).toString('utf8');
        const label = path ?? options.defaultOriginKey ?? `corpus-segment-${files.length + 1}`;
        files.push({
            path: label,
            ...provenance === 'inferred' ? {
                inferredLabel: label
            } : {
                verifiedPath: label
            },
            pathProvenance: provenance,
            segmentKind: kind,
            text,
            byteStart: start,
            byteEnd: end,
            startLine: lineAt(start),
            endLine: lineAt(Math.max(start, end - 1)),
            isOrientationDoc: orientation(label, text)
        });
    };
    let fence;
    let activePath;
    let cursor = 0;
    let hadMarker = false;
    for (const line of lines){
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
        if (fenceMatch) {
            if (!fence) fence = fenceMatch[1];
            else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
            continue;
        }
        if (fence) continue;
        const m = /^\[(start|end) of ([^\]\r\n]+)\][ \t]*(?:\r?\n)?$/.exec(line.text);
        if (!m || m[1] === 'end' && m[2].trim() !== activePath) continue;
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
    if (options.defaultOriginKey) {
        emit(0, bytes.length, 'file', options.defaultOriginKey, 'caller');
        return files;
    }
    const markdown = /^#{1,2}\s+\S/m.test(rawText.slice(0, 400));
    const definition = /^(?:class|def|async\s+def)\s+([A-Za-z_]\w*)/m.exec(rawText);
    const reference = /(?:declared in|defined in|available as|in file)\s+[`'"]?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[a-zA-Z0-9]+)/i.exec(rawText);
    const label = markdown ? 'corpus-document.md' : reference?.[1] ?? (definition ? `inferred_${definition[1]}.py` : 'corpus-stream');
    emit(0, bytes.length, 'inferred', label);
    return files;
}


//# sourceURL=src/code-decomposer.ts