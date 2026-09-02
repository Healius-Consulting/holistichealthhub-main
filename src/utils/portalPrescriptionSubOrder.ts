import type { PortalCuraleafOrderState, PortalOrderRecord, PrescriptionFlowRecord } from '../shared/contracts';

export type PortalPrescriptionIdentity = {
  id?: string;
  clientKey?: string;
  hhhPrescriptionId?: string;
  fileId?: string;
  curaleafPrescriptionId?: string;
};

export function portalPrescriptionCorrelationKeys(prescription: PortalPrescriptionIdentity): string[] {
  const keys = [
    String(prescription.clientKey || '').trim(),
    String(prescription.id || '').trim(),
    String(prescription.hhhPrescriptionId || '').trim(),
    String(prescription.fileId || '').trim(),
  ].filter(Boolean);
  return [...new Set(keys)];
}

export function portalPrescriptionKey(prescription: PortalPrescriptionIdentity) {
  return portalPrescriptionCorrelationKeys(prescription)[0] ?? '';
}

function compactKey(value: string) {
  return value.replaceAll('-', '').toLowerCase();
}

function lookupKeyedRecord<T extends object>(
  map: Record<string, T> | null | undefined,
  prescription: PortalPrescriptionIdentity,
): T | undefined {
  if (!map) return undefined;
  for (const key of portalPrescriptionCorrelationKeys(prescription)) {
    if (map[key]) return map[key];
    const compact = compactKey(key);
    if (!compact) continue;
    for (const [existing, value] of Object.entries(map)) {
      if (compactKey(existing) === compact) return value;
    }
  }
  const curaleafId = String(prescription.curaleafPrescriptionId || '').trim();
  if (!curaleafId) return undefined;
  return Object.values(map).find(value => (
    String((value as { prescriptionId?: string }).prescriptionId || '').trim() === curaleafId
  ));
}

export function portalPrescriptionIsMultiRx(record: Pick<PortalOrderRecord, 'prescriptions'>) {
  return (record.prescriptions?.length ?? 0) > 1;
}

export function portalPrescriptionFlow(
  record: Pick<PortalOrderRecord, 'prescriptionFlow'>,
  prescription: PortalPrescriptionIdentity,
): PrescriptionFlowRecord | undefined {
  return lookupKeyedRecord(record.prescriptionFlow, prescription);
}

/** Sub-orders are keyed by Rx correlation. Never attach the order-level Curaleaf PO to every card. */
export function resolvePortalPrescriptionCuraleaf(
  record: Pick<PortalOrderRecord, 'curaleaf' | 'curaleafSubOrders' | 'prescriptions'>,
  prescription: PortalPrescriptionIdentity,
): PortalCuraleafOrderState | undefined {
  const fromSub = lookupKeyedRecord(record.curaleafSubOrders, prescription);
  if (fromSub) return fromSub;
  if (portalPrescriptionIsMultiRx(record)) return undefined;
  return record.curaleaf;
}

export function packIdsFromItems(items: Array<{ productId?: string; packId?: string }> | undefined): Set<string> {
  return new Set((items ?? []).map(item => String(item.packId || item.productId || '').trim()).filter(Boolean));
}

export function fulfilmentLinesForPrescription<T extends { productId?: string | null; packId?: string }>(
  lines: T[] | undefined,
  items: Array<{ productId?: string; packId?: string }> | undefined,
  options?: { failClosedWhenEmpty?: boolean },
): T[] {
  if (!lines?.length) return [];
  const packIds = packIdsFromItems(items);
  if (!packIds.size) return options?.failClosedWhenEmpty ? [] : lines;
  return lines.filter(line => packIds.has(String(line.productId || line.packId || '').trim()));
}

export function shipmentsForPrescription<T extends { items?: Array<{ productId?: string; packId?: string; packCount?: number }> }>(
  shipments: T[] | undefined,
  items: Array<{ productId?: string; packId?: string }> | undefined,
  options?: { failClosedWhenEmpty?: boolean },
): T[] {
  if (!shipments?.length) return [];
  const packIds = packIdsFromItems(items);
  if (!packIds.size) return options?.failClosedWhenEmpty ? [] : shipments;
  return shipments.flatMap(shipment => {
    const shipmentItems = Array.isArray(shipment.items) ? shipment.items : [];
    if (!shipmentItems.length) return [];
    const filteredItems = shipmentItems.filter(item => packIds.has(String(item.productId || item.packId || '').trim()));
    if (!filteredItems.length) return [];
    return [{ ...shipment, items: filteredItems }];
  });
}

export function portalPrescriptionHasPurchaseOrder(
  record: Pick<PortalOrderRecord, 'curaleaf' | 'curaleafSubOrders' | 'prescriptions' | 'prescriptionFlow'>,
  prescription: PortalPrescriptionIdentity,
): boolean {
  const flow = portalPrescriptionFlow(record, prescription);
  const sub = resolvePortalPrescriptionCuraleaf(record, prescription);
  return Boolean(String(flow?.purchaseOrderId || sub?.purchaseOrderId || '').trim());
}
