export function compactOrderReferenceToken(orderNumber: string | null | undefined, orderId: string): string {
  return String(orderNumber || orderId).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-10);
}

export function compactCustomerReferenceBelongsToOrder(
  reference: string | null | undefined,
  orderNumber: string | null | undefined,
  orderId: string,
): boolean {
  const ref = String(reference || '').trim();
  const token = compactOrderReferenceToken(orderNumber, orderId);
  return Boolean(token && new RegExp(`^[A-Z0-9]{3}-${token}(?:(?:-P|-r)[1-9][0-9]*)?$`, 'i').test(ref));
}
