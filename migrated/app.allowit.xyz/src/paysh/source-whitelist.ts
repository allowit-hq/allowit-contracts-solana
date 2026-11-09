/** The exact service/recipient pairs the backend compiler writes between its source markers. */
export interface SourceWhitelistEntry {id: string; recipient: string}

export function sourceWhitelist(code: string): SourceWhitelistEntry[] {
  const markerStart = '// AllowIt service whitelist: start';
  const markerEnd = '// AllowIt service whitelist: end';
  const start = code.indexOf(markerStart), end = code.indexOf(markerEnd);
  if (start < 0 || end < start || code.indexOf(markerStart, start + markerStart.length) !== -1 || code.indexOf(markerEnd, end + markerEnd.length) !== -1) return [];
  const block = code.slice(start, end);
  return [...block.matchAll(/is_one_of\(&ctx\.merchant, &\["([^"]+)"\]\)\?\s*\{\s*allowit::require_recipient\(&ctx\.recipient, "([^"]+)"\)/g)]
    .map(match => ({id: match[1], recipient: match[2]}));
}
