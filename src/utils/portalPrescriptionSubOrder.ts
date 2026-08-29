import type { PortalCuraleafOrderState, PortalOrderRecord, PrescriptionFlowRecord } from '../shared/contracts';

export function portalPrescriptionKey(prescription: { id?: string; fileId?: string }) {
  const id = String(prescription.id || '').trim();
  if (id) return id;
  return String(prescription.fileId || '').trim();
}

export function portalPrescriptionIsMultiRx(record: Pick<PortalOrderRecord, 'prescriptions'>) {
  return (record.prescriptions?.length ?? 0) > 1;
}

export function portalPrescriptionFlow(
  record: Pick<PortalOrderRecord, 'prescriptionFlow'>,
  prescription: { id?: string; fileId?: string },
): PrescriptionFlowRecord | undefined {
  const flow = record.prescriptionFlow;
  if (!flow) return undefined;
  const key = portalPrescriptionKey(prescription);
  if (key && flow[key]) return flow[key];
  const fileId = String(prescription.fileId || '').trim();
  if (fileId && flow[fileId]) return flow[fileId];
  return undefined;
}

/** Sub-orders are keyed by Rx id. Never attach the order-level Curaleaf PO to every card. */
export function resolvePortalPrescriptionCuraleaf(
  record: Pick<PortalOrderRecord, 'curaleaf' | 'curaleafSubOrders' | 'prescriptions'>,
  prescription: { id?: string; fileId?: string },
): PortalCuraleafOrderState | undefined {
  const subs = record.curaleafSubOrders && typeof record.curaleafSubOrders === 'object'
    ? record.curaleafSubOrders
    : {};
  const key = portalPrescriptionKey(prescription);
  const fromId = key ? subs[key] : undefined;
  const fileId = String(prescription.fileId || '').trim();
  const fromFile = fileId && fileId !== key ? subs[fileId] : undefined;
  if (fromId || fromFile) return fromId ?? fromFile;
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
  prescription: { id?: string; fileId?: string },
): boolean {
  const flow = portalPrescriptionFlow(record, prescription);
  const sub = resolvePortalPrescriptionCuraleaf(record, prescription);
  return Boolean(String(flow?.purchaseOrderId || sub?.purchaseOrderId || '').trim());
}
