import { createHash } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrderLineRecord } from '../../repositories/ports/order-line.port.js';
import type { PaymentAllocationRecord, PaymentRecord, RefundRecord } from '../../repositories/ports/payment.port.js';
import { asSnapshotRecord, customerReferenceForRx, resolvePrescriptionSupplierOrder, snapshotRxList } from '../prescriptions/snapshot-rx.js';
import { refundBreakdown, refundableHistory } from '../payments/prescription-refund.js';
import { supplierCancellationAlreadyConfirmed } from '../integrations/curaleaf-events.js';
import { replacementSupplierResolution } from './replacement-resolution.js';

/**
 * Where a sibling prescription on the same order stands. Shared charges only
 * move once every sibling has been replaced or refunded — "last one out".
 */
export type SiblingState = 'live' | 'cancelled_open' | 'replaced' | 'refunded';

export type ReplacementCharge = { originalPence: number; refundedPence: number; remainingPence: number; carriedPence: number };

const conflict = (message: string, code = 'REPLACEMENT_ALLOCATION_RECONCILIATION'): never => {
  throw new HttpError(409, message, code);
};

const rxIdOf = (rx: Record<string, unknown>) => String(rx.hhhPrescriptionId || rx.id || '');
const count = (value: unknown) => Math.max(0, Math.trunc(Number(value || 0)));
const shippedOn = (line: Record<string, unknown>) => Math.max(count(line.shipped), count(line.received), count(line.collected));
const isSettled = (allocation: PaymentAllocationRecord) => allocation.status !== 'RELEASED';

/**
 * Resolves what one cancelled prescription can carry into its replacement.
 *
 * On Curaleaf every prescription is its own purchase order, so cancellation and
 * replacement happen one prescription at a time even though the pharmacy took a
 * single payment for the whole order. Only that prescription's cancelled,
 * unfulfilled medicines move, at the price the patient paid. Dispensing,
 * delivery, supplier shipping and tax were paid once for the order and stay on
 * it while any sibling is still live; the replacement that empties the order
 * carries whatever remains of them.
 */
export function resolvePrescriptionReplacement(input: {
  order: OrderRecord;
  payment: PaymentRecord;
  allocations: PaymentAllocationRecord[];
  refunds: RefundRecord[];
  lines: OrderLineRecord[];
  prescriptionId: string | null;
}) {
  const { order, payment } = input;
  const snapshot = asSnapshotRecord(order.quoteSnapshot);
  const prescriptions = snapshotRxList(snapshot);
  if (!prescriptions.length) conflict('The source order has no prescription records.');
  const index = input.prescriptionId
    ? prescriptions.findIndex(rx => rxIdOf(rx) === input.prescriptionId || String(rx.id || '') === input.prescriptionId)
    : prescriptions.length === 1 ? 0 : -1;
  if (index < 0) {
    if (!input.prescriptionId) conflict('Choose which prescription this replacement is for.', 'REPLACEMENT_PRESCRIPTION_REQUIRED');
    throw new HttpError(404, 'Prescription not found on this order.', 'NOT_FOUND');
  }
  const rx = prescriptions[index]!;
  const prescriptionId = rxIdOf(rx) || String(input.prescriptionId);
  if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
    conflict('This source order has already been resolved.', 'REPLACEMENT_SOURCE_RESOLVED');
  }

  const supplierOrder = resolvePrescriptionSupplierOrder(snapshot, rx, prescriptions);
  if (supplierOrder.sharedPurchaseOrder) conflict('This legacy shared purchase order needs prescription-level fulfilment reconciliation before replacement.');
  // The order-level confirmation flag predates per-prescription purchase orders and only speaks for a sole prescription.
  const cancellationConfirmed = supplierOrder.cancelled
    || supplierCancellationAlreadyConfirmed(snapshot, supplierOrder.purchaseOrderId || null)
    || (prescriptions.length === 1 && !supplierOrder.purchaseOrderId && supplierCancellationAlreadyConfirmed(snapshot));
  const fulfilmentLines = (supplierOrder.supplierLines.length ? supplierOrder.supplierLines : supplierOrder.flowLines).map(line => ({
    productId: String(line.productId || line.packId || ''),
    ordered: count(line.ordered),
    shipped: count(line.shipped),
    received: count(line.received),
    cancelledRemainder: count(line.cancelledRemainder),
    reconciliationRequired: Boolean(line.reconciliationRequired || line.quantityMismatch),
  }));
  const supplierResolution = replacementSupplierResolution({ hasPurchaseOrder: supplierOrder.hasPurchaseOrder, cancellationConfirmed, fulfilmentLines });
  if (!supplierResolution.resolved) {
    throw new HttpError(409, 'Resolve every shipped and cancelled source line with Curaleaf before committing its replacement.', 'CURALEAF_CANCEL_REQUIRED', { reason: supplierResolution.reason });
  }

  const history = refundableHistory(input.refunds.filter(row => row.paymentId === payment.id));
  const openRefund = (row: RefundRecord) => !['FAILED', 'CANCELLED'].includes(String(row.status).toUpperCase());
  if (payment.pendingRefundId) conflict('A refund on this payment is awaiting confirmation. Confirm or reconcile it before replacing.', 'REPLACEMENT_REFUND_CONFLICT');
  if (history.some(row => !row.prescriptionId && openRefund(row))) conflict('A whole-order refund is recorded on this payment.', 'REPLACEMENT_REFUND_CONFLICT');
  if (history.some(row => row.prescriptionId === prescriptionId && openRefund(row))) conflict('This prescription has been refunded. It cannot also be replaced.', 'REPLACEMENT_REFUND_CONFLICT');
  if (history.some(row => row.prescriptionId && openRefund(row) && !refundBreakdown(row))) conflict('An earlier refund has no attributable breakdown. Reconcile it before replacing.');

  const fromSource = input.allocations.filter(row => row.sourceOrderId === order.id && isSettled(row));
  if (fromSource.some(row => !row.sourcePrescriptionId)) {
    if (prescriptions.length > 1) conflict('An earlier replacement was committed for the whole order. Reconcile it before replacing a prescription.');
    conflict('A paid replacement has already been committed for this source order.', 'REPLACEMENT_ALREADY_COMMITTED');
  }
  if (fromSource.some(row => row.sourcePrescriptionId === prescriptionId)) conflict('A paid replacement has already been committed for this prescription.', 'REPLACEMENT_ALREADY_COMMITTED');
  const held = input.allocations.filter(row => row.orderId === order.id);
  const active = held.filter(row => row.status === 'ACTIVE');
  if (active.length > 1) conflict('The remaining payment allocation needs reconciliation.');
  if (held.length && !active.length) conflict('The paid balance on this order has already been used.');
  const activeAllocation = active[0] ?? null;
  const activeAllocationPence = Number(activeAllocation?.amountPence ?? payment.amountPence);

  const lines = input.lines.filter(line => (line.prescriptionId ? line.prescriptionId === prescriptionId : prescriptions.length === 1));
  if (!lines.length) conflict('The prescription’s paid medicine lines need reconciliation before replacement.');
  const refundedQuantity = (orderLineId: string) => history
    .filter(row => row.prescriptionId === prescriptionId && openRefund(row))
    .flatMap(row => refundBreakdown(row)?.medicines ?? [])
    .filter(row => row.orderLineId === orderLineId)
    .reduce((sum, row) => sum + row.quantity, 0);
  const medicines = lines.flatMap(line => {
    if (lines.filter(other => other.packId === line.packId).length !== 1) conflict('Repeated medicine lines need fulfilment reconciliation.');
    const quantity = Number(line.quantity);
    const unitPricePence = Number(line.fixedPatientPricePence);
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(unitPricePence) || unitPricePence < 0
      || (line.lineMedicineRevenuePence != null && Number(line.lineMedicineRevenuePence) !== quantity * unitPricePence)) {
      conflict('The original paid price or quantity needs reconciliation.');
    }
    const supplierLine = fulfilmentLines.filter(row => row.productId === line.packId);
    if (supplierOrder.hasPurchaseOrder && supplierLine.length !== 1) conflict('Dispatch quantities must be reconciled before replacing this medicine.');
    const shipped = supplierLine.length ? shippedOn(supplierLine[0]! as unknown as Record<string, unknown>) : 0;
    const unfulfilled = quantity - shipped;
    if (unfulfilled < 0 || (supplierLine.length && supplierLine[0]!.cancelledRemainder !== unfulfilled)) conflict('Supplier quantities need reconciliation.');
    const replaceable = unfulfilled - refundedQuantity(line.id);
    if (replaceable < 0) conflict('Refund history exceeds the unfulfilled quantity.');
    if (replaceable === 0) return [];
    return [{ orderLineId: line.id, packId: line.packId, label: line.formulaName || line.packId, quantity: replaceable, unitPricePence, amountPence: replaceable * unitPricePence }];
  });
  const medicinePence = medicines.reduce((sum, row) => sum + row.amountPence, 0);
  if (medicinePence <= 0) conflict('The cancelled supplier remainder has no transferable patient value.');

  let sourceShippedAnywhere = fulfilmentLines.some(line => shippedOn(line as unknown as Record<string, unknown>) > 0);
  const siblings = prescriptions.flatMap((other, otherIndex) => {
    if (otherIndex === index) return [];
    const id = rxIdOf(other);
    const supplier = resolvePrescriptionSupplierOrder(snapshot, other, prescriptions);
    if (supplier.supplierLines.some(line => shippedOn(line) > 0)) sourceShippedAnywhere = true;
    const state: SiblingState = fromSource.some(row => row.sourcePrescriptionId === id) ? 'replaced'
      : !supplier.cancelled ? 'live'
      : history.some(row => row.prescriptionId === id && row.status === 'COMPLETED') ? 'refunded'
      : 'cancelled_open';
    return [{ prescriptionId: id, index: otherIndex, customerReference: customerReferenceForRx(order.orderNumber, order.id, otherIndex, order.organisationId), state }];
  });

  // Charges are all-or-nothing: once carried, nothing of them remains on the source.
  const alreadyCarried = fromSource.some(row => Number(row.carriedChargesPence || 0) > 0);
  const refundedFee = (kind: 'dispensingFeePence' | 'deliveryFeePence') => history
    .filter(row => row.prescriptionId && openRefund(row))
    .reduce((sum, row) => sum + (refundBreakdown(row)?.[kind] ?? 0), 0);
  const chargeOf = (originalPence: number, refundedPence: number): ReplacementCharge => {
    if (refundedPence > originalPence) conflict('Earlier fee refunds need reconciliation.');
    return { originalPence, refundedPence, remainingPence: alreadyCarried ? 0 : originalPence - refundedPence, carriedPence: 0 };
  };
  const charges = {
    dispensing: chargeOf(Number(order.dispensingFeePence || 0), refundedFee('dispensingFeePence')),
    delivery: chargeOf(Number(order.pharmacyDeliveryPence || 0), refundedFee('deliveryFeePence')),
    supplierDelivery: chargeOf(Number(order.deliveryPence || 0), 0),
    tax: chargeOf(Number(order.taxPence || 0), 0),
  };
  const remainingChargesPence = Object.values(charges).reduce((sum, charge) => sum + charge.remainingPence, 0);
  // Anything dispatched means the pharmacy dispensed and delivered for this order; those charges were earned.
  const carriesCharges = remainingChargesPence > 0
    && !sourceShippedAnywhere
    && siblings.every(sibling => sibling.state === 'replaced' || sibling.state === 'refunded');
  if (carriesCharges) for (const charge of Object.values(charges)) charge.carriedPence = charge.remainingPence;
  const carriedChargesPence = carriesCharges ? remainingChargesPence : 0;
  const transferPence = medicinePence + carriedChargesPence;
  if (transferPence > activeAllocationPence) conflict('The cancelled remainder exceeds the active payment allocation.');

  return {
    prescriptionId,
    prescriptionIndex: index,
    customerReference: customerReferenceForRx(order.orderNumber, order.id, index, order.organisationId),
    sourceRx: rx,
    sourceLines: lines,
    purchaseOrderId: supplierOrder.purchaseOrderId || null,
    medicines,
    medicinePence,
    charges,
    carriesCharges,
    carriedChargesPence,
    transferPence,
    activeAllocation,
    activeAllocationPence,
    siblings,
    // Once this prescription is replaced, is anything still holding the source order open?
    sourceResolvedAfter: siblings.every(sibling => sibling.state === 'replaced' || sibling.state === 'refunded'),
    previewVersion: createHash('sha256')
      .update(JSON.stringify([order.version, order.quoteSnapshot, payment.version, input.lines, input.allocations, history]))
      .digest('hex'),
  };
}

export type PrescriptionReplacementResolution = ReturnType<typeof resolvePrescriptionReplacement>;

/** The portal-facing shape: everything staff see at checkout, nothing internal. */
export function prescriptionReplacementPreview(resolution: PrescriptionReplacementResolution) {
  const { sourceRx: _rx, sourceLines: _lines, activeAllocation: _allocation, ...preview } = resolution;
  return { ...preview, carried: { dispensingPence: resolution.charges.dispensing.carriedPence, deliveryPence: resolution.charges.delivery.carriedPence } };
}

/** Records the replacement against its prescription on the source snapshot. */
export function stampPrescriptionReplacement(snapshot: unknown, data: {
  prescriptionId: string; replacementOrderId: string; transferPence: number; carriedChargesPence: number;
}) {
  const root = asSnapshotRecord(snapshot);
  return {
    ...root,
    prescriptionResolutions: {
      ...asSnapshotRecord(root.prescriptionResolutions),
      [data.prescriptionId]: {
        status: 'REPLACED',
        replacementOrderId: data.replacementOrderId,
        transferPence: data.transferPence,
        carriedChargesPence: data.carriedChargesPence,
        resolvedAt: new Date().toISOString(),
      },
    },
  };
}
