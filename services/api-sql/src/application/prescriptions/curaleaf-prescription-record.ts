import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';
import { SqlPrescriptionRepository } from '../../repositories/sql/prescription.sql.js';
import { SqlPrescriptionSerialRepository } from '../../repositories/sql/serial-use.sql.js';
import { prescriptionFileIdsFromSnapshot } from './prescription-file-purge.js';
import { curaleafSubOrders, snapshotRxKey, snapshotRxList } from './snapshot-rx.js';

const UUID_LIKE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function plusDays(isoDate: string, days: number) {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export type CuraleafPrescriptionState = 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';

export function asCuraleafPrescriptionState(value: unknown): CuraleafPrescriptionState | null {
  const state = String(value || '').trim().toUpperCase();
  if (state === 'ACTIVE' || state === 'FULFILLED' || state === 'EXPIRED' || state === 'CANCELLED' || state === 'PENDING') {
    return state;
  }
  return null;
}

export function normalizeCuraleafPurchaseOrder(
  purchaseOrder: Record<string, unknown> | null | undefined,
  fallback?: { customerReference?: string | null },
): Record<string, unknown> | null {
  if (!purchaseOrder || typeof purchaseOrder !== 'object') return null;
  const id = String(purchaseOrder.id || purchaseOrder.purchaseOrderId || '').trim();
  if (!id) return purchaseOrder;
  const state = String(purchaseOrder.state || purchaseOrder.purchaseOrderState || 'CREATED').toUpperCase();
  const customerReference = typeof purchaseOrder.customerReference === 'string' && purchaseOrder.customerReference.trim()
    ? purchaseOrder.customerReference.trim()
    : (fallback?.customerReference ?? null);
  return {
    ...purchaseOrder,
    id,
    purchaseOrderId: id,
    state,
    purchaseOrderState: state,
    customerReference,
    courier: typeof purchaseOrder.courier === 'string' && purchaseOrder.courier.trim()
      ? purchaseOrder.courier.trim()
      : purchaseOrder.courier ?? null,
  };
}

export function stampCuraleafPrescriptionOnSnapshot(
  snapshot: unknown,
  input: {
    prescriptionId?: string | null;
    prescriberId?: string | null;
    prescriberState?: 'UNVERIFIED' | 'VERIFIED' | 'ARCHIVED' | null;
    prescriptionState?: string | null;
    purchaseOrder?: Record<string, unknown> | null;
    customerReferenceFallback?: string | null;
    now?: string;
    rxKey?: string | null;
  },
) {
  const root = asRecord(snapshot);
  const prior = asRecord(root.curaleaf);
  const prescriptionId = input.prescriptionId || (typeof prior.prescriptionId === 'string' ? prior.prescriptionId : null);
  const prescriberId = input.prescriberId || (typeof prior.prescriberId === 'string' ? prior.prescriberId : null);
  const purchaseOrder = normalizeCuraleafPurchaseOrder(
    input.purchaseOrder && typeof input.purchaseOrder === 'object' ? input.purchaseOrder : null,
    { customerReference: input.customerReferenceFallback },
  );
  if (String(prior.purchaseOrderState || prior.state || '').toUpperCase() === 'CANCELLED') {
    return {
      ...root,
      quoteReview: null,
      curaleaf: {
        ...prior,
        status: 'prescription_closed',
        purchaseOrderState: 'CANCELLED',
        state: 'CANCELLED',
        prescriptionId,
        prescriberId,
      },
    };
  }
  const hasPurchaseOrder = Boolean(purchaseOrder?.id || purchaseOrder?.purchaseOrderId);
  const prescriptionState = asCuraleafPrescriptionState(input.prescriptionState)
    ?? asCuraleafPrescriptionState(prior.prescriptionState)
    ?? (hasPurchaseOrder ? 'ACTIVE' : prescriptionId ? 'PENDING' : null);
  const status = hasPurchaseOrder
    ? 'purchase_order_submitted'
    : prescriptionState === 'EXPIRED' || prescriptionState === 'CANCELLED'
      ? 'prescription_closed'
      : prescriptionId || prescriberId
        ? 'prescription_pending'
        : prior.status ?? null;
  const waitingFor = input.prescriberState === 'UNVERIFIED'
    ? 'prescriber_verification'
    : prescriptionState === 'PENDING'
      ? 'prescription_activation'
      : null;
  const waitingSince = waitingFor
    ? (prior.waitingFor === waitingFor && typeof prior.waitingSince === 'string'
      ? prior.waitingSince
      : input.now ?? new Date().toISOString())
    : null;
  const rxList = snapshotRxList(root);
  const rxKey = input.rxKey?.trim() || (rxList[0] ? snapshotRxKey(rxList[0], 0) : 'rx-0');
  const prescriptions = rxList.length > 0 ? rxList.map((rx, index) => {
    const key = snapshotRxKey(rx, index);
    if (prescriptionId && key === rxKey) return { ...rx, curaleafPrescriptionId: prescriptionId };
    return rx;
  }) : root.prescriptions;
  const curaleafRecord = {
    ...prior,
    ...(purchaseOrder ?? {}),
    status,
    prescriptionId,
    prescriberId,
    prescriberState: input.prescriberState ?? prior.prescriberState ?? null,
    prescriptionState,
    waitingFor,
    waitingSince,
    purchaseOrderId: purchaseOrder?.id ?? prior.purchaseOrderId ?? null,
    purchaseOrderState: purchaseOrder?.state ?? prior.purchaseOrderState ?? null,
    customerReference: purchaseOrder?.customerReference ?? prior.customerReference ?? input.customerReferenceFallback ?? null,
    courier: purchaseOrder?.courier ?? prior.courier ?? null,
  };

  return {
    ...root,
    prescriptions,
    curaleaf: curaleafRecord,
    curaleafSubOrders: {
      ...curaleafSubOrders(root),
      [rxKey]: curaleafRecord,
    },
  };
}

export async function persistCuraleafPrescriptionIdentity(input: {
  organisationId: string;
  orderId: string;
  patientId?: string | null;
  snapshot: unknown;
  prescriptionId?: string | null;
  prescriberId?: string | null;
  prescriberState?: 'UNVERIFIED' | 'VERIFIED' | 'ARCHIVED' | null;
  prescriptionState?: string | null;
  purchaseOrder?: Record<string, unknown> | null;
  customerReferenceFallback?: string | null;
  now?: string;
  rxKey?: string | null;
  fulfilmentStatus?: 'SUPPLIER_PENDING' | 'SUPPLIER_PROCESSING' | 'SUPPLIER_ALLOCATED' | 'PARTIALLY_DISPATCHED_TO_PHARMACY' | 'DISPATCHED_TO_PHARMACY' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'READY_FOR_COLLECTION' | 'COLLECTED' | 'EXCEPTION';
}) {
  if (!input.prescriptionId && !input.purchaseOrder && !input.prescriberId) return input.snapshot;

  const snapshot = stampCuraleafPrescriptionOnSnapshot(input.snapshot, input);
  const orderRepo = new SqlOrderRepository();
  await orderRepo.updateQuoteSnapshot({
    id: input.orderId,
    organisationId: input.organisationId,
    quoteSnapshot: snapshot,
    fulfilmentStatus: input.fulfilmentStatus,
  });

  const order = await orderRepo.findOrderById(input.orderId, input.organisationId);
  const patientId = input.patientId || order?.patientId || null;
  const purchaseOrderId = typeof input.purchaseOrder?.id === 'string'
    ? input.purchaseOrder.id
    : typeof input.purchaseOrder?.purchaseOrderId === 'string'
      ? input.purchaseOrder.purchaseOrderId
      : null;
  const prescriptionRepo = new SqlPrescriptionRepository();
  const rxList = snapshotRxList(snapshot);
  const rxIndex = Math.max(0, rxList.findIndex((entry, index) => snapshotRxKey(entry, index) === (input.rxKey || snapshotRxKey(rxList[0] || {}, 0))));
  const rx = rxList[rxIndex] ?? rxList[0] ?? {};
  const hhhPrescriptionId = typeof rx.hhhPrescriptionId === 'string' && UUID_LIKE.test(rx.hhhPrescriptionId)
    ? rx.hhhPrescriptionId
    : null;

  if (purchaseOrderId) {
    if (hhhPrescriptionId) {
      await new SqlOrderLineRepository().markLinesPlacedByPrescriptionId(input.orderId, hhhPrescriptionId);
    } else if (rxList.length <= 1) {
      await new SqlOrderLineRepository().markLinesPlaced(input.orderId);
    }
  }

  if (!input.prescriptionId) {
    if (purchaseOrderId) {
      await prescriptionRepo.attachSupplierPurchaseOrder(input.orderId, purchaseOrderId);
    }
    return snapshot;
  }
  if (!patientId) {
    throw new Error('Order is missing a patient, so the Curaleaf prescription cannot be stored.');
  }

  const serialNumber = typeof rx.serialNumber === 'string' && rx.serialNumber.trim()
    ? rx.serialNumber.trim()
    : `RX-${input.orderId.replace(/-/g, '').slice(0, 8)}`;
  const issueDate = typeof rx.issueDate === 'string' && rx.issueDate
    ? rx.issueDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const expiryDate = typeof rx.expiryDate === 'string' && rx.expiryDate
    ? rx.expiryDate.slice(0, 10)
    : plusDays(issueDate, 28);
  const patient = asRecord(rx.patient);
  const patientName = typeof patient.name === 'string' && patient.name.trim() ? patient.name.trim() : 'Unknown patient';
  const patientDob = typeof patient.dob === 'string' && patient.dob ? patient.dob.slice(0, 10) : '1900-01-01';
  const rxFileId = typeof rx.fileId === 'string' && UUID_LIKE.test(rx.fileId) ? rx.fileId : null;
  const fileIds = prescriptionFileIdsFromSnapshot(snapshot);
  const fileId = rxFileId || (rxList.length <= 1 && fileIds[0] && UUID_LIKE.test(fileIds[0]) ? fileIds[0] : null);
  const placed = Boolean(purchaseOrderId);

  await prescriptionRepo.recordSupplierPrescription({
    organisationId: input.organisationId,
    orderId: input.orderId,
    patientId,
    fileId,
    existingPrescriptionId: hhhPrescriptionId,
    supplierPrescriptionId: input.prescriptionId,
    serialNumber,
    issueDate,
    expiryDate,
    status: placed ? 'PLACED' : 'PENDING_PLACEMENT',
    patientNameSnapshot: patientName,
    patientDobSnapshot: patientDob,
    prescriberSnapshot: rx.prescriber ?? {},
    supplierPurchaseOrderId: purchaseOrderId,
    placementState: placed ? 'PLACED' : 'PENDING_PLACEMENT',
  });

  if (serialNumber && issueDate) {
    await new SqlPrescriptionSerialRepository().claim({
      organisationId: input.organisationId,
      serialNumber,
      issueDate,
      patientId,
      orderId: input.orderId,
      curaleafPrescriptionId: input.prescriptionId,
    }).catch(() => undefined);
  }

  return snapshot;
}
