import { sha256, stableId } from './store.js';
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
    const subLines = lines.filter((l)=>l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
    if (subLines.length <= 1 || parent.byteEnd - parent.byteStart <= maxPartBytes) return [];
    const ranges = [];
    let start = parent.byteStart;
    let cursor = parent.byteStart;
    for (const l of subLines){
        if (cursor > start && l.byteEnd - start > maxPartBytes) {
            ranges.push([
                start,
                cursor
            ]);
            start = cursor;
        }
        cursor = l.byteEnd;
    }
    if (start < parent.byteEnd) ranges.push([
        start,
        parent.byteEnd
    ]);
    if (ranges.length <= 1) return [];
    return ranges.map(([s, e], idx)=>makeNode(bytes, parent.grammarId, `${parent.symbolName}#part-${idx + 1}`, `${parent.symbolPath}#part-${idx + 1}`, 'part', parent.depth + 1, s, e, parent.nodeId, {
            partIndex: idx + 1,
            totalParts: ranges.length
        }));
}
function decomposeBraceAndStringLanguage(bytes, lines, parent, spec, maxBlockBytes) {
    const subLines = lines.filter((l)=>l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
    if (subLines.length <= 1 || parent.depth >= 12) return [];
    const intervals = [];
    let depth = 0;
    let inBacktick = false;
    let inBlockComment = false;
    let blockStartLine = 0;
    let embeddedLang;
    for(let li = 0; li < subLines.length; li++){
        const line = subLines[li].text;
        if (isLineComment(line, spec) && !inBacktick && !inBlockComment) continue;
        for(let ci = 0; ci < line.length; ci++){
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
                while(ci < line.length){
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
                        const sliceText = subLines.slice(blockStartLine, li + 1).map((x)=>x.text).join('');
                        const det = spec.strings.embeddedDetectors?.find((d)=>d.pattern.test(sliceText));
                        intervals.push({
                            startLine: blockStartLine,
                            endLine: li,
                            kind: 'embedded_string',
                            embeddedGrammar: det?.targetGrammar
                        });
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
                        intervals.push({
                            startLine: blockStartLine,
                            endLine: li,
                            kind: 'block'
                        });
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
    const rawSegments = [];
    let cursorByte = parent.byteStart;
    for (const iv of intervals){
        const sigLineIdx = iv.startLine > 0 && subLines[iv.startLine - 1].byteStart >= cursorByte ? iv.startLine - 1 : iv.startLine;
        const segStart = Math.max(cursorByte, subLines[sigLineIdx].byteStart);
        const segEnd = subLines[iv.endLine].byteEnd;
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
    if (rawSegments.length === 1 && subLines.length > 4 && parent.byteEnd - parent.byteStart > maxBlockBytes) {
        const firstLine = subLines[0];
        const lastLine = subLines[subLines.length - 1];
        const headerNode = makeNode(bytes, parent.grammarId, `${parent.symbolName}::header`, `${parent.symbolPath}::header`, 'statement', parent.depth + 1, firstLine.byteStart, firstLine.byteEnd, parent.nodeId);
        const bodyDummy = makeNode(bytes, parent.grammarId, `${parent.symbolName}::body`, `${parent.symbolPath}`, 'block', parent.depth, firstLine.byteEnd, lastLine.byteStart, parent.nodeId);
        const bodyChildren = decomposeBraceAndStringLanguage(bytes, lines, bodyDummy, spec, maxBlockBytes);
        const footerNode = makeNode(bytes, parent.grammarId, `${parent.symbolName}::footer`, `${parent.symbolPath}::footer`, 'statement', parent.depth + 1, lastLine.byteStart, lastLine.byteEnd, parent.nodeId);
        const midNodes = bodyChildren.length ? bodyChildren.map((c)=>({
                ...c,
                parentId: parent.nodeId,
                depth: parent.depth + 1
            })) : partitionIntoContiguousParts(bytes, lines, bodyDummy, maxBlockBytes).map((c)=>({
                ...c,
                parentId: parent.nodeId,
                depth: parent.depth + 1
            }));
        return [
            headerNode,
            ...midNodes.length ? midNodes : [
                {
                    ...bodyDummy,
                    depth: parent.depth + 1
                }
            ],
            footerNode
        ];
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
        if (seg.embeddedGrammar && REGISTRY.has(seg.embeddedGrammar) && (node.byteStart > parent.byteStart || node.byteEnd < parent.byteEnd || node.grammarId !== parent.grammarId)) {
            node.children = decomposeByGrammar(bytes, lines, node, REGISTRY.get(seg.embeddedGrammar), maxBlockBytes);
        } else if ((node.byteEnd - node.byteStart > maxBlockBytes || node.kind === 'block' && subLines.length > 4) && (node.byteStart > parent.byteStart || node.byteEnd < parent.byteEnd)) {
            node.children = decomposeBraceAndStringLanguage(bytes, lines, node, spec, maxBlockBytes);
            if (node.children.length === 0 && node.byteEnd - node.byteStart > maxBlockBytes) {
                node.children = partitionIntoContiguousParts(bytes, lines, node, maxBlockBytes);
            }
        }
        children.push(node);
    }
    return children;
}
function decomposeByGrammar(bytes, lines, parent, spec, maxBlockBytes) {
    const subLines = lines.filter((l)=>l.byteStart >= parent.byteStart && l.byteEnd <= parent.byteEnd);
    if (subLines.length <= 1) return [];
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
    if (spec.blocks.brackets?.length) {
        return decomposeBraceAndStringLanguage(bytes, lines, parent, spec, maxBlockBytes);
    }
    return partitionIntoContiguousParts(bytes, lines, parent, maxBlockBytes);
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
    const spec = (options.grammarId ? getLanguageGrammar(options.grammarId) : undefined) ?? (options.originKey ? getLanguageGrammar(options.originKey) : undefined) ?? getLanguageGrammar('typescript');
    const lines = splitLinesWithByteBounds(bytes);
    const rootName = options.originKey ?? spec.id;
    const root = makeNode(bytes, spec.id, rootName, rootName, 'root', 0, 0, bytes.length, null);
    root.children = decomposeByGrammar(bytes, lines, root, spec, maxBlockBytes);
    const flatNodes = [];
    const walk = (n)=>{
        flatNodes.push(n);
        for (const c of n.children)walk(c);
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


//# sourceURL=src/code-decomposer.ts