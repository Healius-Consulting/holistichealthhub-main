export function asSnapshotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function snapshotRxList(snapshot: unknown): Array<Record<string, unknown>> {
  const prescriptions = asSnapshotRecord(snapshot).prescriptions;
  if (!Array.isArray(prescriptions)) return [];
  return prescriptions.filter(rx => rx && typeof rx === 'object') as Array<Record<string, unknown>>;
}

export function snapshotRxKey(rx: Record<string, unknown> | undefined, index: number): string {
  const id = String(rx?.id ?? '').trim();
  if (id) return id;
  const fileId = String(rx?.fileId ?? '').trim();
  if (fileId) return fileId;
  return `rx-${index}`;
}

export function compactOrderReferenceToken(orderNumber: string | null | undefined, orderId: string): string {
  const source = String(orderNumber || orderId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return source.slice(-10);
}

export function pharmacyReferencePrefix(organisationId: string): string {
  const tenant = organisationId.trim().toUpperCase();
  if (!tenant) throw new Error('Cannot generate a Curaleaf reference without a pharmacy organisation ID');

  // FNV-1a keeps the prefix stable without exposing the tenant identifier to Curaleaf.
  let hash = 0x811c9dc5;
  for (let index = 0; index < tenant.length; index += 1) {
    hash ^= tenant.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % (36 ** 3)).toString(36).toUpperCase().padStart(3, '0');
}

export function customerReferenceForRx(
  orderNumber: string | null | undefined,
  orderId: string,
  index: number,
  organisationId: string,
): string {
  const base = `${pharmacyReferencePrefix(organisationId)}-${compactOrderReferenceToken(orderNumber, orderId)}`;
  return `${base}-P${index + 1}`;
}

export function curaleafSubOrders(snapshot: unknown): Record<string, Record<string, unknown>> {
  const raw = asSnapshotRecord(snapshot).curaleafSubOrders;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) next[key] = value as Record<string, unknown>;
  }
  return next;
}

export function rxHasPurchaseOrder(snapshot: unknown, rxKey: string): boolean {
  const sub = curaleafSubOrders(snapshot)[rxKey];
  const id = String(sub?.purchaseOrderId || sub?.id || '').trim();
  return Boolean(id);
}

export function allSnapshotRxsHavePurchaseOrders(snapshot: unknown): boolean {
  const list = snapshotRxList(snapshot);
  if (!list.length) return false;
  return list.every((rx, index) => rxHasPurchaseOrder(snapshot, snapshotRxKey(rx, index)));
}

export function pendingPlacementRxIndexes(snapshot: unknown): number[] {
  return snapshotRxList(snapshot).flatMap((rx, index) => (
    rxHasPurchaseOrder(snapshot, snapshotRxKey(rx, index)) ? [] : [index]
  ));
}

export function curaleafPlacementTargets(
  snapshot: unknown,
  orderNumber: string | null | undefined,
  orderId: string,
  organisationId: string,
) {
  const prescriptions = snapshotRxList(snapshot);
  return pendingPlacementRxIndexes(snapshot).map(rxIndex => ({
    rxIndex,
    rxKey: snapshotRxKey(prescriptions[rxIndex], rxIndex),
    customerReference: customerReferenceForRx(orderNumber, orderId, rxIndex, organisationId),
    prescription: prescriptions[rxIndex]!,
  }));
}

type PackIdSource = {
  packId?: unknown;
  productId?: unknown;
};

export function packIdFromRecord(row: PackIdSource | null | undefined): string {
  if (!row) return '';
  return String(row.packId || row.productId || '').trim();
}

export function packIdsForRx(rx: Record<string, unknown>): string[] {
  const items = Array.isArray(rx.items) ? rx.items : [];
  return items
    .map(item => packIdFromRecord(item && typeof item === 'object' ? item as PackIdSource : undefined))
    .filter(Boolean);
}

export function filterRecordsByPackIds<T extends PackIdSource>(rows: T[], packIds: Iterable<string>): T[] {
  const allowed = packIds instanceof Set ? packIds : new Set(Array.from(packIds));
  if (!allowed.size) return [];
  return rows.filter(row => allowed.has(packIdFromRecord(row)));
}
