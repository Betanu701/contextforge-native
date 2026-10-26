const PERSONA_HEADING_PATTERNS = [
    /soul\.md/i,
    /who you are/i,
    /core truths/i,
    /\bvibe\b/i,
    /boundaries/i,
    /\bcontinuity\b/i,
    /identity\.md/i,
    /persona/i
];
const DROPPED_BOILERPLATE_PATTERNS = [
    /available_skills/i,
    /deferred tool schemas/i,
    /bootstrap context notice/i,
    /example placeholders/i
];
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(Buffer.byteLength(text, "utf8") / 3.6);
}
export function splitPromptSections(raw) {
    const lines = raw.split(/\r?\n/);
    const sections = [];
    let currentHeading = "__preamble__";
    let currentLines = [];
    for (const line of lines){
        if (/^#{1,3}\s+/.test(line)) {
            if (currentLines.length > 0) {
                sections.push({
                    heading: currentHeading,
                    body: currentLines.join("\n").trim()
                });
            }
            currentHeading = line.trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }
    if (currentLines.length > 0) {
        sections.push({
            heading: currentHeading,
            body: currentLines.join("\n").trim()
        });
    }
    return sections;
}
export function compileProseBlockToSymbolicIr(heading, body) {
    const cleanHeading = heading.replace(/^#+\s*/, "").replace(/\/home\/node\/\.openclaw\/workspace\//g, "").trim();
    const stripped = body.replace(/<!--[\s\S]*?-->/g, "").replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[avatar_uri]").replace(/```[\s\S]*?```/g, "").trim();
    if (!stripped) return [];
    const rules = [];
    const rawLines = stripped.split(/\r?\n/).map((l)=>l.trim()).filter((l)=>l.length > 0 && !l.startsWith("_") && !l.startsWith("---"));
    for (const line of rawLines){
        const bullet = line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim();
        if (!bullet || bullet.length < 6) continue;
        const compressed = compressSentenceToSymbolic(bullet);
        if (compressed) {
            rules.push(compressed);
        }
    }
    if (rules.length === 0) return [];
    const sectionTag = cleanHeading.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "core";
    return [
        `#${sectionTag}:`,
        ...rules.map((r)=>`  ${r}`)
    ];
}
export function compressSentenceToSymbolic(sentence) {
    let s = sentence.replace(/\*\*/g, "").replace(/\bYou must always\b/gi, "@always:").replace(/\bAlways\b/g, "@always:").replace(/\bYou must never\b/gi, "@never:").replace(/\bNever\b/g, "@never:").replace(/\bDo not\b/gi, "!").replace(/\bDon't\b/gi, "!").replace(/\bPrefer\b/g, "@prefer:").replace(/\bBefore\s+([^,.:]+),\s*/gi, "pre($1) => ").replace(/\bWhen\s+([^,.:]+),\s*/gi, "when($1) => ").replace(/\bIf\s+([^,.:]+),\s*/gi, "if($1) => ").replace(/\bunless\s+/gi, "unless: ").replace(/\bbecause\s+/gi, "<- ").replace(/\binstead of\s+/gi, "!=").replace(/\bin order to\s+/gi, "-> ").replace(/\bfor example\b/gi, "e.g.").replace(/\bsuch as\b/gi, ":").replace(/\b(a|an|the|that|which|please|simply|actually|generally)\b\s*/gi, "").replace(/\s+/g, " ").trim();
    if (s.endsWith(".")) {
        s = s.slice(0, -1);
    }
    return s;
}
export function extractPersonaAndSoulProse(sections) {
    const personaParts = [];
    let inSoulBlock = false;
    for (const sec of sections){
        const h = sec.heading;
        if (/SOUL\.md/i.test(h)) {
            inSoulBlock = true;
        } else if (/^##\s+\//.test(h) && !/SOUL\.md/i.test(h)) {
            inSoulBlock = false;
        } else if (/^#{1,2}\s+(USER|MEMORY|IDENTITY|AGENTS|Directives|Tooling|Execution Bias|Red Lines)/i.test(h)) {
            inSoulBlock = false;
        }
        const isPersonaSection = inSoulBlock || PERSONA_HEADING_PATTERNS.some((pat)=>pat.test(h));
        if (isPersonaSection && !/IDENTITY\.md/i.test(h)) {
            const cleanBody = sec.body.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "").trim();
            if (cleanBody) {
                personaParts.push(`${sec.heading}\n${cleanBody}`);
            }
        }
    }
    return personaParts.join("\n\n").trim();
}
export function compileDualChannelSystemPrompt(input) {
    const originalChars = input.rawSystemPrompt.length;
    const estimatedOriginalTokens = estimateTokens(input.rawSystemPrompt);
    const useSymbolic = input.symbolicIr !== false;
    const tz = input.timezone ?? "America/New_York";
    const sections = splitPromptSections(input.rawSystemPrompt);
    const personaProse = input.soulProseOverride?.trim() || extractPersonaAndSoulProse(sections) || "Be genuinely helpful, candid, warm, and resourceful. State conclusions clearly with evidence.";
    if (!useSymbolic) {
        const permanentText = (input.permanentContextBlocks ?? []).map((b)=>`### ${b.title}\n${b.content}`).join("\n\n");
        const fallbackPrompt = [
            "# Assistant Persona & Soul",
            personaProse,
            permanentText ? `# Permanent Domain Context\n${permanentText}` : "",
            `# Runtime Context\nTimezone: ${tz}`
        ].filter(Boolean).join("\n\n");
        const compiledChars = fallbackPrompt.length;
        const estimatedCompiledTokens = estimateTokens(fallbackPrompt);
        return {
            compiledSystemPrompt: fallbackPrompt,
            mode: "prose-passthrough",
            originalChars,
            compiledChars,
            estimatedOriginalTokens,
            estimatedCompiledTokens,
            reductionRatio: originalChars > 0 ? Number((1 - compiledChars / originalChars).toFixed(4)) : 0,
            preservedPersonaChars: personaProse.length,
            symbolicRulesCount: 0
        };
    }
    const symbolicLines = [
        `@env(tz="${tz}", tool_discovery="tool_search->tool_call", memory_authority="L0_source_backed")`,
        `@exec_bias: act_now -> verify_with_tools -> report_evidence_or_blocker; !fabricate_citations`,
        `@care: pre(edit: crontab|systemd|nginx|rc|config) => inspect() -> merge_preserve(); !replace_all(unless: explicit_ask)`,
        `@safety: !exfiltrate_private_data; prefer(trash > rm); ask_before(external_send|destructive_op)`
    ];
    let symbolicRulesCount = 4;
    for (const sec of sections){
        if (PERSONA_HEADING_PATTERNS.some((p)=>p.test(sec.heading)) || DROPPED_BOILERPLATE_PATTERNS.some((p)=>p.test(sec.heading) || p.test(sec.body.slice(0, 120)))) {
            continue;
        }
        if (/Tooling|Execution Bias|Promised Work|Care|Red Lines|Directives/i.test(sec.heading)) {
            const compiledSec = compileProseBlockToSymbolicIr(sec.heading, sec.body);
            if (compiledSec.length > 1) {
                const bounded = compiledSec.slice(0, 14);
                symbolicLines.push(...bounded);
                symbolicRulesCount += bounded.length - 1;
            }
        }
    }
    const prosePermanentBlocks = [];
    for (const block of input.permanentContextBlocks ?? []){
        if (block.compileToSymbolic) {
            const ir = compileProseBlockToSymbolicIr(block.title, block.content);
            if (ir.length > 0) {
                symbolicLines.push(...ir);
                symbolicRulesCount += ir.length - 1;
            }
        } else {
            prosePermanentBlocks.push(`### ${block.title}\n${block.content.trim()}`);
        }
    }
    const compiledSystemPrompt = [
        "<!-- openclaw:attempt:STABLE -->",
        "# Persona & Soul (Natural Conversational Voice)",
        "Maintain this exact interpersonal persona, warmth, candor, and natural conversational voice in all replies:",
        "",
        personaProse,
        "",
        "# Operational Directives (Symbolic IR)",
        "Execute the following computer-native operational rules internally. Never echo symbolic syntax in user-facing replies—always converse with the user in natural, warm prose:",
        "<compiled_rules_ir>",
        symbolicLines.join("\n"),
        "</compiled_rules_ir>",
        prosePermanentBlocks.length > 0 ? `\n# Scoped Permanent Context (L3)\n${prosePermanentBlocks.join("\n\n")}` : "",
        "<!-- /openclaw:attempt:STABLE -->"
    ].filter(Boolean).join("\n");
    const compiledChars = compiledSystemPrompt.length;
    const estimatedCompiledTokens = estimateTokens(compiledSystemPrompt);
    return {
        compiledSystemPrompt,
        mode: "dual-channel-symbolic",
        originalChars,
        compiledChars,
        estimatedOriginalTokens,
        estimatedCompiledTokens,
        reductionRatio: originalChars > 0 ? Number((1 - compiledChars / originalChars).toFixed(4)) : 0,
        preservedPersonaChars: personaProse.length,
        symbolicRulesCount
    };
}


//# sourceURL=src/symbolic-ir.ts