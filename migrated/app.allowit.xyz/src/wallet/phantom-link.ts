/** Phones have no Phantom extension. iPadOS reports a desktop Safari user agent, so touch points identify it. */
export function isMobileBrowser(userAgent: string, touchPoints: number): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
}

/** Phantom's universal link that opens this exact page in the Phantom app's browser, where the wallet can sign. */
export function phantomBrowseUrl(href: string, origin: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}
