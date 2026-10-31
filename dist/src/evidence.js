import { getLanguageGrammar } from './code-decomposer.js';
import { ContextForgeStore, stableId, createStoreReadBudget } from './store.js';
import { analyzeRecallQuery, scoreFacetCoverage, resolveRetrievalWorkPolicy } from './retrieval.js';
import { estimateTokens } from './symbolic-ir.js';
import { structuralUnits, STRUCTURAL_BLOCK_BYTES, isOrientationDocument, boundedHeaderEnd } from './structure.js';
const DEFAULT_WINDOW_POLICY = {
    maxAnchors: 4,
    maxWindowBytes: 8192,
    maxSourceBytes: 12288
};
export function resolveEvidenceWindowPolicy(historyTokens, sourceCount, maxReadBytes = 64 * 1024 * 1024) {
    if (!Number.isFinite(historyTokens) || historyTokens < 0 || !Number.isSafeInteger(sourceCount) || sourceCount < 0 || !Number.isFinite(maxReadBytes) || maxReadBytes < 0) throw new RangeError('Invalid evidence window resources');
    const sources = Math.max(1, sourceCount), tokens = Math.max(512, historyTokens);
    const share = Math.floor(tokens * 3.6 * 0.85 / Math.sqrt(sources));
    const maxSourceBytes = Math.min(Math.floor(maxReadBytes / 2), Math.max(2048, Math.min(32768, share)));
    return {
        maxSourceBytes,
        maxWindowBytes: Math.min(maxSourceBytes, Math.max(2048, Math.floor(maxSourceBytes * 0.85))),
        maxAnchors: Math.max(2, Math.min(12, Math.floor(maxSourceBytes / 2048)))
    };
}
export function selectEvidenceAnchors(hits, recall, limit) {
    const pool = [
        ...hits
    ], selected = [], covered = new Set();
    while(pool.length && selected.length < limit){
        pool.sort((a, b)=>scoreFacetCoverage(recall, (b.title ?? '') + ' ' + (b.body ?? b.text ?? ''), covered).gain - scoreFacetCoverage(recall, (a.title ?? '') + ' ' + (a.body ?? a.text ?? ''), covered).gain || scoreFacetCoverage(recall, (b.title ?? '') + ' ' + (b.body ?? b.text ?? '')).score - scoreFacetCoverage(recall, (a.title ?? '') + ' ' + (a.body ?? a.text ?? '')).score);
        const hit = pool.shift();
        selected.push(hit);
        const text = (hit.title ?? '') + ' ' + (hit.body ?? hit.text ?? '');
        for (const facet of recall.facets)if (scoreFacetCoverage({
            ...recall,
            facets: [
                facet
            ]
        }, text).score >= 0.9) covered.add(facet.id);
    }
    return selected;
}
function evidenceWindowCharge(excerpts, policy) {
    const raw = Buffer.byteLength(renderExcerpts(excerpts));
    if (policy === DEFAULT_WINDOW_POLICY) return raw;
    let groups = 0, lastEnd = -1, lastArtifact = '';
    for (const e of [
        ...excerpts
    ].sort((a, b)=>a.artifactId.localeCompare(b.artifactId) || a.byteStart - b.byteStart || b.byteEnd - a.byteEnd)){
        if (e.artifactId !== lastArtifact || e.byteStart > lastEnd) {
            groups++;
            lastEnd = e.byteEnd;
            lastArtifact = e.artifactId;
        } else lastEnd = Math.max(lastEnd, e.byteEnd);
    }
    return raw + groups * 384 + 512;
}
function rangesCover(excerpts, start, end, artifactId) {
    let cursor = start;
    for (const e of [
        ...excerpts
    ].filter((e)=>e.artifactId === artifactId).sort((a, b)=>a.byteStart - b.byteStart)){
        if (e.byteStart > cursor) break;
        if (e.byteEnd > cursor) cursor = e.byteEnd;
        if (cursor >= end) return true;
    }
    return cursor >= end;
}
function mergeEvidenceMetadata(target, extra) {
    bind(target, [
        ...target.excerpts ?? [],
        ...extra.excerpts ?? []
    ]);
    target.supportGroupIds = [
        ...new Set([
            ...target.supportGroupIds,
            ...extra.supportGroupIds
        ])
    ];
    target.supportRequirements = {
        ...target.supportRequirements,
        ...extra.supportRequirements
    };
    target.reasons = [
        ...new Set([
            ...target.reasons,
            ...extra.reasons
        ])
    ];
    target.matchedFacetIds = [
        ...new Set([
            ...target.matchedFacetIds,
            ...extra.matchedFacetIds
        ])
    ];
    target.derivedNodeIds = [
        ...new Set([
            ...target.derivedNodeIds ?? [],
            ...extra.derivedNodeIds ?? []
        ])
    ];
    target.claimSignatures = [
        ...new Set([
            ...target.claimSignatures ?? [],
            ...extra.claimSignatures ?? []
        ])
    ];
    if (extra.derivedText && !target.derivedText?.includes(extra.derivedText)) target.derivedText = [
        target.derivedText,
        extra.derivedText
    ].filter(Boolean).join('\n');
    target.trace = {
        ...target.trace,
        ...extra.trace,
        documentStructuralRoute: !!(target.trace.documentStructuralRoute || extra.trace.documentStructuralRoute),
        semanticInterpretation: !!(target.trace.semanticInterpretation || extra.trace.semanticInterpretation),
        structuralUnits: uniqueStructuralTrace([
            ...target.trace.structuralUnits ?? [],
            ...extra.trace.structuralUnits ?? []
        ])
    };
    target.utility = Math.max(target.utility, extra.utility);
}
export function renderExcerpts(excerpts) {
    const sorted = [
        ...excerpts
    ].sort((a, b)=>a.artifactId.localeCompare(b.artifactId) || a.byteStart - b.byteStart || b.byteEnd - a.byteEnd);
    let text = '', prev;
    for (const c of sorted){
        if (prev && c.artifactId === prev.artifactId && c.byteEnd <= prev.byteEnd) continue;
        const overlap = prev && c.artifactId === prev.artifactId ? Math.max(0, prev.byteEnd - c.byteStart) : 0;
        const part = Buffer.from(c.text).subarray(overlap).toString('utf8');
        text += (prev && !(c.artifactId === prev.artifactId && c.byteStart <= prev.byteEnd) ? '\n[noncontiguous excerpt]\n' : '') + part;
        prev = c;
    }
    return text;
}
export function renderAttributedEvidence(store, c, recall, namespaceId = store.namespaceId) {
    const units = c.trace?.structuralUnits ?? [];
    if (!units.length || !c.excerpts?.length) return c.text;
    const groups = [];
    for (const e of [
        ...c.excerpts
    ].sort((a, b)=>a.artifactId.localeCompare(b.artifactId) || a.byteStart - b.byteStart || b.byteEnd - a.byteEnd)){
        const last = groups.at(-1), end = last ? Math.max(...last.map((x)=>x.byteEnd)) : -1;
        if (last && last[0].artifactId === e.artifactId && e.byteStart <= end) last.push(e);
        else groups.push([
            e
        ]);
    }
    const rendered = groups.map((group)=>{
        const start = Math.min(...group.map((e)=>e.byteStart)), end = Math.max(...group.map((e)=>e.byteEnd)), text = renderExcerpts(group);
        const overlapping = units.filter((u)=>(!u.artifactId || u.artifactId === group[0].artifactId) && (u.byteStart < end && u.byteEnd > start || u.headerByteStart <= start && u.headerByteEnd >= end));
        const unit = overlapping.filter((u)=>u.byteStart <= start && u.byteEnd >= end || u.headerByteStart <= start && u.headerByteEnd >= end).sort((a, b)=>a.byteEnd - a.byteStart - (b.byteEnd - b.byteStart))[0];
        const paths = [
            ...new Set(overlapping.filter((u)=>u.pathVerified).map((u)=>String(u.originKey)))
        ];
        const symbol = unit?.symbolPath;
        const name = [
            ...symbol ? [
                symbol
            ] : [],
            ...paths.filter((path)=>!symbol?.includes(path))
        ].join(' | ') || store.getSource(c.sourceId)?.originKey || c.sourceId;
        const label = `Evidence ${String(name).slice(0, 240)}; bytes ${start}-${end}${unit?.kind === 'part' ? `; part-${unit.partIndex} of ${unit.totalParts}` : ''}${unit?.headerComplete === false ? '; header incomplete' : ''}`;
        const citation = store.createEvidenceSpan(c.sourceId, group[0].artifactId, start, end, {
            namespaceId,
            maxBytes: end - start
        });
        if (!c.spanIds.includes(citation.spanId)) c.spanIds.push(citation.spanId);
        const spans = `[span:${store.formatShortSpanId(citation.spanId, namespaceId)}]`;
        return {
            start,
            text: `${label} ${spans}\n<source_quote>\n${text}\n</source_quote>`,
            quality: scoreFacetCoverage(recall, text + ' ' + (unit?.symbolPath ?? '')).score
        };
    });
    if (!/\b(history|historical|previous|prior|changed?|compare|comparison|before|timeline|chronolog\w*)\b/i.test(recall.original)) rendered.sort((a, b)=>a.quality - b.quality || a.start - b.start);
    return rendered.map((g)=>g.text).join('\n\n');
}
export function remainingStructuralNavigation(c, quote) {
    if (c.trace?.semanticInterpretation) return c.derivedText;
    const lines = (c.derivedText ?? '').split('\n').filter((line)=>{
        const path = /^(?:Verified source path|Inferred source region): ([^;]+)/.exec(line)?.[1];
        const symbol = /; symbol ([^;]+)/.exec(line)?.[1];
        if (path || symbol) return !!(path && !quote.includes(path) || symbol && !quote.includes(symbol) || line.includes('partial structural evidence') && !quote.includes('partial structural evidence') || line.includes('header incomplete') && !quote.includes('header incomplete'));
        return /part-\d+ of \d+|header incomplete/.test(line) && !quote.includes(line);
    });
    return [
        ...new Set(lines)
    ].join('\n').slice(0, STRUCTURAL_NAVIGATION_CHARS) || undefined;
}
function bind(c, excerpts) {
    c.excerpts = [
        ...new Map(excerpts.map((e)=>[
                e.spanId,
                e
            ])).values()
    ];
    c.excerpts.sort((a, b)=>a.artifactId.localeCompare(b.artifactId) || a.byteStart - b.byteStart || a.byteEnd - b.byteEnd);
    c.text = renderExcerpts(c.excerpts);
    c.spanIds = c.excerpts.map((e)=>e.spanId);
    c.artifactIds = [
        ...new Set(c.excerpts.map((e)=>e.artifactId))
    ];
    return c;
}
export const STRUCTURAL_NAVIGATION_CHARS = 2048;
export function uniqueStructuralTrace(units) {
    return [
        ...new Map(units.map((u)=>[
                `${u.artifactId ?? ''}:${u.byteStart}:${u.byteEnd}:${u.partIndex ?? 'whole'}`,
                u
            ])).values()
    ];
}
export function renderStructuralNavigation(units, excerpts = []) {
    const unique = uniqueStructuralTrace(units), lines = [], signatures = new Set();
    let chars = 0;
    const covers = (start, end)=>{
        let cursor = start;
        for (const e of [
            ...excerpts
        ].sort((a, b)=>a.byteStart - b.byteStart)){
            if (e.byteStart > cursor) break;
            if (e.byteEnd > cursor) cursor = e.byteEnd;
            if (cursor >= end) return true;
        }
        return cursor >= end;
    };
    for (const u of unique){
        if (!u.partIndex || u.parentByteStart !== undefined && covers(u.parentByteStart, u.parentByteEnd)) continue;
        const signatureKey = `${u.headerByteStart}:${u.headerByteEnd}`;
        const signature = signatures.has(signatureKey) ? '' : `; enclosing signature bytes ${signatureKey.replace(':', '-')}${u.headerComplete === false ? ' (header incomplete; continues to byte ' + u.fullHeaderByteEnd + ')' : ''}`;
        const label = String(u.symbolPath ?? u.unitId).slice(0, 256);
        const line = `${label}: part-${u.partIndex} of ${u.totalParts}; lines ${u.startLine}-${u.endLine}; previous=${u.previousPartId ?? 'none'}; next=${u.nextPartId ?? 'none'}${signature}`;
        if (chars + line.length + 1 > STRUCTURAL_NAVIGATION_CHARS) break;
        lines.push(line);
        chars += line.length + 1;
        signatures.add(signatureKey);
    }
    return lines.join('\n');
}
export function buildEvidenceWindow(store, sourceId, recall, spanIds = [], namespaceId = store.namespaceId, deadlineAt = Infinity, budget, windowPolicy = DEFAULT_WINDOW_POLICY) {
    const source = store.getSource(sourceId);
    if (!source || source.namespaceId !== namespaceId || source.status !== 'active') return null;
    let required;
    try {
        required = spanIds.map((id)=>store.readEvidenceSpan(id, {
                namespaceId,
                budget,
                deadlineAt
            })).filter((p)=>p.sourceId === sourceId);
    } catch  {
        return null;
    }
    const sourceBytes = Number(store.db.prepare('SELECT byte_length FROM blobs WHERE sha256=?').get(source.contentSha256)?.byte_length ?? 0);
    const cursorCode = !!recall.cursorContext && !!getLanguageGrammar(source.originKey) && getLanguageGrammar(source.originKey)?.id !== 'markdown';
    if ((sourceBytes > 64 * 1024 || cursorCode || windowPolicy.preferIndexedSeeds) && required.length) {
        const excerpts = [
            ...required
        ], trace = [];
        let incomplete = false;
        let fallbackUnits;
        let fallbackBytes;
        for (const anchor of required.slice(0, windowPolicy.maxAnchors)){
            const prefix = `wiki/structure/${sourceId}/`;
            const rows = store.db.prepare(`SELECT canonical_json FROM derived_nodes WHERE namespace_id=? AND status='active' AND logical_key>=? AND logical_key<? AND json_extract(canonical_json,'$.entries[0].structural.kind') IN ('block','part','section','file') AND json_extract(canonical_json,'$.entries[0].structural.byteStart')<=? AND json_extract(canonical_json,'$.entries[0].structural.byteEnd')>=? ORDER BY json_extract(canonical_json,'$.entries[0].structural.byteEnd')-json_extract(canonical_json,'$.entries[0].structural.byteStart') LIMIT 4`).all(namespaceId, prefix, prefix + '~', anchor.byteStart, anchor.byteEnd);
            if (!rows.length && getLanguageGrammar(source.originKey) && sourceBytes <= 256 * 1024 && Date.now() < deadlineAt) {
                if (!fallbackUnits) {
                    try {
                        const full = store.createEvidenceSpan(sourceId, anchor.artifactId, 0, sourceBytes, {
                            namespaceId,
                            budget,
                            deadlineAt
                        });
                        fallbackBytes = Buffer.from(full.text);
                        fallbackUnits = structuralUnits(full.text, source.originKey);
                    } catch  {
                        fallbackUnits = [];
                        incomplete = true;
                    }
                }
                const local = fallbackUnits.filter((u)=>[
                        'block',
                        'part'
                    ].includes(u.kind) && u.byteStart <= anchor.byteStart && u.byteEnd >= anchor.byteEnd).sort((a, b)=>a.byteEnd - a.byteStart - (b.byteEnd - b.byteStart))[0];
                if (local && fallbackBytes) {
                    const end = local.byteEnd - local.byteStart <= windowPolicy.maxWindowBytes ? local.byteEnd : Math.min(local.byteEnd, anchor.byteEnd);
                    const ranges = [
                        [
                            local.byteStart,
                            end
                        ]
                    ];
                    if (local.kind === 'part' && local.headerByteStart < local.byteStart) ranges.unshift([
                        local.headerByteStart,
                        boundedHeaderEnd(fallbackBytes, local.headerByteStart, local.headerByteEnd)
                    ]);
                    const support = [];
                    try {
                        for (const [a, b] of ranges)support.push(store.createEvidenceSpan(sourceId, anchor.artifactId, a, b, {
                            namespaceId,
                            budget,
                            deadlineAt
                        }));
                        const union = [
                            ...excerpts,
                            ...support
                        ];
                        if (Buffer.byteLength(renderExcerpts(union)) <= Math.max(windowPolicy.maxWindowBytes, Buffer.byteLength(renderExcerpts(required)))) {
                            excerpts.push(...support);
                            trace.push({
                                ...local,
                                artifactId: anchor.artifactId,
                                whole: end === local.byteEnd,
                                headerComplete: rangesCover(union, local.headerByteStart, local.headerByteEnd, anchor.artifactId)
                            });
                        } else incomplete = true;
                    } catch  {
                        incomplete = true;
                    }
                }
            }
            for (const row of rows){
                const entry = JSON.parse(String(row.canonical_json)).entries?.[0], u = entry?.structural;
                if (!u) continue;
                if (excerpts.reduce((n, e)=>n + e.byteEnd - e.byteStart, 0) >= windowPolicy.maxWindowBytes) {
                    incomplete = true;
                    break;
                }
                try {
                    const support = (entry.spanIds ?? []).map((id)=>store.readEvidenceSpan(id, {
                            namespaceId,
                            budget,
                            deadlineAt
                        }));
                    const union = [
                        ...new Map([
                            ...excerpts,
                            ...support
                        ].map((e)=>[
                                e.spanId,
                                e
                            ])).values()
                    ];
                    const bound = Math.max(windowPolicy.maxWindowBytes, Buffer.byteLength(renderExcerpts(required)));
                    if (evidenceWindowCharge(union, windowPolicy) > bound) {
                        incomplete = true;
                        continue;
                    }
                    const covered = (start, end)=>{
                        let cursor = start;
                        for (const e of [
                            ...union
                        ].sort((a, b)=>a.byteStart - b.byteStart)){
                            if (e.artifactId !== anchor.artifactId) continue;
                            if (e.byteStart > cursor) break;
                            if (e.byteEnd > cursor) cursor = e.byteEnd;
                            if (cursor >= end) return true;
                        }
                        return cursor >= end;
                    };
                    const whole = covered(u.byteStart, u.byteEnd), headerComplete = covered(u.headerByteStart, u.headerByteEnd);
                    excerpts.push(...support);
                    trace.push({
                        ...u,
                        whole,
                        headerComplete,
                        fullHeaderByteEnd: u.headerByteEnd
                    });
                    incomplete ||= !whole || u.kind === 'part' || !headerComplete;
                    break;
                } catch  {
                    incomplete = true;
                    break;
                }
            }
        }
        const exact = [
            ...new Map(excerpts.map((e)=>[
                    e.spanId,
                    e
                ])).values()
        ];
        const text = renderExcerpts(exact), score = scoreFacetCoverage(recall, text);
        return bind({
            sourceId,
            text: '',
            spanIds: [],
            artifactIds: [],
            matchedFacetIds: score.matchedFacetIds,
            supportGroupIds: [],
            reasons: [
                'lexical_match'
            ],
            trace: {
                sourceRevision: source.originRevision,
                sourceStatus: source.status,
                trustClass: source.trustClass,
                structuralUnits: uniqueStructuralTrace(trace),
                indexedSeedHydration: true,
                ...incomplete ? {
                    truncated: true,
                    structuralIncomplete: true
                } : {}
            },
            utility: score.score,
            ...trace.length ? {
                derivedText: [
                    renderStructuralNavigation(trace, exact),
                    ...uniqueStructuralTrace(trace).map((u)=>`${u.pathVerified ? 'Verified source path' : 'Inferred source region'}: ${u.originKey}; symbol ${u.symbolPath}; original lines ${u.startLine}-${u.endLine}${!u.whole ? '; partial structural evidence' : ''}`)
                ].filter(Boolean).join('\n').slice(0, STRUCTURAL_NAVIGATION_CHARS)
            } : {}
        }, exact);
    }
    const chunks = store.getEvidenceChunks(sourceId, {
        namespaceId,
        deadlineAt,
        budget,
        maxInspected: Math.min(4096, budget ? budget.maxInspected - budget.inspected : 4096),
        maxBytes: 64 * 1024
    });
    if (!chunks.length && !required.length) return null;
    const full = chunks.map((c)=>c.text).join(''), small = estimateTokens(full) <= 2048;
    let chosen = chunks;
    if (!small) {
        const indexes = new Set([
            0,
            chunks.length - 1
        ]);
        const ranked = chunks.map((c, i)=>({
                i,
                s: scoreFacetCoverage(recall, c.text).gain + recall.facets.filter((f)=>f.origin === 'question' && (f.kind === 'identifier' || f.kind === 'number') && f.surface.length >= 2 && c.text.includes(f.surface)).length * 12 + (/\b(anomal\w*|exception|reject\w*|unchanged|only|no other|must not|never)\b/i.test(c.text) ? 3 : 0)
            })).sort((a, b)=>b.s - a.s || a.i - b.i);
        if (isOrientationDocument(source.originKey) || /\.(?:py|pyw|ts|tsx|js|jsx|mjs|cjs|java|cs|go|rs|c|cc|cpp|h|hpp|sql|f90|cob|cbl|html|ejs)$/i.test(source.originKey)) {
            indexes.clear();
            for (const { i, s } of ranked.slice(0, 4))if (s > 0) indexes.add(i);
        } else {
            for (const { i, s } of ranked.slice(0, 3))if (s > 0) {
                for (const j of [
                    i
                ])if (j >= 0 && j < chunks.length) indexes.add(j);
            }
        }
        chosen = chunks.filter((_, i)=>indexes.has(i));
    }
    const excerpts = chosen.map((c)=>{
        if (Buffer.byteLength(c.text) <= 8192) return c;
        const bytes = Buffer.from(c.text), lower = c.text.toLowerCase();
        const term = recall.facets.flatMap((f)=>f.aliases).find((a)=>lower.includes(a));
        const at = term ? Buffer.byteLength(c.text.slice(0, lower.indexOf(term))) : 0;
        let start = Math.max(0, at - 2048), end = Math.min(bytes.length, start + 8192);
        while(start > 0 && (bytes[start] & 0xc0) === 0x80)start--;
        while(end < bytes.length && (bytes[end] & 0xc0) === 0x80)end++;
        return store.createEvidenceSpan(sourceId, c.artifactId, c.byteStart + start, c.byteStart + end, {
            namespaceId,
            budget,
            deadlineAt
        });
    });
    const structuralTrace = [];
    let structuralIncomplete = false;
    const complete = !chunks.truncated && chunks.length > 0 && chunks[0].byteStart === 0 && chunks.every((c, i)=>!i || c.artifactId === chunks[i - 1].artifactId && c.byteStart === chunks[i - 1].byteEnd);
    let selectedExcerpts = excerpts;
    if (complete && Date.now() < deadlineAt) {
        const fullBytes = Buffer.from(full), units = structuralUnits(full, source.originKey), byId = new Map(units.map((u)=>[
                u.unitId,
                u
            ]));
        const artifactId = chunks[0].artifactId;
        const anchors = [
            ...required.filter((p)=>p.artifactId === artifactId),
            ...chunks.map((c)=>({
                    ...c,
                    score: scoreFacetCoverage(recall, c.text).gain
                })).filter((c)=>c.score > 0).sort((a, b)=>b.score - a.score).slice(0, 8)
        ];
        const expanded = [];
        let used = 0;
        const addRanges = (ranges)=>{
            const pending = ranges.filter(([start, end], i)=>end > start && !expanded.some((e)=>e.byteStart <= start && e.byteEnd >= end) && !ranges.some(([a, b], j)=>j !== i && a <= start && b >= end && (a < start || b > end || j < i)));
            if (!pending.length) return 'covered';
            const size = pending.reduce((n, [a, b])=>n + b - a, 0);
            if (used + size > windowPolicy.maxWindowBytes || budget && (size > budget.maxBytes - budget.bytes || pending.length > budget.maxInspected - budget.inspected) || Date.now() >= deadlineAt) {
                structuralIncomplete = true;
                return 'rejected';
            }
            const staged = [];
            try {
                for (const [start, end] of pending)staged.push(store.createEvidenceSpan(sourceId, artifactId, start, end, {
                    namespaceId,
                    budget,
                    deadlineAt
                }));
            } catch  {
                structuralIncomplete = true;
                return 'rejected';
            }
            expanded.push(...staged);
            used += size;
            return 'admitted';
        };
        for (const anchor of anchors){
            const enclosing = units.filter((u)=>u.byteStart <= anchor.byteStart && u.byteEnd >= anchor.byteEnd && u.kind !== 'part' && u.kind !== 'statement').sort((a, b)=>a.byteEnd - a.byteStart - (b.byteEnd - b.byteStart));
            const symbols = enclosing.filter((u)=>u.kind === 'block' && !/^(?:if|else|for|while|switch|try|catch|finally|do|block|body|statement)(?:$|[-#\s])/.test(u.symbolName));
            const authority = symbols[0] ?? enclosing[0];
            const whole = authority && authority.byteEnd - authority.byteStart <= STRUCTURAL_BLOCK_BYTES ? authority : undefined;
            if (whole) {
                if (addRanges([
                    [
                        whole.byteStart,
                        whole.byteEnd
                    ]
                ]) === 'admitted') structuralTrace.push({
                    artifactId,
                    unitId: whole.unitId,
                    symbolPath: whole.symbolPath,
                    whole: true,
                    byteStart: whole.byteStart,
                    byteEnd: whole.byteEnd,
                    startLine: whole.startLine,
                    endLine: whole.endLine
                });
                continue;
            }
            const part = units.filter((u)=>u.kind === 'part' && (!authority || u.parentId === authority.unitId) && u.byteStart <= anchor.byteStart && u.byteEnd > anchor.byteStart).sort((a, b)=>a.byteEnd - a.byteStart - (b.byteEnd - b.byteStart))[0];
            if (part) {
                const parent = byId.get(part.parentId);
                const headerStart = parent?.headerByteStart ?? part.headerByteStart, originalHeaderEnd = parent?.headerByteEnd ?? part.headerByteEnd;
                const headerEnd = boundedHeaderEnd(fullBytes, headerStart, originalHeaderEnd);
                if (addRanges([
                    [
                        part.byteStart,
                        part.byteEnd
                    ],
                    [
                        headerStart,
                        headerEnd
                    ]
                ]) === 'admitted') structuralTrace.push({
                    artifactId,
                    unitId: part.unitId,
                    symbolPath: parent?.symbolPath ?? part.symbolPath,
                    parentByteStart: parent?.byteStart,
                    parentByteEnd: parent?.byteEnd,
                    partIndex: part.partIndex,
                    totalParts: part.totalParts,
                    previousPartId: part.previousPartId ?? null,
                    nextPartId: part.nextPartId ?? null,
                    headerByteStart: headerStart,
                    headerByteEnd: headerEnd,
                    headerComplete: headerEnd === originalHeaderEnd,
                    fullHeaderByteEnd: originalHeaderEnd,
                    byteStart: part.byteStart,
                    byteEnd: part.byteEnd,
                    startLine: part.startLine,
                    endLine: part.endLine
                });
            }
        }
        if (expanded.length) selectedExcerpts = expanded;
    }
    const score = scoreFacetCoverage(recall, full + ' ' + required.map((p)=>p.text).join(' '));
    const delivered = [
        ...selectedExcerpts,
        ...required
    ];
    const uniqueTrace = uniqueStructuralTrace(structuralTrace);
    const navigation = renderStructuralNavigation(uniqueTrace, delivered);
    return bind({
        sourceId,
        text: '',
        spanIds: [],
        artifactIds: [],
        matchedFacetIds: score.matchedFacetIds,
        supportGroupIds: [],
        reasons: [
            'lexical_match'
        ],
        trace: {
            sourceRevision: source.originRevision,
            sourceStatus: source.status,
            trustClass: source.trustClass,
            ...uniqueTrace.length ? {
                structuralUnits: uniqueTrace
            } : {},
            ...chunks.truncated || structuralIncomplete ? {
                truncated: true,
                structuralIncomplete
            } : {}
        },
        utility: score.score,
        ...navigation ? {
            derivedText: navigation
        } : {}
    }, delivered);
}
function claimSignatures(recall, text) {
    return text.split(/(?<=[.!?])\s+|\n/u).filter((t)=>{
        const s = scoreFacetCoverage(recall, t);
        return s.anchored && s.score > 0 || /\b(except|unless|only|not|never|unchanged|reject|contradict|must|cannot|if|without)\b/i.test(t);
    }).map((t)=>{
        const normalized = t.normalize('NFKC').trim().replace(/\s+/g, ' ');
        const claim = /^(?:Fact|State|Decision|Correction):\s*([^|]+)\|\s*([^=]+)=\s*(.+)$/i.exec(normalized);
        if (claim) return JSON.stringify(claim.slice(1).map((s)=>s.trim()));
        try {
            const v = JSON.parse(normalized);
            if (v.type === 'fact') return JSON.stringify([
                v.entity,
                v.predicate,
                v.object,
                v.polarity ?? 1
            ]);
        } catch  {}
        return normalized;
    }).sort();
}
const historical = (q)=>/\b(history|historical|previous|prior|old|changed?|changes|compare|comparison|diff|versus|vs|before|original|initial|supersed\w*|release\s+1|v1)\b/i.test(q.original);
export function hydrateProvenanceSupport(store, nodeId, recall, namespaceId = store.namespaceId, windowCache, deadlineAt = Infinity, budget, windowPolicy = DEFAULT_WINDOW_POLICY) {
    const spanCache = new Map();
    const readSupport = (id)=>{
        let p = spanCache.get(id);
        if (!p) {
            p = store.readEvidenceSpan(id, {
                namespaceId,
                budget,
                deadlineAt
            });
            spanCache.set(id, p);
        }
        return p;
    };
    const row = store.db.prepare("SELECT * FROM derived_nodes WHERE node_id=? AND namespace_id=? AND status<>'withdrawn'").get(nodeId, namespaceId);
    if (!row) return [];
    const canonical = JSON.parse(String(row.canonical_json)), provenance = store.getProvenance(nodeId);
    if (row.status === 'superseded' && !historical(recall)) return [];
    const entries = Array.isArray(canonical.entries) ? canonical.entries : [];
    const matched = entries.filter((e)=>{
        const s = scoreFacetCoverage(recall, String(e.text) + ' ' + (e.structural?.symbolPath ?? '') + ' ' + (e.structural?.subTokens ?? []).join(' '));
        return s.score > 0 && s.anchored;
    }).sort((a, b)=>scoreFacetCoverage(recall, String(b.text)).gain - scoreFacetCoverage(recall, String(a.text)).gain || String(a.entryId).localeCompare(String(b.entryId)));
    if (entries.length && !matched.length) return [];
    const allowed = new Set(provenance.map((p)=>p.spanId)), result = [];
    const perSource = new Map();
    let truncated = false;
    const units = entries.length ? matched : [
        {
            spanIds: provenance.map((p)=>p.spanId),
            text: row.body
        }
    ];
    for (const entry of units){
        if (Date.now() >= deadlineAt) {
            truncated = true;
            break;
        }
        const selectedSpans = [
            ...new Set(entry.spanIds ?? [])
        ];
        if (selectedSpans.some((s)=>!allowed.has(s))) continue;
        const bySource = new Map();
        let reject = false;
        for (const id of selectedSpans){
            try {
                const p = readSupport(id);
                const spans = bySource.get(p.sourceId) ?? [];
                spans.push(id);
                bySource.set(p.sourceId, spans);
            } catch  {
                reject = true;
                truncated = true;
                break;
            }
        }
        if (reject) continue;
        if (entries.length) for (const [id, spans] of bySource){
            const used = perSource.get(id) ?? {
                count: 0,
                chars: 0
            };
            const chars = spans.reduce((n, s)=>n + readSupport(s).text.length, 0);
            if (used.count >= windowPolicy.maxAnchors || used.chars + chars > windowPolicy.maxWindowBytes && used.count > 0) {
                reject = true;
                truncated = true;
                break;
            }
        }
        if (reject) continue;
        const group = stableId('cf-support-group-v2', nodeId, [
            ...selectedSpans
        ].sort());
        for (const [sourceId, spans] of bySource){
            const structuralSeed = entry.structural ? spans : [];
            let base;
            const sourceGrammar = getLanguageGrammar(store.getSource(sourceId)?.originKey ?? '');
            const standaloneCode = !!sourceGrammar && sourceGrammar.id !== 'markdown';
            if (entry.structural && isDiscreteCodeUnit(entry.structural) && standaloneCode) {
                const required = spans.map((id)=>readSupport(id));
                const u = entry.structural;
                if (u.parentId) {
                    const parent = store.db.prepare("SELECT canonical_json FROM derived_nodes WHERE namespace_id=? AND status='active' AND logical_key=?").get(namespaceId, `wiki/structure/${sourceId}/${u.parentId}`);
                    const enclosing = parent ? JSON.parse(String(parent.canonical_json)).entries?.[0]?.structural : undefined;
                    if (enclosing?.kind === 'block' && enclosing.headerByteEnd > enclosing.headerByteStart && enclosing.headerByteEnd - enclosing.headerByteStart <= 4096 && !required.some((e)=>e.byteStart <= enclosing.headerByteStart && e.byteEnd >= enclosing.headerByteEnd)) {
                        try {
                            required.push(store.createEvidenceSpan(sourceId, required[0].artifactId, enclosing.headerByteStart, enclosing.headerByteEnd, {
                                namespaceId,
                                budget,
                                deadlineAt
                            }));
                        } catch  {
                            truncated = true;
                        }
                    }
                }
                const score = scoreFacetCoverage(recall, String(entry.text) + ' ' + u.symbolPath);
                base = bind({
                    sourceId,
                    text: '',
                    spanIds: [],
                    artifactIds: [],
                    matchedFacetIds: score.matchedFacetIds,
                    supportGroupIds: [],
                    reasons: [
                        'provenance_support'
                    ],
                    trace: {
                        sourceStatus: 'active',
                        structuralUnits: [
                            {
                                ...u,
                                whole: rangesCover(required, u.byteStart, u.byteEnd, required[0].artifactId),
                                headerComplete: rangesCover(required, u.headerByteStart, u.headerByteEnd, required[0].artifactId)
                            }
                        ],
                        coherentStructuralRoute: true
                    },
                    utility: score.score
                }, required);
                if (base.trace.structuralUnits.some((unit)=>!unit.whole || !unit.headerComplete)) base.trace = {
                    ...base.trace,
                    truncated: true,
                    structuralIncomplete: true
                };
            } else {
                if (windowCache && !windowCache.has(sourceId)) windowCache.set(sourceId, buildEvidenceWindow(store, sourceId, recall, structuralSeed, namespaceId, deadlineAt, budget, windowPolicy));
                base = windowCache?.get(sourceId) ?? buildEvidenceWindow(store, sourceId, recall, structuralSeed, namespaceId, deadlineAt, budget, windowPolicy);
                if (base && entry.structural && (!standaloneCode || isDocumentStructuralUnit(entry.structural))) {
                    base = {
                        ...base,
                        trace: {
                            ...base.trace,
                            documentStructuralRoute: true,
                            structuralUnits: uniqueStructuralTrace([
                                ...base.trace.structuralUnits ?? [],
                                entry.structural
                            ])
                        }
                    };
                }
            }
            if (!base) continue;
            const required = spans.map((id)=>readSupport(id));
            const alternateContext = required.flatMap((p)=>{
                if (base.artifactIds.includes(p.artifactId)) return [];
                const a = store.db.prepare('SELECT b.byte_length FROM artifacts a JOIN blobs b ON b.sha256=a.blob_sha256 WHERE a.artifact_id=?').get(p.artifactId);
                if (!a || Number(a.byte_length) > 4096) return [];
                try {
                    return [
                        store.createEvidenceSpan(sourceId, p.artifactId, 0, Number(a.byte_length), {
                            namespaceId,
                            budget,
                            deadlineAt
                        })
                    ];
                } catch  {
                    truncated = true;
                    return [];
                }
            });
            const c = bind({
                ...base,
                trace: {
                    ...base.trace
                },
                supportGroupIds: [
                    group
                ],
                reasons: [
                    'provenance_support'
                ],
                supportRequirements: {
                    [group]: selectedSpans
                },
                derivedNodeIds: [
                    nodeId
                ]
            }, [
                ...base.excerpts ?? [],
                ...required,
                ...alternateContext
            ]);
            if (Number(row.layer) === 1) {
                c.derivedText = `[${row.status}] revision ${row.revision}: ${row.body}`;
                c.trace.semanticInterpretation = true;
            }
            c.claimSignatures = claimSignatures(recall, String(entry.text));
            c.trace = {
                ...c.trace,
                extractiveRouting: Number(row.layer) === 2 && entry.textKind !== 'derived' && bySource.size === 1,
                seedNodeId: nodeId,
                nodeStatus: row.status,
                ...entry.entryId ? {
                    entryId: entry.entryId
                } : {}
            };
            result.push(c);
            const used = perSource.get(sourceId) ?? {
                count: 0,
                chars: 0
            };
            used.count++;
            used.chars += required.reduce((n, p)=>n + p.text.length, 0);
            perSource.set(sourceId, used);
        }
    }
    if (truncated) for (const c of result)c.trace = {
        ...c.trace,
        truncated: true
    };
    return result;
}
export function expandRelatedPremises(store, seedIds, recall, namespaceId = store.namespaceId, deadlineAt = Infinity, budget) {
    const related = store.getRelatedNodes(seedIds, {
        namespaceId,
        limit: 64,
        maxInspected: Math.min(256, budget ? budget.maxInspected - budget.inspected : 256),
        includeSuperseded: historical(recall),
        deadlineAt
    });
    if (budget) budget.inspected += related.inspected ?? related.length;
    const entryAllows = (r)=>{
        const seed = store.db.prepare('SELECT canonical_json,layer FROM derived_nodes WHERE node_id=? AND namespace_id=?').get(r.seedNodeId, namespaceId);
        if (!seed || seed.layer !== 2) return true;
        const entries = JSON.parse(String(seed.canonical_json)).entries;
        if (!Array.isArray(entries)) return scoreFacetCoverage(recall, r.node.title + ' ' + r.node.body).anchored;
        return entries.some((e)=>scoreFacetCoverage(recall, String(e.text)).anchored && scoreFacetCoverage(recall, String(e.text)).score > 0 && (e.dependencyNodeIds ?? []).includes(r.node.nodeId));
    };
    const result = related.filter((r)=>r.relation === 'shared_key' || entryAllows(r)).filter((r)=>r.direction === 'incoming' && [
            'compiles',
            'depends_on'
        ].includes(r.relation) || r.relation === 'contradicts' || r.relation === 'supersedes' && historical(recall) || scoreFacetCoverage(recall, r.node.title + ' ' + r.node.body).anchored && scoreFacetCoverage(recall, r.node.title + ' ' + r.node.body).score > 0);
    return Object.assign(result, {
        inspected: related.inspected ?? related.length,
        truncated: related.truncated ?? false
    });
}
export function triangulateMultiClueGraph(store, seedNodesByClue, recall, options = {}) {
    const ns = options.namespaceId ?? store.namespaceId;
    const maxHops = Math.max(1, Math.min(options.maxHops ?? 3, 4));
    const deadlineAt = options.deadlineAt ?? Infinity;
    const budget = options.budget;
    if (seedNodesByClue.size < 2 || Date.now() >= deadlineAt) return [];
    const reached = new Map();
    const originsByTarget = new Map();
    const seedSet = new Set();
    let frontier = new Map();
    for (const [clueId, nodeIds] of seedNodesByClue.entries()){
        for (const nid of nodeIds){
            seedSet.add(nid);
            let m = reached.get(nid);
            if (!m) {
                m = new Map();
                reached.set(nid, m);
            }
            m.set(clueId, 0);
            let o = originsByTarget.get(nid);
            if (!o) {
                o = new Map();
                originsByTarget.set(nid, o);
            }
            let cSet = o.get(clueId);
            if (!cSet) {
                cSet = new Set();
                o.set(clueId, cSet);
            }
            cSet.add(nid);
            let f = frontier.get(nid);
            if (!f) {
                f = new Set();
                frontier.set(nid, f);
            }
            f.add(clueId);
        }
    }
    for(let hop = 1; hop <= maxHops; hop++){
        if (Date.now() >= deadlineAt || frontier.size === 0) break;
        const currentIds = [
            ...frontier.keys()
        ].slice(0, 24);
        const rel = store.getRelatedNodes(currentIds, {
            namespaceId: ns,
            limit: 48,
            maxInspected: Math.min(128, budget ? budget.maxInspected - budget.inspected : 128),
            includeSuperseded: historical(recall),
            deadlineAt
        });
        if (budget) budget.inspected += rel.inspected ?? rel.length;
        const nextFrontier = new Map();
        for (const edge of rel){
            const targetId = edge.node.nodeId;
            const parentClues = frontier.get(edge.seedNodeId);
            const parentOrigins = originsByTarget.get(edge.seedNodeId);
            if (!parentClues || !parentOrigins) continue;
            let m = reached.get(targetId);
            if (!m) {
                m = new Map();
                reached.set(targetId, m);
            }
            let o = originsByTarget.get(targetId);
            if (!o) {
                o = new Map();
                originsByTarget.set(targetId, o);
            }
            for (const cId of parentClues){
                let cSet = o.get(cId);
                if (!cSet) {
                    cSet = new Set();
                    o.set(cId, cSet);
                }
                for (const sId of parentOrigins.get(cId) ?? [])cSet.add(sId);
                if (!m.has(cId)) {
                    m.set(cId, hop);
                    let nf = nextFrontier.get(targetId);
                    if (!nf) {
                        nf = new Set();
                        nextFrontier.set(targetId, nf);
                    }
                    nf.add(cId);
                }
            }
        }
        frontier = nextFrontier;
    }
    const bridges = [];
    for (const [nodeId, clueMap] of reached.entries()){
        if (seedSet.has(nodeId) || clueMap.size < 2) continue;
        const originMap = originsByTarget.get(nodeId);
        let hasDistinctOriginPair = false;
        const clueEntries = originMap ? [
            ...originMap.entries()
        ] : [];
        for(let i = 0; i < clueEntries.length && !hasDistinctOriginPair; i++){
            for(let j = i + 1; j < clueEntries.length && !hasDistinctOriginPair; j++){
                for (const s1 of clueEntries[i][1]){
                    for (const s2 of clueEntries[j][1]){
                        if (s1 !== s2) {
                            hasDistinctOriginPair = true;
                            break;
                        }
                    }
                    if (hasDistinctOriginPair) break;
                }
            }
        }
        if (!hasDistinctOriginPair) continue;
        let score = 0, minHop = Infinity;
        for (const h of clueMap.values()){
            if (h < minHop) minHop = h;
            score += Math.pow(0.65, h);
        }
        const triangulationScore = score * clueMap.size;
        bridges.push({
            nodeId,
            convergedClues: [
                ...clueMap.keys()
            ],
            minHop,
            triangulationScore
        });
    }
    return bridges.sort((a, b)=>b.triangulationScore - a.triangulationScore || a.minHop - b.minHop || a.nodeId.localeCompare(b.nodeId)).slice(0, 12);
}
export function buildTemporalStateLedger(store, candidateSourceIds, recall, namespaceId = store.namespaceId) {
    if (candidateSourceIds.length === 0) return [];
    const placeholders = candidateSourceIds.map(()=>'?').join(',');
    const rows = store.db.prepare(`
  SELECT DISTINCT n.logical_key
  FROM derived_nodes n
  JOIN provenance p USING(node_id)
  JOIN spans sp USING(span_id)
  WHERE n.namespace_id=? AND n.layer=1 AND n.status<>'withdrawn'
    AND sp.source_id IN (${placeholders})
 `).all(namespaceId, ...candidateSourceIds);
    const ledgers = [];
    for (const { logical_key } of rows){
        const chain = store.db.prepare(`
   SELECT node_id,revision,status,observed_at,title,body,canonical_json
   FROM derived_nodes
   WHERE namespace_id=? AND layer=1 AND logical_key=? AND status<>'withdrawn'
   ORDER BY observed_at ASC, revision ASC
  `).all(namespaceId, logical_key);
        if (chain.length < 2) continue;
        if (!historical(recall) && chain.length < 3) continue;
        const allSpans = [];
        const allSources = new Set();
        const steps = [];
        for (const item of chain){
            const prov = store.getProvenance(String(item.node_id));
            const spIds = prov.map((p)=>p.spanId);
            prov.forEach((p)=>allSources.add(p.sourceId));
            allSpans.push(...spIds);
            const shortTag = spIds[0] ? `[span:${store.formatShortSpanId(spIds[0], namespaceId)} / ${spIds[0]}]` : '';
            steps.push(`  ${item.revision}. [t=${item.observed_at}, status=${item.status}] ${String(item.body).trim()} ${shortTag}`.trimEnd());
        }
        const entity = (()=>{
            try {
                return JSON.parse(String(chain[0].canonical_json)).entity ?? logical_key;
            } catch  {
                return logical_key;
            }
        })();
        ledgers.push({
            logicalKey: logical_key,
            entity: String(entity),
            ledgerText: `Chronological State Evolution Ledger (${entity}, ${chain.length} ordered revisions):\n${steps.join('\n')}`,
            spanIds: [
                ...new Set(allSpans)
            ],
            sourceIds: [
                ...allSources
            ]
        });
    }
    return ledgers;
}
export function isDocumentStructuralUnit(unit) {
    if (unit?.kind === 'section') return true;
    const grammar = getLanguageGrammar(String(unit?.originKey ?? ''));
    return !isDiscreteCodeUnit(unit) && (!grammar || grammar.id === 'markdown') && !/^code: .+ \((?:python|typescript)\)$/.test(String(unit?.inferredLabel ?? ''));
}
export function isDiscreteCodeUnit(unit) {
    if (unit?.kind === 'block') return true;
    if (unit?.kind !== 'part' || unit.symbolPath === unit.originKey) return false;
    const grammar = getLanguageGrammar(String(unit.originKey ?? ''));
    return !!grammar && grammar.id !== 'markdown' || /^code: .+ \((?:python|typescript)\)$/.test(String(unit.inferredLabel ?? ''));
}
export function selectCoherentEvidence(candidates, recall, windowPolicy = DEFAULT_WINDOW_POLICY) {
    const byRange = new Map();
    for (const c of candidates){
        const key = c.excerpts?.map((e)=>`${e.artifactId}:${e.byteStart}:${e.byteEnd}`).sort().join('|') ?? c.spanIds.join('|');
        const old = byRange.get(key);
        if (old) mergeEvidenceMetadata(old, c);
        else byRange.set(key, {
            ...c
        });
    }
    const unique = [
        ...byRange.values()
    ];
    const quality = (c)=>scoreFacetCoverage(recall, c.text + ' ' + (c.trace?.structuralUnits ?? []).map((u)=>u.symbolPath).join(' ')).score;
    unique.sort((a, b)=>quality(b) - quality(a) || a.text.length - b.text.length || a.spanIds.join().localeCompare(b.spanIds.join()));
    if (!unique.length) return [];
    const selected = [], covered = new Set();
    let bytes = 0;
    const top = quality(unique[0]);
    const comparative = /\b(compare|contrast|difference|differences|history|historical)\b/i.test(recall.original);
    for (const c of unique){
        const coverage = scoreFacetCoverage(recall, c.text + ' ' + (c.trace?.structuralUnits ?? []).map((u)=>u.symbolPath).join(' '), covered);
        const exactNew = recall.facets.some((f)=>f.origin === 'question' && (f.kind === 'identifier' || f.kind === 'entity') && !covered.has(f.id) && coverage.matchedFacetIds.includes(f.id) && c.text.includes(f.surface));
        const essential = c.reasons.includes('contradiction') || c.reasons.includes('dependency');
        const discrete = (c.trace?.structuralUnits ?? []).some(isDiscreteCodeUnit) && !(c.trace?.structuralUnits ?? []).some((u)=>u.kind === 'section') && !c.trace?.documentStructuralRoute;
        const ranges = selected.flatMap((x)=>x.excerpts ?? []);
        const covering = selected.find((x)=>(c.excerpts ?? []).every((e)=>(x.excerpts ?? []).some((r)=>r.artifactId === e.artifactId && r.byteStart <= e.byteStart && r.byteEnd >= e.byteEnd)));
        if (covering) {
            mergeEvidenceMetadata(covering, c);
            continue;
        }
        if (discrete && selected.length && !comparative && !essential && quality(c) < top / 2 && !exactNew) continue;
        if (discrete && selected.length >= 2 && !comparative && !essential && coverage.gain <= 0) continue;
        const next = evidenceWindowCharge([
            ...selected.flatMap((x)=>x.excerpts ?? []),
            ...c.excerpts ?? []
        ], windowPolicy);
        if (next > windowPolicy.maxSourceBytes && selected.length) continue;
        selected.push(c);
        bytes = next;
        coverage.matchedFacetIds.forEach((id)=>covered.add(id));
    }
    return selected;
}
export function focusCursorEvidence(candidates, recall) {
    const primary = recall.cursorContext?.primaryIdentifiers ?? [];
    if (!primary.length) return candidates;
    const exact = (text, id)=>new RegExp('(?:^|[^A-Za-z0-9_$])' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^A-Za-z0-9_$])').test(text);
    const definition = (c)=>primary.some((id)=>(c.trace.structuralUnits ?? []).some((u)=>u.symbolName === id || String(u.symbolPath).endsWith('::' + id)));
    if (!candidates.some(definition)) return candidates;
    const strongest = Math.max(...candidates.filter(definition).map((c)=>c.utility));
    return candidates.filter((c)=>{
        const linked = c.reasons.some((r)=>r === 'dependency' || r === 'contradiction') || c.trace.semanticInterpretation || Object.values(c.supportRequirements ?? {}).some((ids)=>ids.some((id)=>!c.spanIds.includes(id)));
        const hit = primary.some((id)=>exact(c.text, id));
        if (linked || definition(c) || hit || c.utility >= strongest / 2) return true;
        return false;
    });
}
export function discoverEvidenceCandidates(store, query, namespaceId = store.namespaceId, deadlineAt = Infinity, resources = {}) {
    const recall = analyzeRecallQuery(query);
    if (!recall.substantiveTerms.length) return {
        candidates: [],
        work: {
            seeds: 0,
            chunks: 0,
            neighbors: 0
        },
        truncated: false
    };
    const corpusBytes = Number(store.db.prepare("SELECT coalesce(sum(b.byte_length),0) bytes FROM sources s JOIN source_lifecycle l USING(source_id) JOIN blobs b ON b.sha256=s.content_sha256 WHERE s.namespace_id=? AND l.status='active'").get(namespaceId).bytes);
    const policy = resolveRetrievalWorkPolicy({
        ...resources,
        corpusBytes
    });
    const activeSourceCount = Number(store.db.prepare("SELECT count(*) n FROM sources s JOIN source_lifecycle l USING(source_id) WHERE s.namespace_id=? AND l.status='active'").get(namespaceId).n);
    const windowPolicy = resolveEvidenceWindowPolicy(resources.historyTokens ?? 9500, activeSourceCount, policy.maxBytes);
    const budget = createStoreReadBudget({
        maxInspected: policy.hydrationRows,
        maxBytes: Math.floor(policy.maxBytes / 2),
        deadlineAt
    });
    const lane = ()=>createStoreReadBudget({
            maxInspected: policy.discoveryRows,
            maxBytes: Math.floor(policy.maxBytes / 8),
            deadlineAt
        });
    const rawBudget = lane(), factBudget = lane(), wikiBudget = lane(), facetBudget = lane();
    const raw = store.search(query, {
        namespaceId,
        layers: [
            0
        ],
        limit: 128,
        deadlineAt,
        budget: rawBudget
    });
    let inspectedChunks = raw.inspected ?? raw.length, statisticsInspected = raw.statisticsInspected ?? 0, continuationTruncated = false;
    const covered = new Set(raw.filter((h)=>scoreFacetCoverage(recall, h.title + ' ' + h.body).anchored).flatMap((h)=>scoreFacetCoverage(recall, h.title + ' ' + h.body).matchedFacetIds));
    let facetQueries = 0;
    for (const facet of recall.facets){
        if (facet.origin !== 'question' || covered.has(facet.id)) continue;
        if (Date.now() >= deadlineAt || facetQueries >= 8) {
            continuationTruncated = true;
            break;
        }
        facetQueries++;
        const anchor = recall.facets.find((f)=>f.origin === 'question' && (f.kind === 'identifier' || f.kind === 'entity') && f.id !== facet.id);
        const extra = store.search(facet.surface, {
            namespaceId,
            layers: [
                0
            ],
            limit: 128,
            maxInspected: 128,
            deadlineAt,
            budget: facetBudget,
            ...anchor ? {
                requiredTerms: [
                    anchor.aliases[0]
                ]
            } : {}
        });
        inspectedChunks += extra.inspected ?? extra.length;
        statisticsInspected += extra.statisticsInspected ?? 0;
        continuationTruncated ||= extra.truncated ?? false;
        for (const h of extra)if (scoreFacetCoverage(recall, h.title + ' ' + h.body).anchored && !raw.some((r)=>r.chunkId === h.chunkId)) {
            raw.push(h);
            scoreFacetCoverage(recall, h.title + ' ' + h.body).matchedFacetIds.forEach((f)=>covered.add(f));
        }
    }
    const facts = store.search(query, {
        namespaceId,
        layers: [
            1
        ],
        limit: 32,
        deadlineAt,
        budget: factBudget
    });
    const wiki = store.search(query, {
        namespaceId,
        layers: [
            2
        ],
        limit: 64,
        deadlineAt,
        budget: wikiBudget
    });
    const nodes = Object.assign([
        ...facts,
        ...wiki
    ], {
        inspected: facts.inspected + wiki.inspected,
        truncated: facts.truncated || wiki.truncated
    });
    const out = new Map(), windowCache = new Map();
    const structuralPool = [], extractivePool = [];
    const collect = (c)=>{
        if (c.trace?.coherentStructuralRoute) structuralPool.push(c);
        else if (c.trace?.extractiveRouting) extractivePool.push(c);
        else merge(c);
    };
    const merge = (c)=>{
        const prev = out.get(c.sourceId);
        if (prev && c.trace?.seedNodeId) {
            const union = [
                ...new Map([
                    ...prev.excerpts ?? [],
                    ...c.excerpts ?? []
                ].map((e)=>[
                        e.spanId,
                        e
                    ])).values()
            ];
            if (evidenceWindowCharge(union, windowPolicy) > windowPolicy.maxSourceBytes) {
                prev.trace = {
                    ...prev.trace,
                    truncated: true
                };
                return;
            }
        }
        if (!prev) out.set(c.sourceId, c);
        else {
            prev.derivedNodeIds = [
                ...new Set([
                    ...prev.derivedNodeIds ?? [],
                    ...c.derivedNodeIds ?? []
                ])
            ];
            prev.claimSignatures = [
                ...new Set([
                    ...prev.claimSignatures ?? [],
                    ...c.claimSignatures ?? []
                ])
            ];
            bind(prev, [
                ...prev.excerpts ?? [],
                ...c.excerpts ?? []
            ]);
            if (c.derivedText && !prev.derivedText?.includes(c.derivedText)) {
                const combined = (prev.derivedText ? prev.derivedText + '\n' : '') + c.derivedText;
                if (c.trace?.indexedSeedHydration) {
                    if (combined.length <= STRUCTURAL_NAVIGATION_CHARS) prev.derivedText = combined;
                } else prev.derivedText = combined;
            }
            prev.reasons = [
                ...new Set([
                    ...prev.reasons,
                    ...c.reasons
                ])
            ];
            prev.utility = Math.max(prev.utility, c.utility);
            prev.trace = {
                ...prev.trace,
                ...c.trace,
                documentStructuralRoute: !!(prev.trace.documentStructuralRoute || c.trace.documentStructuralRoute),
                semanticInterpretation: !!(prev.trace.semanticInterpretation || c.trace.semanticInterpretation),
                structuralUnits: uniqueStructuralTrace([
                    ...prev.trace.structuralUnits ?? [],
                    ...c.trace.structuralUnits ?? []
                ])
            };
            prev.supportRequirements = {
                ...prev.supportRequirements,
                ...c.supportRequirements
            };
            prev.supportGroupIds = [
                ...new Set([
                    ...prev.supportGroupIds,
                    ...c.supportGroupIds
                ])
            ];
            prev.matchedFacetIds = [
                ...new Set([
                    ...prev.matchedFacetIds,
                    ...c.matchedFacetIds
                ])
            ];
        }
    };
    for (const hit of raw){
        if (Date.now() >= deadlineAt) break;
        if (!hit.sourceId || !scoreFacetCoverage(recall, hit.title + ' ' + hit.body).anchored) continue;
        if (!windowCache.has(hit.sourceId)) windowCache.set(hit.sourceId, buildEvidenceWindow(store, hit.sourceId, recall, selectEvidenceAnchors(raw.filter((h)=>h.sourceId === hit.sourceId && h.spanId), recall, windowPolicy.maxAnchors).map((h)=>h.spanId), namespaceId, deadlineAt, budget, windowPolicy));
        const c = windowCache.get(hit.sourceId);
        if (c && scoreFacetCoverage(recall, c.text).anchored && c.utility > 0) merge({
            ...c,
            trace: {
                ...c.trace
            }
        });
    }
    const eligible = nodes.filter((h)=>!h.logicalKey?.startsWith('wiki/timeline/') && h.title !== 'record' && scoreFacetCoverage(recall, h.title + ' ' + h.body).anchored && scoreFacetCoverage(recall, h.title + ' ' + h.body).score > 0);
    const seeds = [], seedFacets = new Set(), remaining = [
        ...eligible
    ];
    while(remaining.length && seeds.length < 16){
        remaining.sort((a, b)=>scoreFacetCoverage(recall, b.title + ' ' + b.body, seedFacets).gain - scoreFacetCoverage(recall, a.title + ' ' + a.body, seedFacets).gain || a.score - b.score || a.nodeId.localeCompare(b.nodeId));
        const h = remaining.shift();
        seeds.push(h);
        scoreFacetCoverage(recall, h.title + ' ' + h.body).matchedFacetIds.forEach((f)=>seedFacets.add(f));
    }
    for (const h of seeds){
        if (Date.now() >= deadlineAt) break;
        for (const c of hydrateProvenanceSupport(store, h.nodeId, recall, namespaceId, windowCache, deadlineAt, budget, windowPolicy))collect(c);
    }
    const related = expandRelatedPremises(store, seeds.map((h)=>h.nodeId), recall, namespaceId, deadlineAt, budget);
    for (const r of related){
        if (Date.now() >= deadlineAt) break;
        for (const c of hydrateProvenanceSupport(store, r.node.nodeId, recall, namespaceId, windowCache, deadlineAt, budget, windowPolicy)){
            c.reasons.push(r.relation === 'contradicts' ? 'contradiction' : 'dependency');
            c.trace = {
                ...c.trace,
                relation: r.relation,
                direction: r.direction
            };
            collect(c);
        }
    }
    const questionFacetIds = new Set(recall.facets.filter((f)=>f.origin === 'question').map((f)=>f.id));
    const seedNodesByClue = new Map();
    for (const h of seeds){
        const m = scoreFacetCoverage(recall, h.title + ' ' + h.body).matchedFacetIds.filter((id)=>questionFacetIds.has(id));
        for (const fId of m){
            const arr = seedNodesByClue.get(fId) ?? [];
            if (!arr.includes(h.nodeId)) arr.push(h.nodeId);
            seedNodesByClue.set(fId, arr);
        }
    }
    if (seedNodesByClue.size >= 2 && Date.now() < deadlineAt) {
        const bridges = triangulateMultiClueGraph(store, seedNodesByClue, recall, {
            namespaceId,
            maxHops: 3,
            deadlineAt,
            budget
        });
        for (const b of bridges){
            if (Date.now() >= deadlineAt) break;
            const row = store.db.prepare('SELECT title,body FROM derived_nodes WHERE node_id=? AND namespace_id=?').get(b.nodeId, namespaceId);
            if (!row || !scoreFacetCoverage(recall, `${row.title} ${row.body}`).anchored) continue;
            for (const c of hydrateProvenanceSupport(store, b.nodeId, recall, namespaceId, windowCache, deadlineAt, budget, windowPolicy)){
                c.reasons.push('triangulated_bridge');
                c.utility += b.triangulationScore;
                c.trace = {
                    ...c.trace,
                    triangulatedClues: b.convergedClues,
                    minHop: b.minHop,
                    triangulationScore: b.triangulationScore
                };
                collect(c);
            }
        }
    }
    const bySource = new Map();
    for (const c of structuralPool){
        const list = bySource.get(c.sourceId) ?? [];
        list.push(c);
        bySource.set(c.sourceId, list);
    }
    for (const [sourceId, pool] of bySource){
        const selected = selectCoherentEvidence(pool, recall, windowPolicy);
        const raw = out.get(sourceId);
        if (raw && getLanguageGrammar(store.getSource(sourceId)?.originKey ?? '') && !raw.supportGroupIds.length && !raw.trace?.documentStructuralRoute && selected.length && selected.every((c)=>!(c.trace?.structuralUnits ?? []).some((u)=>!isDiscreteCodeUnit(u)))) {
            const covered = new Set(selected.flatMap((c)=>c.matchedFacetIds));
            const residual = (raw.excerpts ?? []).filter((e)=>scoreFacetCoverage(recall, e.text, covered).gain > 0);
            if (!residual.length) out.delete(sourceId);
            else {
                bind(raw, residual);
                const score = scoreFacetCoverage(recall, raw.text);
                raw.utility = score.score;
                raw.matchedFacetIds = score.matchedFacetIds;
            }
        }
        for (const c of selected)merge(c);
    }
    for (const c of extractivePool){
        const current = out.get(c.sourceId);
        const hasCoherent = current?.trace?.coherentStructuralRoute && !current?.trace?.documentStructuralRoute;
        if (hasCoherent && !c.reasons.some((r)=>r === 'contradiction' || r === 'dependency') && !historical(recall) && !/\b(contrast)\b/i.test(recall.original)) {
            const seen = new Set(current.matchedFacetIds);
            if (!c.matchedFacetIds.some((id)=>!seen.has(id))) continue;
        }
        merge(c);
    }
    if (out.size > 0 && Date.now() < deadlineAt) {
        const ledgers = buildTemporalStateLedger(store, [
            ...out.keys()
        ], recall, namespaceId);
        for (const l of ledgers){
            for (const srcId of l.sourceIds){
                const cand = out.get(srcId);
                if (cand && !cand.derivedText?.includes(l.ledgerText)) {
                    cand.derivedText = (cand.derivedText ? cand.derivedText + '\n' : '') + l.ledgerText;
                    cand.trace.semanticInterpretation = true;
                }
            }
        }
    }
    for (const c of out.values())c.claimSignatures = claimSignatures(recall, c.text);
    const candidates = focusCursorEvidence([
        ...out.values()
    ], recall).sort((a, b)=>b.utility - a.utility || a.sourceId.localeCompare(b.sourceId));
    const groupClaims = new Map();
    for (const c of candidates)for (const g of c.supportGroupIds){
        const set = groupClaims.get(g) ?? new Set();
        set.add(JSON.stringify(claimSignatures(recall, c.text)));
        groupClaims.set(g, set);
    }
    const redundantSourceIds = [];
    const seen = new Set();
    const unique = candidates.filter((c)=>{
        const signature = JSON.stringify(claimSignatures(recall, c.text));
        const key = signature === '[]' ? c.text : signature;
        if (c.supportGroupIds.some((g)=>(groupClaims.get(g)?.size ?? 0) > 1)) return true;
        if (seen.has(key)) {
            redundantSourceIds.push(c.sourceId);
            return false;
        }
        seen.add(key);
        return true;
    });
    return {
        candidates: unique,
        redundantSourceIds,
        work: {
            seeds: seeds.length,
            chunks: inspectedChunks,
            nodes: nodes.inspected ?? nodes.length,
            statistics: statisticsInspected,
            inspectedTotal: budget.inspected + rawBudget.inspected + factBudget.inspected + wikiBudget.inspected + facetBudget.inspected,
            readBytes: budget.bytes + rawBudget.bytes + factBudget.bytes + wikiBudget.bytes + facetBudget.bytes,
            maxInspected: policy.maxInspected,
            maxReadBytes: policy.maxBytes,
            windowAnchors: windowPolicy.maxAnchors,
            windowBytes: windowPolicy.maxWindowBytes,
            sourceEvidenceBytes: windowPolicy.maxSourceBytes,
            hydrationReserved: policy.hydrationRows,
            l0Inspected: rawBudget.inspected,
            l1Inspected: factBudget.inspected,
            l2Inspected: wikiBudget.inspected,
            facetInspected: facetBudget.inspected,
            hydrationInspected: budget.inspected,
            facetQueries,
            neighbors: related.length,
            neighborsInspected: related.inspected,
            hydrated: out.size
        },
        truncated: budget.inspected >= budget.maxInspected || budget.bytes >= budget.maxBytes || raw.truncated || nodes.truncated || continuationTruncated || raw.length >= 128 || nodes.length === 64 || eligible.length > 16 || related.truncated || Date.now() >= deadlineAt || recall.truncated || unique.some((c)=>c.trace?.truncated)
    };
}


//# sourceURL=src/evidence.ts