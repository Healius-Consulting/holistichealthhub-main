export type BusinessReferenceOrder = {
  id: string | number;
  backendId?: string;
  orderNumber?: string;
  draftId?: string;
  payment: { status: string };
  redoContext?: {
    originalBackendId?: string;
    rootBackendId?: string;
    originalOrderNumber?: string;
    rootOrderNumber?: string;
    replacementSequence?: number;
  };
};

export function replacementSuffix(sequence: number) {
  let value = Math.max(1, Math.floor(sequence));
  let suffix = '';
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

function shortId(value: string | number) {
  return String(value).replaceAll('-', '').slice(0, 8).toUpperCase();
}

export function businessOrderReference(order: BusinessReferenceOrder) {
  if (order.draftId) return `Draft · ${shortId(order.draftId)}`;
  if (order.payment.status === 'none') return 'Draft';
  const fallback = order.backendId ? shortId(order.backendId) : shortId(order.id);
  if (!order.redoContext) return `#${order.orderNumber ?? fallback}`;
  const root = order.redoContext.rootOrderNumber
    ?? order.redoContext.originalOrderNumber
    ?? (order.redoContext.rootBackendId ? shortId(order.redoContext.rootBackendId) : undefined)
    ?? (order.redoContext.originalBackendId ? shortId(order.redoContext.originalBackendId) : undefined)
    ?? fallback;
  return `#${root}${replacementSuffix(order.redoContext.replacementSequence ?? 1)}`;
}
