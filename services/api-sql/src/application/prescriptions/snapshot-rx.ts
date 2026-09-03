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
  return prescriptionCorrelationKeys(rx)[0] ?? `rx-${index}`;
}

/** Keys that can identify one snapshot prescription, in lookup order. */
export function prescriptionCorrelationKeys(rx: Record<string, unknown> | undefined): string[] {
  if (!rx) return [];
  const keys = [
    String(rx.clientKey ?? '').trim(),
    String(rx.id ?? '').trim(),
    String(rx.hhhPrescriptionId ?? '').trim(),
    String(rx.fileId ?? '').trim(),
  ].filter(Boolean);
  return [...new Set(keys)];
}

function compactKey(value: string) {
  return value.replaceAll('-', '').toLowerCase();
}

export function lookupKeyedRecord<T>(map: Record<string, T> | null | undefined, rx: Record<string, unknown> | undefined): T | undefined {
  if (!map) return undefined;
  for (const key of prescriptionCorrelationKeys(rx)) {
    if (map[key]) return map[key];
    const compact = compactKey(key);
    if (!compact) continue;
    for (const [existing, value] of Object.entries(map)) {
      if (compactKey(existing) === compact) return value;
    }
  }
  const curaleafId = String(rx?.curaleafPrescriptionId ?? '').trim();
  if (!curaleafId) return undefined;
  return Object.values(map).find(value => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    return String(record?.prescriptionId ?? '').trim() === curaleafId;
  });
}

/** Flow map aliases that cannot collide with a sibling's file attachment. */
export function prescriptionFlowAliasKeys(rx: Record<string, unknown> | undefined, index: number): string[] {
  const canonical = snapshotRxKey(rx, index);
  const aliases = [
    canonical,
    String(rx?.clientKey ?? '').trim(),
    String(rx?.id ?? '').trim(),
    String(rx?.hhhPrescriptionId ?? '').trim(),
  ].filter(Boolean);
  return [...new Set(aliases)];
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

function uniqueSubOrderKey(
  matches: Array<[string, Record<string, unknown>]>,
): string | null {
  const keys = [...new Set(matches.map(([key]) => key))];
  return keys.length === 1 ? keys[0]! : null;
}

/**
 * Which snapshot prescription a polled Curaleaf PO / prescription / prescriber belongs to.
 * Multi-Rx must match a sub-order; it never falls back to order-level `curaleaf`.
 */
export function rxKeyForCuraleafIdentity(
  snapshot: unknown,
  input: {
    purchaseOrderId?: string | null;
    prescriptionId?: string | null;
    prescriberId?: string | null;
  },
): string | null {
  const rxList = snapshotRxList(snapshot);
  const subOrders = Object.entries(curaleafSubOrders(snapshot));
  const purchaseOrderId = String(input.purchaseOrderId ?? '').trim();
  const prescriptionId = String(input.prescriptionId ?? '').trim();
  const prescriberId = String(input.prescriberId ?? '').trim();

  if (purchaseOrderId) {
    const matched = uniqueSubOrderKey(subOrders.filter(([, record]) => (
      String(record.purchaseOrderId || record.id || '').trim() === purchaseOrderId
    )));
    if (matched) return matched;
  }

  if (prescriptionId) {
    const fromSub = uniqueSubOrderKey(subOrders.filter(([, record]) => (
      String(record.prescriptionId ?? '').trim() === prescriptionId
    )));
    if (fromSub) return fromSub;
    const fromRx = rxList.flatMap((rx, index) => (
      String(rx.curaleafPrescriptionId ?? '').trim() === prescriptionId
        ? [[snapshotRxKey(rx, index), rx] as [string, Record<string, unknown>]]
        : []
    ));
    const matchedRx = uniqueSubOrderKey(fromRx);
    if (matchedRx) return matchedRx;
  }

  if (prescriberId) {
    const fromSub = uniqueSubOrderKey(subOrders.filter(([, record]) => (
      String(record.prescriberId ?? '').trim() === prescriberId
    )));
    if (fromSub) return fromSub;
  }

  if (rxList.length === 1) return snapshotRxKey(rxList[0], 0);
  return null;
}

export function rxHasPurchaseOrder(snapshot: unknown, rxKey: string): boolean {
  const sub = curaleafSubOrders(snapshot)[rxKey];
  const id = String(sub?.purchaseOrderId || sub?.id || '').trim();
  return Boolean(id);
}

export function snapshotPrescriptionHasPurchaseOrder(
  snapshot: unknown,
  rx: Record<string, unknown> | undefined,
  index: number,
): boolean {
  const subOrders = curaleafSubOrders(snapshot);
  const sub = lookupKeyedRecord(subOrders, rx) ?? subOrders[snapshotRxKey(rx, index)];
  return Boolean(String(sub?.purchaseOrderId || sub?.id || '').trim());
}

export function allSnapshotRxsHavePurchaseOrders(snapshot: unknown): boolean {
  const list = snapshotRxList(snapshot);
  if (!list.length) return false;
  return list.every((rx, index) => snapshotPrescriptionHasPurchaseOrder(snapshot, rx, index));
}

export function pendingPlacementRxIndexes(snapshot: unknown): number[] {
  return snapshotRxList(snapshot).flatMap((rx, index) => (
    snapshotPrescriptionHasPurchaseOrder(snapshot, rx, index) ? [] : [index]
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
