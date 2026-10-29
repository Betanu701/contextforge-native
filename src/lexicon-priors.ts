// Deterministic identifier helpers. No dictionary, corpus exclusions, or database side effects.
/**
 * Split any identifier (`ContrastiveEmbed`, `convert_ldm_vae_checkpoint`, `Http404`, `start_port`)
 * into lowercase atomic sub-tokens (`['contrastive', 'embed']`, `['convert', 'ldm', 'vae', 'checkpoint']`,
 * `['http', '404']`, `['start', 'port']`).
 */
export function splitIdentifierSubTokens(identifier: string): string[] {
  const camelExpanded = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d+)/g, '$1 $2')
    .replace(/(\d+)([a-zA-Z])/g, '$1 $2');
  const parts = camelExpanded.split(/[^a-zA-Z0-9]+/).map(p => p.toLowerCase()).filter(p => p.length >= 2);
  return [...new Set(parts)];
}

/**
 * Determine if a surface token has structural code/technical formatting
 * (`snake_case`, `camelCase`, `PascalCase` mid-sentence, digits, or dotted path)
 * versus a plain lowercase/TitleCase English prose word.
 */
export function hasTechnicalIdentifierFormatting(token: string): boolean {
  if (!token || token.length < 2) return false;
  if (/[_.\d/$]/.test(token)) return true;
  // CamelCase or ALLCAPS (length >= 2)
  if (/[a-z][A-Z]/.test(token) || /^[A-Z]{2,}[a-z0-9]*$/.test(token) || /^[A-Z][a-z0-9]+[A-Z]/.test(token)) {
    return true;
  }
  return false;
}
