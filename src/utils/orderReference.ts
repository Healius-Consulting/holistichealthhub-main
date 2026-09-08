export type BusinessReferenceOrder = {
  id: string | number;
  backendId?: string;
  organisationId?: string;
  prescriptions?: Array<{ customerReference?: string }>;
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

/** Same stable tenant prefix used when placing prescriptions with Curaleaf. */
export function pharmacyReferencePrefix(organisationId: string) {
  const tenant = organisationId.trim().toUpperCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < tenant.length; index += 1) {
    hash ^= tenant.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % (36 ** 3)).toString(36).toUpperCase().padStart(3, '0');
}

export function prescriptionReference(order: BusinessReferenceOrder, index: number) {
  const supplied = order.prescriptions?.[index]?.customerReference?.trim();
  if (supplied && /^[A-Z0-9]{3}-[A-Z0-9]+-(?:P|r)[1-9][0-9]*$/i.test(supplied)) return supplied;
  const base = businessOrderReference(order).replace(/^#/, '');
  return base === 'Draft' ? `Draft P${index + 1}` : `${base}-P${index + 1}`;
}

export function businessOrderReference(order: BusinessReferenceOrder) {
  if (order.draftId) return 'Draft';
  if (order.payment.status === 'none') return 'Draft';
  const supplied = order.prescriptions?.map(rx => rx.customerReference?.trim())
    .find(ref => ref && /^[A-Z0-9]{3}-[A-Z0-9]+-(?:P|r)[1-9][0-9]*$/i.test(ref));
  if (supplied) return `#${supplied.replace(/-(?:P|r)[1-9][0-9]*$/i, '')}`;
  if (order.organisationId?.trim()) {
    const token = String(order.orderNumber || order.backendId || order.id).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-10);
    return `#${pharmacyReferencePrefix(order.organisationId)}-${token}`;
  }
  const fallback = order.backendId ? shortId(order.backendId) : shortId(order.id);
  if (!order.redoContext) return `#${order.orderNumber ?? fallback}`;
  const root = order.redoContext.rootOrderNumber
    ?? order.redoContext.originalOrderNumber
    ?? (order.redoContext.rootBackendId ? shortId(order.redoContext.rootBackendId) : undefined)
    ?? (order.redoContext.originalBackendId ? shortId(order.redoContext.originalBackendId) : undefined)
    ?? fallback;
  return `#${root}${replacementSuffix(order.redoContext.replacementSequence ?? 1)}`;
}
