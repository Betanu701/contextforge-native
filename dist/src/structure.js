import { decomposeCodeSource, getLanguageGrammar, splitCorpusStreamIntoFiles, isDefinitionNode, lexicalCodeReferences } from './code-decomposer.js';
import { splitIdentifierSubTokens } from './lexicon-priors.js';
import { stableId } from './store.js';
export const STRUCTURAL_VERSION = 'source-structure-v1';
export const STRUCTURAL_BLOCK_BYTES = 4096;
export function boundedHeaderEnd(bytes, start, end) {
    let bounded = Math.min(end, start + STRUCTURAL_BLOCK_BYTES);
    while(bounded < bytes.length && (bytes[bounded] & 0xc0) === 0x80)bounded--;
    return bounded;
}
export function isOrientationDocument(path) {
    return /(?:^|[/\\])(?:readme|architecture|overview|contributing)(?:[.\/\\]|$)/i.test(path);
}
export function isDocumentationDocument(path) {
    return isOrientationDocument(path) || /\.(?:md|markdown|rst|txt)$/i.test(path);
}
export function hasStructuralContent(text, originKey) {
    return !!getLanguageGrammar(originKey) || isDocumentationDocument(originKey) || /^\[start of [^\]]+\]/m.test(text) || /^#{1,6}\s+|^(?:(?:async|export|default|abstract)\s+)*(?:def|class|function|interface|enum|namespace|const|let|var)\s+[A-Za-z_$]/m.test(text);
}
export function structuralUnits(text, originKey, maxBlockBytes = STRUCTURAL_BLOCK_BYTES) {
    if (!Number.isSafeInteger(maxBlockBytes) || maxBlockBytes <= 0) throw new RangeError('maxBlockBytes must be a positive safe integer');
    if (!hasStructuralContent(text, originKey)) return [];
    const bytes = Buffer.from(text), out = [];
    const lineStarts = [
        0
    ];
    for(let i = 0; i < bytes.length; i++)if (bytes[i] === 10) lineStarts.push(i + 1);
    const lineAt = (offset)=>{
        let lo = 0, hi = lineStarts.length;
        while(lo + 1 < hi){
            const mid = lo + hi >> 1;
            if (lineStarts[mid] <= offset) lo = mid;
            else hi = mid;
        }
        return lo + 1;
    };
    const files = splitCorpusStreamIntoFiles(text, {
        defaultOriginKey: originKey
    });
    let cursor = 0;
    for (const file of files){
        const base = cursor;
        cursor += Buffer.byteLength(file.text);
        const start = file.byteStart ?? base, end = file.byteEnd ?? cursor;
        if (file.segmentKind === 'marker') continue;
        const grammar = getLanguageGrammar(file.grammarId ?? file.path);
        const documentation = grammar?.id === 'markdown' || !grammar && (isDocumentationDocument(file.path) || file.isOrientationDoc);
        const orientation = documentation && (isOrientationDocument(file.path) || /^(?:section: )?(?:architecture|overview|readme)\b/i.test(file.inferredLabel ?? ''));
        if (!grammar && !documentation) continue;
        const id = stableId(STRUCTURAL_VERSION, originKey, start, end, 'file');
        const root = {
            unitId: id,
            parentId: null,
            childIds: [],
            kind: documentation ? 'section' : 'file',
            symbolName: file.path,
            symbolPath: file.path,
            byteStart: start,
            byteEnd: end,
            startLine: lineAt(start),
            endLine: lineAt(Math.max(start, end - 1)),
            headerByteStart: start,
            headerByteEnd: Math.min(end, start + (Buffer.from(file.text).indexOf(10) + 1 || Buffer.byteLength(file.text))),
            subTokens: splitIdentifierSubTokens(file.path),
            references: [],
            originKey: file.path,
            pathVerified: !!file.verifiedPath,
            pathProvenance: file.pathProvenance,
            segmentKind: file.segmentKind,
            ...file.inferredLabel ? {
                inferredLabel: file.inferredLabel
            } : {},
            orientation
        };
        out.push(root);
        if (documentation) {
            const starts = [];
            let offset = start, fence;
            for (const line of file.text.split(/(?<=\n)/u)){
                const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
                if (marker) {
                    if (!fence) fence = marker[1];
                    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
                } else if (!fence && /^#{1,6}\s+/.test(line)) starts.push({
                    offset,
                    name: line.replace(/[\r\n]+$/, '')
                });
                offset += Buffer.byteLength(line);
            }
            for(let i = 0; i < starts.length; i++){
                const a = starts[i].offset, b = starts[i + 1]?.offset ?? end;
                out.push({
                    ...root,
                    unitId: stableId(STRUCTURAL_VERSION, id, a, b),
                    parentId: id,
                    childIds: [],
                    kind: 'section',
                    symbolName: starts[i].name,
                    symbolPath: file.path + '::' + starts[i].name,
                    byteStart: a,
                    byteEnd: b,
                    startLine: lineAt(a),
                    endLine: lineAt(Math.max(a, b - 1)),
                    headerByteStart: a,
                    headerByteEnd: Math.min(b, a + Buffer.byteLength(starts[i].name)),
                    subTokens: splitIdentifierSubTokens(starts[i].name)
                });
            }
        } else {
            const tree = decomposeCodeSource(file.text, {
                originKey: file.path,
                grammarId: grammar.id,
                maxBlockBytes
            });
            const headers = tree.flatNodes.filter((n)=>isDefinitionNode(n, file.text)).map((n)=>({
                    byteStart: n.headerByteStart,
                    byteEnd: n.headerByteEnd
                }));
            const references = lexicalCodeReferences(file.text, tree.grammarId, headers);
            root.references = [
                ...new Set(references.map((ref)=>ref.name))
            ].sort();
            const ids = new Map(tree.flatNodes.map((n)=>[
                    n.nodeId,
                    n === tree.root ? id : stableId(STRUCTURAL_VERSION, id, n.nodeId)
                ]));
            for (const node of tree.flatNodes){
                if (node === tree.root) continue;
                const a = start + node.byteStart, b = start + node.byteEnd, body = bytes.subarray(a, b).toString('utf8');
                const refs = references.filter((ref)=>ref.byteStart >= node.byteStart && ref.byteStart < node.byteEnd).map((ref)=>ref.name);
                out.push({
                    ...root,
                    unitId: ids.get(node.nodeId),
                    parentId: ids.get(node.parentId) ?? id,
                    childIds: [],
                    kind: node.kind,
                    symbolName: node.symbolName,
                    symbolPath: node.symbolPath,
                    byteStart: a,
                    byteEnd: b,
                    startLine: lineAt(a),
                    endLine: lineAt(Math.max(a, b - 1)),
                    headerByteStart: start + (node.headerByteStart ?? node.byteStart),
                    headerByteEnd: start + (node.headerByteEnd ?? Math.min(node.byteEnd, node.byteStart + (Buffer.from(body).indexOf(10) + 1 || Buffer.byteLength(body)))),
                    subTokens: splitIdentifierSubTokens(node.symbolPath),
                    references: [
                        ...new Set(refs)
                    ].sort(),
                    ...node.partIndex !== undefined ? {
                        partIndex: node.partIndex,
                        totalParts: node.totalParts
                    } : {}
                });
            }
        }
    }
    const hasParts = new Set(out.filter((n)=>n.kind === 'part').map((n)=>n.parentId));
    for (const parent of [
        ...out
    ])if ([
        'block',
        'section',
        'file'
    ].includes(parent.kind) && parent.byteEnd - parent.byteStart > maxBlockBytes && !hasParts.has(parent.unitId)) {
        const ranges = [];
        let start = parent.byteStart;
        while(start < parent.byteEnd){
            let end = Math.min(parent.byteEnd, start + maxBlockBytes);
            while(end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80)end--;
            if (end === start) {
                end++;
                while(end < parent.byteEnd && (bytes[end] & 0xc0) === 0x80)end++;
            }
            ranges.push([
                start,
                end
            ]);
            start = end;
        }
        ranges.forEach(([a, b], i)=>out.push({
                ...parent,
                unitId: stableId(STRUCTURAL_VERSION, parent.unitId, 'part', i + 1),
                parentId: parent.unitId,
                childIds: [],
                kind: 'part',
                symbolName: parent.symbolName + '#part-' + (i + 1),
                byteStart: a,
                byteEnd: b,
                startLine: lineAt(a),
                endLine: lineAt(Math.max(a, b - 1)),
                partIndex: i + 1,
                totalParts: ranges.length,
                references: []
            }));
    }
    const byId = new Map(out.map((n)=>[
            n.unitId,
            n
        ]));
    for (const n of out)if (n.parentId) byId.get(n.parentId)?.childIds.push(n.unitId);
    for (const parent of out){
        const parts = parent.childIds.map((id)=>byId.get(id)).filter((n)=>n.kind === 'part').sort((a, b)=>a.byteStart - b.byteStart);
        parts.forEach((p, i)=>{
            p.partIndex = i + 1;
            p.totalParts = parts.length;
            if (i) p.previousPartId = parts[i - 1].unitId;
            if (i + 1 < parts.length) p.nextPartId = parts[i + 1].unitId;
            p.headerByteStart = parent.headerByteStart;
            p.headerByteEnd = parent.headerByteEnd;
        });
    }
    return out;
}


//# sourceURL=src/structure.ts