import type { CRMPatient, PatientOrder, Prescription } from '../context/AppContext';
import { orderCancellationResolution, orderStage, prescriptionIsCancelled, type OrderStage } from './orderStage.ts';

export interface PrescriptionWorkItem {
  key: string;
  /** The real order. Mutations must always use this object, never `record.order`. */
  sourceOrder: PatientOrder;
  patient: CRMPatient | null;
  prescription: Prescription | null;
  prescriptionIndex: number | null;
  prescriptionCount: number;
  /** A one-prescription projection used only by stage/lane display derivation. */
  record: {
    order: PatientOrder;
    patient: CRMPatient | null;
    stage: OrderStage;
    unresolvedReason: ReturnType<typeof orderStage>['unresolvedReason'];
  };
}

type OrderRecordInput = {
  order: PatientOrder;
  patient: CRMPatient | null;
};

function quoteReviewIsOpen(order: PatientOrder) {
  return ['required', 'awaiting_top_up', 'awaiting_refund'].includes(order.quoteReview?.status ?? '')
    || ['CHANGED', 'OUT_OF_STOCK', 'RECONCILIATION_REQUIRED'].includes(order.activeQuoteCheck?.status ?? '');
}

/**
 * Older order payloads keep quote/cancellation resolution on the order. Until those
 * records carry a prescription id, attach the exception to one deterministic Rx so a
 * multi-prescription order does not create duplicate work in every lane.
 */
function exceptionOwnerIndex(order: PatientOrder) {
  const cancelled = order.prescriptions.findIndex(prescriptionIsCancelled);
  if (cancelled >= 0) return cancelled;
  if (quoteReviewIsOpen(order)) {
    const notPlaced = order.prescriptions.findIndex(prescription => !prescription.purchaseOrderId);
    return notPlaced >= 0 ? notPlaced : 0;
  }
  return 0;
}

function prescriptionProjection(order: PatientOrder, prescription: Prescription, index: number): PatientOrder {
  const ownsException = index === exceptionOwnerIndex(order);
  const cancelled = prescriptionIsCancelled(prescription);
  const preserveTerminalOrderState = cancelled || order.prescriptions.length === 1;

  return {
    ...order,
    prescriptions: [prescription],
    quoteReview: ownsException ? order.quoteReview : undefined,
    activeQuoteCheck: ownsException ? order.activeQuoteCheck : undefined,
    quoteChecks: ownsException ? order.quoteChecks : undefined,
    refund: ownsException && cancelled ? order.refund : undefined,
    cancellation: ownsException && cancelled ? order.cancellation : undefined,
    curaleafCancellation: ownsException && cancelled ? order.curaleafCancellation : undefined,
    resolution: ownsException && cancelled ? order.resolution : undefined,
    lifecycleStatus: preserveTerminalOrderState ? order.lifecycleStatus : undefined,
    unresolvedReason: preserveTerminalOrderState ? order.unresolvedReason : null,
    redoneByOrderId: ownsException && cancelled ? order.redoneByOrderId : null,
  };
}

export function buildPrescriptionWorkItems(input: OrderRecordInput): PrescriptionWorkItem[] {
  const { order, patient } = input;
  // Payment is one order-level gate. Duplicating it once per prescription would inflate
  // the queue and imply the patient has several independent balances to settle.
  if (order.payment.status === 'sent' || order.prescriptions.length === 0) {
    const resolved = orderStage(order);
    return [{
      key: `order:${order.id}`,
      sourceOrder: order,
      patient,
      prescription: null,
      prescriptionIndex: null,
      prescriptionCount: order.prescriptions.length,
      record: { order, patient, ...resolved },
    }];
  }

  return order.prescriptions.map((prescription, index) => {
    const projectedOrder = prescriptionProjection(order, prescription, index);
    const resolved = orderStage(projectedOrder);
    return {
      key: `order:${order.id}:rx:${prescription.id}`,
      sourceOrder: order,
      patient,
      prescription,
      prescriptionIndex: index,
      prescriptionCount: order.prescriptions.length,
      record: { order: projectedOrder, patient, ...resolved },
    };
  });
}

export function prescriptionWorkItemLabel(item: PrescriptionWorkItem) {
  if (!item.prescription || item.prescriptionIndex === null) return `${item.prescriptionCount} prescription${item.prescriptionCount === 1 ? '' : 's'}`;
  return `Rx ${item.prescriptionIndex + 1} of ${item.prescriptionCount}`;
}

export function prescriptionWorkItemIsLive(item: PrescriptionWorkItem) {
  return item.record.stage !== 'collected'
    && !['resolved', 'refunded'].includes(orderCancellationResolution(item.record.order));
}
