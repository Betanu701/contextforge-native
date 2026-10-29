export function splitIdentifierSubTokens(identifier) {
    const camelExpanded = identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-zA-Z])(\d+)/g, '$1 $2').replace(/(\d+)([a-zA-Z])/g, '$1 $2');
    const parts = camelExpanded.split(/[^a-zA-Z0-9]+/).map((p)=>p.toLowerCase()).filter((p)=>p.length >= 2);
    return [
        ...new Set(parts)
    ];
}
export function hasTechnicalIdentifierFormatting(token) {
    if (!token || token.length < 2) return false;
    if (/[_.\d/$]/.test(token)) return true;
    if (/[a-z][A-Z]/.test(token) || /^[A-Z]{2,}[a-z0-9]*$/.test(token) || /^[A-Z][a-z0-9]+[A-Z]/.test(token)) {
        return true;
    }
    return false;
}


//# sourceURL=src/lexicon-priors.ts