import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpError } from '../../domain/common/errors.js';
import type { PaymentAllocationRecord, RefundRecord } from '../../repositories/ports/payment.port.js';
import { prescriptionReplacementPreview, resolvePrescriptionReplacement, stampPrescriptionReplacement } from './prescription-replacement.js';

/**
 * A paid £150 order: P1 (£85, cancelled at Curaleaf) and P2 (£50, still being
 * fulfilled), plus £10 dispensing and £5 delivery taken once for the order.
 * Both prescriptions carry the same product, so ownership must come from the
 * prescription, never the pack.
 */
function fixture() {
  const supplierLine = (extra: Record<string, unknown> = {}) => ({ productId: 'same-product', ordered: 1, shipped: 0, cancelledRemainder: 1, ...extra });
  return {
    order: {
      id: 'order', organisationId: 'org', orderNumber: 'HHH-1', version: 3, updatedAt: '2026-09-08T00:00:00Z',
      dispensingFeePence: 1000, pharmacyDeliveryPence: 500, deliveryPence: 0, taxPence: 0,
      quoteSnapshot: {
        prescriptions: [{ hhhPrescriptionId: 'rx1' }, { hhhPrescriptionId: 'rx2' }],
        curaleafSubOrders: {
          rx1: { purchaseOrderId: 'po1', purchaseOrderState: 'CANCELLED', lines: [supplierLine()] },
          rx2: { purchaseOrderId: 'po2', purchaseOrderState: 'PROCESSING', lines: [supplierLine({ cancelledRemainder: 0 })] },
        },
      },
    } as any,
    payment: { id: 'payment', organisationId: 'org', orderId: 'order', amountPence: 15000, version: 2, status: 'PAID', route: 'MANUAL', currency: 'GBP' } as any,
    allocations: [{ id: 'allocation', organisationId: 'org', paymentId: 'payment', orderId: 'order', status: 'ACTIVE', amountPence: 15000, version: 1 }] as PaymentAllocationRecord[],
    refunds: [] as RefundRecord[],
    lines: [
      { id: 'line1', orderId: 'order', prescriptionId: 'rx1', packId: 'same-product', formulaName: 'Adven T20', quantity: 1, fixedPatientPricePence: 8500, lineMedicineRevenuePence: 8500 },
      { id: 'line2', orderId: 'order', prescriptionId: 'rx2', packId: 'same-product', formulaName: 'Adven T20', quantity: 1, fixedPatientPricePence: 5000, lineMedicineRevenuePence: 5000 },
    ] as any,
    prescriptionId: 'rx1' as string | null,
  };
}

const cancelRx2 = (data: ReturnType<typeof fixture>) => {
  data.order.quoteSnapshot.curaleafSubOrders.rx2.purchaseOrderState = 'CANCELLED';
  data.order.quoteSnapshot.curaleafSubOrders.rx2.lines[0].cancelledRemainder = 1;
};
const replacedRx1 = (): PaymentAllocationRecord => ({
  id: 'moved-rx1', organisationId: 'org', paymentId: 'payment', orderId: 'replacement-1', sourceOrderId: 'order', sourcePrescriptionId: 'rx1',
  amountPence: 8500, carriedChargesPence: 0, status: 'ACTIVE', version: 1, createdAt: '2026-09-08T01:00:00Z', updatedAt: '2026-09-08T01:00:00Z',
});
const completedRefundRx1 = (dispensingFeePence = 0): RefundRecord => ({
  id: 'refund-rx1', organisationId: 'org', orderId: 'order', paymentId: 'payment', prescriptionId: 'rx1', status: 'COMPLETED',
  amountPence: 8500 + dispensingFeePence, currency: 'GBP', cause: 'prescription_cancelled', route: 'MANUAL', idempotencyKey: 'k',
  breakdown: { version: 1, prescriptionId: 'rx1', requestHash: 'h', dispensingFeePence, deliveryFeePence: 0,
    medicines: [{ orderLineId: 'line1', quantity: 1, unitPricePence: 8500, amountPence: 8500, label: 'Adven T20' }] },
} as RefundRecord);
const code = (error: unknown) => (error as HttpError).code;

test('replacing P1 while P2 is live carries only P1’s medicines; the shared charges stay with the order', () => {
  const result = resolvePrescriptionReplacement(fixture());
  assert.deepEqual(result.medicines.map(row => [row.orderLineId, row.quantity, row.amountPence]), [['line1', 1, 8500]]);
  assert.equal(result.transferPence, 8500);
  assert.equal(result.carriesCharges, false);
  assert.equal(result.carriedChargesPence, 0);
  assert.deepEqual(result.siblings.map(row => [row.prescriptionId, row.state]), [['rx2', 'live']]);
  assert.equal(result.siblings[0]!.customerReference.endsWith('-P2'), true);
  assert.equal(result.sourceResolvedAfter, false, 'P2 keeps the source order open');
  assert.equal(result.charges.dispensing.remainingPence, 1000);
  assert.equal(result.charges.delivery.remainingPence, 500);
});

test('the last prescription out carries the remaining dispensing and delivery', () => {
  const data = fixture();
  cancelRx2(data);
  data.allocations.push(replacedRx1());
  data.allocations[0]!.amountPence = 6500;
  const result = resolvePrescriptionReplacement({ ...data, prescriptionId: 'rx2' });
  assert.equal(result.medicinePence, 5000);
  assert.equal(result.carriesCharges, true);
  assert.equal(result.carriedChargesPence, 1500);
  assert.equal(result.transferPence, 6500, 'P1’s medicines plus P2’s medicines plus the charges account for the whole £150');
  assert.equal(result.sourceResolvedAfter, true);
  assert.deepEqual(result.siblings.map(row => row.state), ['replaced']);
});

test('a refunded sibling leaves only the unrefunded share of the charges to carry', () => {
  const data = fixture();
  cancelRx2(data);
  data.refunds = [completedRefundRx1(500)];
  data.allocations[0]!.amountPence = 6000;
  const result = resolvePrescriptionReplacement({ ...data, prescriptionId: 'rx2' });
  assert.deepEqual(result.siblings.map(row => row.state), ['refunded']);
  assert.equal(result.charges.dispensing.refundedPence, 500);
  assert.equal(result.charges.dispensing.carriedPence, 500);
  assert.equal(result.charges.delivery.carriedPence, 500);
  assert.equal(result.transferPence, 6000);
});

test('charges never move once anything on the order was dispatched', () => {
  const data = fixture();
  cancelRx2(data);
  data.allocations.push(replacedRx1());
  data.allocations[0]!.amountPence = 6500;
  data.order.quoteSnapshot.curaleafSubOrders.rx1.lines[0] = { productId: 'same-product', ordered: 1, shipped: 1, cancelledRemainder: 0 };
  const result = resolvePrescriptionReplacement({ ...data, prescriptionId: 'rx2' });
  assert.equal(result.carriesCharges, false, 'the pharmacy dispensed and delivered for P1');
  assert.equal(result.transferPence, 5000);
});

test('each prescription can be replaced once, and a refunded prescription cannot also be replaced', () => {
  const replaced = fixture();
  replaced.allocations.push(replacedRx1());
  assert.throws(() => resolvePrescriptionReplacement(replaced), error => code(error) === 'REPLACEMENT_ALREADY_COMMITTED');

  const refunded = fixture();
  refunded.refunds = [completedRefundRx1()];
  assert.throws(() => resolvePrescriptionReplacement(refunded), error => code(error) === 'REPLACEMENT_REFUND_CONFLICT');

  // Refund P1, replace P2: legitimate, and P2 draws only its own value.
  cancelRx2(refunded);
  refunded.allocations[0]!.amountPence = 6500;
  const result = resolvePrescriptionReplacement({ ...refunded, prescriptionId: 'rx2' });
  assert.equal(result.medicinePence, 5000);
  assert.equal(result.carriesCharges, true);
});

test('a reserved refund or a whole-order refund blocks every replacement', () => {
  const pending = fixture();
  pending.payment.pendingRefundId = 'refund-open';
  assert.throws(() => resolvePrescriptionReplacement(pending), error => code(error) === 'REPLACEMENT_REFUND_CONFLICT');

  const wholeOrder = fixture();
  wholeOrder.refunds = [{ id: 'legacy', paymentId: 'payment', orderId: 'order', organisationId: 'org', status: 'PENDING_CONFIRMATION', amountPence: 100 } as RefundRecord];
  assert.throws(() => resolvePrescriptionReplacement(wholeOrder), error => code(error) === 'REPLACEMENT_REFUND_CONFLICT');
});

test('a legacy order-level transfer on a multi-prescription order needs reconciliation first', () => {
  const data = fixture();
  cancelRx2(data);
  data.allocations.push({ ...replacedRx1(), sourcePrescriptionId: null });
  assert.throws(() => resolvePrescriptionReplacement({ ...data, prescriptionId: 'rx2' }), /whole order/);
});

test('an active prescription, an unknown prescription, or no prescription at all cannot be replaced', () => {
  assert.throws(() => resolvePrescriptionReplacement({ ...fixture(), prescriptionId: 'rx2' }), error => code(error) === 'CURALEAF_CANCEL_REQUIRED');
  assert.throws(() => resolvePrescriptionReplacement({ ...fixture(), prescriptionId: 'rx-unknown' }), error => (error as HttpError).statusCode === 404);
  assert.throws(() => resolvePrescriptionReplacement({ ...fixture(), prescriptionId: null }), error => code(error) === 'REPLACEMENT_PRESCRIPTION_REQUIRED');
});

test('a single-prescription order behaves as before: everything moves when nothing shipped, only the remainder after a partial dispatch', () => {
  const single = () => {
    const data = fixture();
    data.order.quoteSnapshot = {
      prescriptions: [{ hhhPrescriptionId: 'rx1' }],
      curaleaf: { purchaseOrderId: 'po1', purchaseOrderState: 'CANCELLED', lines: [{ productId: 'same-product', ordered: 2, shipped: 0, cancelledRemainder: 2 }] },
    };
    data.lines = [{ id: 'line1', orderId: 'order', prescriptionId: 'rx1', packId: 'same-product', formulaName: 'Adven T20', quantity: 2, fixedPatientPricePence: 4250, lineMedicineRevenuePence: 8500 }] as any;
    data.payment.amountPence = 10000;
    data.allocations[0]!.amountPence = 10000;
    return data;
  };
  const whole = resolvePrescriptionReplacement({ ...single(), prescriptionId: null });
  assert.equal(whole.transferPence, 10000, 'medicines plus the £15 of charges: the full allocation');
  assert.equal(whole.sourceResolvedAfter, true);

  const partial = single();
  partial.order.quoteSnapshot.curaleaf.lines[0] = { productId: 'same-product', ordered: 2, shipped: 1, cancelledRemainder: 1 };
  const remainder = resolvePrescriptionReplacement({ ...partial, prescriptionId: null });
  assert.equal(remainder.transferPence, 4250);
  assert.equal(remainder.carriesCharges, false);
});

test('the preview exposes what staff see and the stamp records the replacement on the source', () => {
  const preview = prescriptionReplacementPreview(resolvePrescriptionReplacement(fixture()));
  assert.equal('sourceRx' in preview, false);
  assert.equal(preview.carried.dispensingPence, 0);
  assert.equal(preview.previewVersion.length, 64);

  const stamped = stampPrescriptionReplacement({ prescriptions: [] }, { prescriptionId: 'rx1', replacementOrderId: 'replacement-1', transferPence: 8500, carriedChargesPence: 0 });
  assert.equal((stamped.prescriptionResolutions as any).rx1.status, 'REPLACED');
  assert.equal((stamped.prescriptionResolutions as any).rx1.replacementOrderId, 'replacement-1');
});
