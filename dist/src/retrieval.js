import { createHash } from 'node:crypto';
export const LEXICAL_VERSION = 'lexical-facets-v2';
export const ALIAS_MARKER = '\n[cf-lexical-facets-v2] ';
const stop = new Set(`a an is it of to in on not return object fields field answer give please json preserving the for with and or but as at by from into about what when where which who whom whose why how that this these those are was were been being have has had does did do will would shall should can could may might must need turn turns audit compare analyze analyse explain concisely sentences sentence short reply specifically earlier session stored facts based many current according only use null hello hi hey thanks thank you ok okay got continue conversation tell me its their our your my be than then after before during across all every exact case punctuation character include identify distinguish apply subtract synthesize review read summarize list provide determine find tell`.split(' '));
const generic = new Set([
    'sample',
    'fault_code',
    'correction',
    'keeper',
    'launch_date',
    'status',
    'fields',
    'unit'
]);
const norm = (s)=>s.normalize('NFKC').toLowerCase();
const runs = (s)=>s.match(/[\p{L}\p{N}]+(?:[_.-][\p{L}\p{N}]+)*/gu) ?? [];
export function tokenizeRecallText(text) {
    const out = new Set();
    for (const raw of runs(text)){
        const full = norm(raw);
        out.add(full);
        if (/^\d+\.\d+$/.test(full)) continue;
        const camel = raw.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
        const parts = camel.split(/[_.\-\s]+/u).map(norm);
        if (parts.length > 1) {
            out.add(parts.join(''));
            out.add(parts.join(' '));
        }
        for (const p of parts){
            out.add(p);
            for (const q of p.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u))out.add(q);
        }
        for(let i = 0; i < parts.length; i++)for(let n = 2; n <= Math.min(3, parts.length - i); n++)out.add(parts.slice(i, i + n).join(' '));
    }
    return [
        ...out
    ];
}
export function isTrivialPhatic(query) {
    if (query.includes('?')) return false;
    const s = norm(query).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return !s || /^(?:(?:hello|hi|hey|thanks|thank you|ok|okay|got it|continue conversation)[\s]*)+$/.test(s);
}
export function analyzeRecallQuery(query, limit = 256) {
    const split = /\bReturn\s+the\s+answer\s+object\s+with\s+fields\s*:/i.exec(query);
    const question = split ? query.slice(0, split.index) : query, schema = split ? query.slice(split.index + split[0].length) : '';
    const phatic = isTrivialPhatic(query), facets = [];
    for (const [text, origin] of [
        [
            question,
            'question'
        ],
        [
            schema,
            'output_schema'
        ]
    ])for (const surface of runs(text)){
        const full = norm(surface);
        if (stop.has(full)) continue;
        const aliases = tokenizeRecallText(surface).filter((a)=>!stop.has(a));
        if (!aliases.length) continue;
        const kind = /^\d+(?:\.\d+)?$/.test(full) ? 'number' : /[\d_-]/.test(surface) ? 'identifier' : surface.length === 1 && surface === 'm' ? 'unit' : /^\p{Lu}/u.test(surface) ? 'entity' : origin === 'output_schema' ? 'field' : 'content';
        const id = createHash('sha256').update(origin + '\0' + full).digest('hex').slice(0, 20);
        if (!facets.some((f)=>f.id === id)) facets.push({
            id,
            surface,
            aliases,
            kind,
            weight: origin === 'output_schema' ? 0.2 : kind === 'identifier' || kind === 'entity' ? 3 : 1,
            origin
        });
    }
    const substantive = phatic ? [] : facets.filter((f)=>f.origin === 'question');
    const prioritized = [
        ...facets
    ].sort((a, b)=>b.weight - a.weight || a.id.localeCompare(b.id));
    return {
        original: query,
        querySha256: createHash('sha256').update(query).digest('hex'),
        phatic,
        substantiveTerms: [
            ...new Set(substantive.map((f)=>norm(f.surface)))
        ],
        exactIdentifiers: substantive.filter((f)=>f.kind === 'identifier').map((f)=>f.surface),
        facets: prioritized.slice(0, limit),
        outputFieldHints: runs(schema),
        explicitReferenceHints: query.match(/\b[a-f0-9]{64}\b/g) ?? [],
        truncated: facets.length > limit || new Set(prioritized.slice(0, limit).flatMap((f)=>f.aliases)).size > 256
    };
}
export function buildFtsQuery(query, limit = 256) {
    const recall = typeof query === 'string' ? analyzeRecallQuery(query) : query;
    const aliases = [
        ...new Set(recall.facets.flatMap((f)=>f.aliases).filter((a)=>!stop.has(a) && a.length > 0))
    ];
    if (aliases.length > limit) recall.truncated = true;
    return aliases.slice(0, limit).map((a)=>'"' + a.replaceAll('"', '""') + '"').join(' OR ');
}
export function lexicalProjectionTitle(title, body) {
    return title + ALIAS_MARKER + tokenizeRecallText(title + ' ' + body).filter((a)=>!stop.has(a)).join(' ');
}
export function canonicalRecallTitle(title) {
    return title.split(ALIAS_MARKER)[0];
}
const coverageCache = new WeakMap();
const tokenCache = new Map();
export function scoreFacetCoverage(query, text, covered = []) {
    const q = typeof query === 'string' ? analyzeRecallQuery(query) : query, seen = new Set(covered);
    let cache = coverageCache.get(q);
    if (!cache) {
        cache = new Map();
        coverageCache.set(q, cache);
    }
    if (!seen.size && cache.has(text)) return cache.get(text);
    let tokens = tokenCache.get(text);
    if (!tokens) {
        tokens = new Set(tokenizeRecallText(text));
        if (tokenCache.size >= 512) tokenCache.clear();
        tokenCache.set(text, tokens);
    }
    const strong = q.facets.filter((f)=>f.origin === 'question' && (f.kind === 'entity' || f.kind === 'identifier') && !generic.has(norm(f.surface)));
    const originalRuns = new Set(runs(text));
    const compactTokens = new Set([
        ...tokens
    ].map((t)=>t.replace(/[_.\-\s]/g, '')));
    const matchMemo = new Map();
    const computeMatch = (f)=>q.exactIdentifiers.includes(f.surface) && originalRuns.has(f.surface) ? 1 : tokens.has(norm(f.surface)) ? 0.9 : f.kind === 'identifier' && compactTokens.has(norm(f.surface).replace(/[_.\-\s]/g, '')) ? 0.9 : f.aliases.some((a)=>a.length > 1 && !stop.has(a) && tokens.has(a)) ? 0.4 : 0;
    const match = (f)=>{
        if (!matchMemo.has(f.id)) matchMemo.set(f.id, computeMatch(f));
        return matchMemo.get(f.id);
    };
    const entities = strong.filter((f)=>f.kind === 'entity' && f.surface.length > 1);
    const anchored = entities.length ? entities.some((f)=>match(f) >= 0.9) : !strong.length || strong.some((f)=>match(f) >= 0.9) || q.facets.filter((f)=>f.origin === 'question' && f.kind === 'content' && match(f) >= 0.9 && !generic.has(norm(f.surface))).length >= 2;
    const matched = q.facets.filter((f)=>match(f) > 0 && (anchored || f.origin === 'question' && !generic.has(norm(f.surface))));
    const marginal = matched.filter((f)=>!seen.has(f.id));
    const result = {
        score: matched.reduce((n, f)=>n + f.weight * match(f), 0) / Math.max(1, q.facets.reduce((n, f)=>n + f.weight, 0)),
        matchedFacetIds: matched.map((f)=>f.id),
        marginalFacetIds: marginal.map((f)=>f.id),
        gain: marginal.reduce((n, f)=>n + f.weight * match(f), 0),
        anchored
    };
    if (!seen.size) cache.set(text, result);
    return result;
}


//# sourceURL=src/retrieval.ts