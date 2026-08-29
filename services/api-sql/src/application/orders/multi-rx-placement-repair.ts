type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue => value && typeof value === 'object' ? value as RecordValue : {};
const asArray = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(asRecord) : [];
const compactUuid = (value: unknown) => String(value || '').replace(/-/g, '').toLowerCase();

export const MULTI_RX_REPAIR = {
  projectId: 'hhh26-4ebd2',
  organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
  orderNumber: 'ORD-MTDUS9JV-816507F909',
  orderId: '73a68d730f5049c2bc38e14c1b198059',
  prescriptionKey: '3504',
  hhhPrescriptionId: 'a26ab15c932a47a2b6108c3e5d4912af',
  serialUseId: '5499c0984c2241788447736632cc892e',
  serialNumber: 'PT1',
  prescriptionId: '686e564a-bb38-45ae-9010-47f51e05b77b',
  purchaseOrderId: 'f7d0539e-8c4d-4116-b107-b4356c4c37cb',
  purchaseOrderItemId: '43f051fc-89d9-4113-b6d0-6381134d6b20',
  customerReference: '1DZ-816507F909-P1',
  createdAt: '2026-08-29T04:01:42.669244Z',
  overwrittenPrescriptionId: '7454f7aa-e148-4e38-838d-1e5a1eb626a7',
  overwrittenPurchaseOrderId: '3e112519-8819-41a1-8d2d-94fe99b10c6e',
  overwrittenPurchaseOrderItemId: 'c3dec4b5-06a2-4b16-a13f-c33a59a85433',
} as const;

export function planMultiRxPlacementRepair(input: {
  projectId: string;
  order: RecordValue;
  orderPrescriptions: RecordValue[];
  serialUses: RecordValue[];
  repairedAt?: string;
}) {
  const reasons: string[] = [];
  const expected = MULTI_RX_REPAIR;
  const order = input.order;
  const snapshot = asRecord(order.quoteSnapshot);
  const prescriptions = asArray(snapshot.prescriptions);
  const subOrders = asRecord(snapshot.curaleafSubOrders);
  const p1 = prescriptions.find(rx => String(rx.id) === expected.prescriptionKey);
  const p2 = prescriptions.find(rx => String(rx.id) === '3505');
  const p3 = prescriptions.find(rx => String(rx.id) === '3506');
  const p1Sub = asRecord(subOrders[expected.prescriptionKey]);
  const p2Sub = asRecord(subOrders['3505']);
  const p3Sub = asRecord(subOrders['3506']);

  if (input.projectId !== expected.projectId) reasons.push('unexpected Firebase project');
  if (String(order.orderNumber) !== expected.orderNumber) reasons.push('unexpected order number');
  if (compactUuid(order.id) !== expected.orderId) reasons.push('unexpected order id');
  if (compactUuid(order.organisationId) !== compactUuid(expected.organisationId)) reasons.push('unexpected organisation');
  if (String(order.paymentStatus) !== 'PAID' || String(order.status) !== 'PROCESSING') reasons.push('unexpected order state');
  if (prescriptions.length !== 3) reasons.push('expected exactly three prescriptions');
  if (String(p1?.serialNumber) !== 'PT1' || String(p2?.serialNumber) !== 'PT2' || String(p3?.serialNumber) !== 'PT3') reasons.push('unexpected prescription serials');
  if (compactUuid(p1?.hhhPrescriptionId) !== expected.hhhPrescriptionId) reasons.push('unexpected Prescription 1 HHH id');
  const headerOverwritten = String(p1?.curaleafPrescriptionId) === expected.overwrittenPrescriptionId
    && String(p1Sub.id) === expected.overwrittenPurchaseOrderId
    && String(p1Sub.purchaseOrderId) === expected.overwrittenPurchaseOrderId;
  const headerRepaired = String(p1?.curaleafPrescriptionId) === expected.prescriptionId
    && String(p1Sub.id) === expected.purchaseOrderId
    && String(p1Sub.purchaseOrderId) === expected.purchaseOrderId;
  if (!headerOverwritten && !headerRepaired) reasons.push('Prescription 1 is not in an expected repair state');
  const p1Items = asArray(p1Sub.items);
  if (p1Items.length !== 1 || String(p1Items[0]?.id) !== expected.overwrittenPurchaseOrderItemId) reasons.push('unexpected current Prescription 1 purchase-order line');
  if (String(p2?.curaleafPrescriptionId) !== 'c5e9b198-e836-4719-a8b6-559fc189fb65'
    || String(p2Sub.purchaseOrderId || p2Sub.id) !== '310eff18-6979-425b-91ee-d68def952e33') reasons.push('Prescription 2 no longer matches verified state');
  if (String(p3?.curaleafPrescriptionId) !== expected.overwrittenPrescriptionId
    || String(p3Sub.purchaseOrderId || p3Sub.id) !== expected.overwrittenPurchaseOrderId) reasons.push('Prescription 3 no longer matches verified state');

  const p1Link = input.orderPrescriptions.find(link => compactUuid(link.prescriptionId) === expected.hhhPrescriptionId);
  const linkPending = p1Link && String(p1Link.placementState) === 'PENDING_PLACEMENT' && p1Link.supplierPurchaseOrderId == null;
  const linkRepaired = p1Link && String(p1Link.placementState) === 'PLACED' && String(p1Link.supplierPurchaseOrderId) === expected.purchaseOrderId;
  if (!linkPending && !linkRepaired) reasons.push('unexpected Prescription 1 SQL link');
  const p1Serial = input.serialUses.find(row => compactUuid(row.id) === expected.serialUseId);
  if (!p1Serial || String(p1Serial.serialNumber) !== expected.serialNumber
    || (String(p1Serial.curaleafPrescriptionId) !== expected.overwrittenPrescriptionId
      && String(p1Serial.curaleafPrescriptionId) !== expected.prescriptionId)) reasons.push('unexpected Prescription 1 serial claim');

  if (reasons.length) return { eligible: false as const, reasons };

  const repairedSub = {
    ...p1Sub,
    id: expected.purchaseOrderId,
    purchaseOrderId: expected.purchaseOrderId,
    customerReference: expected.customerReference,
    prescriptionId: expected.prescriptionId,
    createdAt: expected.createdAt,
    items: p1Items.map(item => ({ ...item, id: expected.purchaseOrderItemId, purchaseOrderId: expected.purchaseOrderId })),
  };
  return {
    eligible: true as const,
    reasons,
    nextSnapshot: {
      ...snapshot,
      prescriptions: prescriptions.map(rx => String(rx.id) === expected.prescriptionKey
        ? { ...rx, curaleafPrescriptionId: expected.prescriptionId }
        : rx),
      curaleafSubOrders: { ...subOrders, [expected.prescriptionKey]: repairedSub },
      auditEvents: [
        ...asArray(snapshot.auditEvents).filter(event => event.type !== 'multi_rx_identity_repair'),
        {
          type: 'multi_rx_identity_repair',
          label: 'Record link repaired',
          detail: 'Prescription 1 restored; existing Curaleaf order unchanged; no duplicate order sent.',
          occurredAt: input.repairedAt ?? new Date().toISOString(),
          reference: expected.customerReference,
        },
      ],
    },
  };
}
