import { createHash } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrderLineRecord } from '../../repositories/ports/order-line.port.js';
import type { PaymentRecord, PaymentAllocationRecord, RefundRecord } from '../../repositories/ports/payment.port.js';
import { asSnapshotRecord, snapshotRxList, resolvePrescriptionSupplierOrder } from '../prescriptions/snapshot-rx.js';

export type PrescriptionRefundBreakdown = {
  version: 1;
  prescriptionId: string;
  medicines: Array<{ orderLineId: string; quantity: number; unitPricePence: number; amountPence: number; label: string }>;
  dispensingFeePence: number;
  deliveryFeePence: number;
  requestHash: string;
};
export type PrescriptionRefundInput = {
  previewVersion: string;
  requestId: string;
  medicines: Array<{ orderLineId: string; quantity: number }>;
  dispensingPercent: number;
  deliveryPercent: number;
};
export function refundConflict(message: string, code = 'REFUND_RECONCILIATION_REQUIRED'): never {
  throw new HttpError(409, message, code);
}
export function refundBreakdown(refund: RefundRecord): PrescriptionRefundBreakdown | null {
  const data = asSnapshotRecord(refund.breakdown);
  if (data.version !== 1 || typeof data.prescriptionId !== 'string' || !Array.isArray(data.medicines)
    || !Number.isSafeInteger(data.dispensingFeePence) || Number(data.dispensingFeePence) < 0
    || !Number.isSafeInteger(data.deliveryFeePence) || Number(data.deliveryFeePence) < 0) return null;
  const medicines = data.medicines.map(asSnapshotRecord);
  if (medicines.some(line => typeof line.orderLineId !== 'string' || !Number.isSafeInteger(line.quantity) || Number(line.quantity) <= 0
    || !Number.isSafeInteger(line.unitPricePence) || Number(line.unitPricePence) < 0
    || Number(line.amountPence) !== Number(line.quantity) * Number(line.unitPricePence))
    || new Set(medicines.map(line => line.orderLineId)).size !== medicines.length) return null;
  if (medicines.reduce((sum, line) => sum + Number(line.amountPence), 0) + Number(data.dispensingFeePence) + Number(data.deliveryFeePence) !== Number(refund.amountPence)) return null;
  return data as PrescriptionRefundBreakdown;
}
export const refundableHistory = (rows: RefundRecord[]) => rows.filter(row => row.status !== 'VOIDED');
export function prescriptionRefundPreview(input: {
  order: OrderRecord; payment: PaymentRecord; allocations: PaymentAllocationRecord[];
  refunds: RefundRecord[]; lines: OrderLineRecord[]; prescriptionId: string;
}) {
  const { order, payment, prescriptionId } = input;
  const snapshot = asSnapshotRecord(order.quoteSnapshot);
  const prescriptions = snapshotRxList(snapshot);
  const rx = prescriptions.find(rx => rx.hhhPrescriptionId === prescriptionId || rx.id === prescriptionId);
  const lines = input.lines.filter(line => line.prescriptionId === prescriptionId);
  if (!rx || !lines.length) refundConflict('The prescription’s paid medicine lines need reconciliation before refunding.');
  if (order.archivedAt || order.resolutionStatus === 'RESOLVED') refundConflict('This order is already resolved.');
  const allocation = input.allocations.filter(row => row.orderId === order.id && ['ACTIVE', 'REFUNDED'].includes(row.status));
  if (allocation.length !== 1) refundConflict('The remaining payment allocation needs reconciliation.');
  const replacements = input.allocations.filter(row => row.sourceOrderId === order.id && row.status !== 'RELEASED');
  // A legacy order-level transfer cannot be attributed to one prescription; a scoped one can.
  if (replacements.some(row => !row.sourcePrescriptionId)
    || snapshot.redoneByOrderId || ['REPLACED', 'REPLACEMENT_PENDING'].includes(String(asSnapshotRecord(snapshot.resolution).status))) {
    refundConflict('A replacement uses this payment. Reconcile its medicine allocation before refunding.');
  }
  if (replacements.some(row => row.sourcePrescriptionId === prescriptionId)) {
    refundConflict('This prescription was replaced using the paid balance. Its medicines are no longer refundable.', 'PRESCRIPTION_REPLACED');
  }
  const history = refundableHistory(input.refunds.filter(row => row.paymentId === payment.id));
  const legacySnapshotRefund = asSnapshotRecord(snapshot.refund);
  if (legacySnapshotRefund.id && !history.some(row => row.id === legacySnapshotRefund.id)) refundConflict('An earlier refund has no durable ledger entry. Reconcile it before another refund.');
  if (history.some(row => !refundBreakdown(row))) refundConflict('An earlier refund has no attributable breakdown. Reconcile it before another refund.');
  const supplierOrder = resolvePrescriptionSupplierOrder(snapshot, rx, prescriptions);
  if (!supplierOrder.cancelled) refundConflict('Curaleaf must confirm this prescription’s cancellation before refunding.', 'CURALEAF_CANCEL_REQUIRED');
  const { supplierLines, flowLines, supplierItems } = supplierOrder;
  if (supplierOrder.sharedPurchaseOrder) refundConflict('This legacy shared purchase order needs prescription-level fulfilment reconciliation before a partial refund.');
  const medicines = lines.map(line => {
    if (lines.filter(other => other.packId === line.packId).length !== 1) refundConflict('Repeated medicine lines need fulfilment reconciliation.');
    const candidates = [...supplierLines, ...flowLines].filter(row => String(row.productId || row.packId || '') === line.packId);
    const item = supplierItems.find(row => String(row.productId || row.packId || '') === line.packId);
    if (!candidates.length && !item) refundConflict('Supplier quantities are unavailable for this medicine.');
    if (candidates.some(row => row.reconciliationRequired || row.quantityMismatch)) refundConflict('Supplier quantities need reconciliation.');
    const shipped = Math.max(0, ...candidates.map(row => Math.max(Number(row.shipped || 0), Number(row.received || 0), Number(row.collected || 0))));
    // Without explicit line dispatch counters a PO item alone cannot prove no dispatch.
    if (!candidates.length) refundConflict('Dispatch quantities must be reconciled before refunding this medicine.');
    const quantity = Number(line.quantity);
    const unitPricePence = Number(line.fixedPatientPricePence);
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(shipped) || shipped > quantity || !Number.isSafeInteger(unitPricePence) || unitPricePence < 0
      || (line.lineMedicineRevenuePence != null && Number(line.lineMedicineRevenuePence) !== quantity * unitPricePence)) refundConflict('The original paid price or quantity needs reconciliation.');
    const used = history.flatMap(row => refundBreakdown(row)!.medicines).filter(row => row.orderLineId === line.id).reduce((sum, row) => sum + row.quantity, 0);
    if (used > quantity - shipped) refundConflict('Refund history exceeds the unfulfilled quantity.');
    return { orderLineId: line.id, label: line.formulaName || line.packId, quantity: quantity - shipped - used, unitPricePence };
  });
  // Shared charges move whole to the replacement that empties the order; after that nothing of them is left to refund.
  const chargesCarried = replacements.some(row => Number(row.carriedChargesPence || 0) > 0);
  const charge = (kind: 'dispensingFeePence' | 'deliveryFeePence', originalPence: number) => {
    const used = history.reduce((sum, row) => sum + refundBreakdown(row)![kind], 0);
    if (used > originalPence) refundConflict('Earlier fee refunds need reconciliation.');
    return { originalPence, remainingPence: chargesCarried ? 0 : originalPence - used };
  };
  const pending = history.filter(row => row.status !== 'COMPLETED');
  const reservedPence = pending.reduce((sum, row) => sum + Number(row.amountPence), 0);
  const completedPence = history.filter(row => row.status === 'COMPLETED').reduce((sum, row) => sum + Number(row.amountPence), 0);
  const availablePence = Math.min(Number(allocation[0]!.amountPence), Number(payment.amountPence) - completedPence) - reservedPence;
  if (availablePence < 0) refundConflict('Payment and refund balances need reconciliation.');
  return {
    prescriptionId, paymentId: payment.id,
    previewVersion: createHash('sha256').update(JSON.stringify([order.version, order.quoteSnapshot, payment.version, input.lines, input.allocations, history])).digest('hex'),
    medicines, dispensing: charge('dispensingFeePence', Number(order.dispensingFeePence)),
    delivery: charge('deliveryFeePence', Number(order.pharmacyDeliveryPence)),
    availablePence, reservedPence, completedPence,
    pendingRefundId: payment.pendingRefundId || pending[0]?.id || null,
    history: history.map(row => ({ id: row.id, prescriptionId: row.prescriptionId, status: row.status, amountPence: Number(row.amountPence), breakdown: refundBreakdown(row), externalReference: row.externalReference })),
  };
}
export function composePrescriptionRefund(preview: ReturnType<typeof prescriptionRefundPreview>, input: PrescriptionRefundInput): PrescriptionRefundBreakdown {
  if (input.previewVersion !== preview.previewVersion) refundConflict('The refund balance changed. Review the refreshed breakdown.', 'REFUND_PREVIEW_STALE');
  if (preview.pendingRefundId) refundConflict('A refund on this payment is awaiting confirmation.', 'REFUND_ALREADY_OPEN');
  if (new Set(input.medicines.map(row => row.orderLineId)).size !== input.medicines.length) refundConflict('Choose each medicine line once.');
  const medicines = input.medicines.map(selected => {
    const line = preview.medicines.find(row => row.orderLineId === selected.orderLineId);
    if (!line || !Number.isSafeInteger(selected.quantity) || selected.quantity <= 0 || selected.quantity > line.quantity) refundConflict('The selected quantity is not refundable.');
    return { ...selected, label: line.label, unitPricePence: line.unitPricePence, amountPence: line.unitPricePence * selected.quantity };
  });
  const fee = (charge: typeof preview.dispensing, percent: number) => {
    if (![0, 25, 50, 75, 100].includes(percent)) refundConflict('Choose a supported fee percentage.');
    const amount = Math.round(charge.originalPence * percent / 100);
    if (amount > charge.remainingPence) refundConflict('The fee refund exceeds the remaining charge.');
    return amount;
  };
  const breakdown = { version: 1 as const, prescriptionId: preview.prescriptionId, medicines,
    dispensingFeePence: fee(preview.dispensing, input.dispensingPercent), deliveryFeePence: fee(preview.delivery, input.deliveryPercent),
    requestHash: createHash('sha256').update(JSON.stringify({ ...input, medicines: [...input.medicines].sort((a,b) => a.orderLineId.localeCompare(b.orderLineId)) })).digest('hex') };
  const total = prescriptionRefundTotal(breakdown);
  if (!Number.isSafeInteger(total) || total <= 0 || total > preview.availablePence) refundConflict('The refund exceeds the remaining paid balance or is empty.');
  return breakdown;
}
export const prescriptionRefundTotal = (breakdown: PrescriptionRefundBreakdown) => breakdown.medicines.reduce((sum, row) => sum + row.amountPence, 0) + breakdown.dispensingFeePence + breakdown.deliveryFeePence;
