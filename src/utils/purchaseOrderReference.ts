export function purchaseOrderReference(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const reference = candidate.trim();
    if (reference) return reference;
  }
  return null;
}
