/**
 * The published Partner Terms, for the public /partner-terms page and the Terms step
 * of sign-up. Until HHH publishes them the API answers 404: the page says they are
 * coming and the sign-up step keeps its placeholder.
 */
export type PartnerTermsLoad =
  | { state: 'loading' }
  | { state: 'published'; version: string; paragraphs: string[] }
  | { state: 'unpublished' }
  | { state: 'failed' };

/** Blank lines split paragraphs; a single line break stays inside its paragraph. */
export function partnerTermsParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map(paragraph => paragraph.split('\n').map(line => line.trimEnd()).join('\n').trim())
    .filter(Boolean);
}

/** A response with no text reads as not published, so nobody is shown empty Terms. */
export function partnerTermsFromResponse(response: { version?: unknown; text?: unknown } | null | undefined): PartnerTermsLoad {
  const text = typeof response?.text === 'string' ? response.text : '';
  const paragraphs = partnerTermsParagraphs(text);
  if (!paragraphs.length) return { state: 'unpublished' };
  const version = typeof response?.version === 'string' ? response.version.trim() : '';
  return { state: 'published', version, paragraphs };
}
