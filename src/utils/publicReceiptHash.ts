const RECEIPT_HASH_PATTERN = /^[a-f0-9]{64}$/i;

/** Returns the 64-char receipt hash when the path is `/receipt/:hash`, otherwise null. */
export function parsePublicReceiptHash(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  const match = path.match(/^\/receipt\/([a-fA-F0-9]+)$/);
  if (!match) return null;
  const hash = match[1];
  return RECEIPT_HASH_PATTERN.test(hash) ? hash.toLowerCase() : null;
}
