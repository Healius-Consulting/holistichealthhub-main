import assert from 'node:assert/strict';
import test from 'node:test';
import { prescriptionRefundPreview, composePrescriptionRefund, prescriptionRefundTotal, type PrescriptionRefundInput } from './prescription-refund.js';
import type { RefundRecord } from '../../repositories/ports/payment.port.js';
import { refundFixture } from './prescription-refund.fixture.js';

function request(preview: ReturnType<typeof prescriptionRefundPreview>, patch: Partial<PrescriptionRefundInput> = {}): PrescriptionRefundInput {
  return { requestId: 'request-1', previewVersion: preview.previewVersion, medicines: [{ orderLineId: 'line1', quantity: 1 }], dispensingPercent: 0, deliveryPercent: 0, ...patch };
}
test('£150 payment refunds only Rx1 medicines by default; fee overrides are explicit', () => {
  const preview = prescriptionRefundPreview(refundFixture());
  assert.deepEqual(preview.medicines.map(row => row.orderLineId), ['line1']);
  const refund = composePrescriptionRefund(preview, request(preview));
  assert.equal(prescriptionRefundTotal(refund), 8500);
  assert.equal(preview.availablePence - prescriptionRefundTotal(refund), 6500);
  assert.equal(preview.availablePence - prescriptionRefundTotal(composePrescriptionRefund(preview, request(preview, { dispensingPercent: 50 }))), 6000);
});
test('same product on active Rx2 cannot be selected or refunded', () => {
  const data = refundFixture(); const preview = prescriptionRefundPreview(data);
  assert.throws(() => composePrescriptionRefund(preview, request(preview, { medicines: [{ orderLineId: 'line2', quantity: 1 }] })), /not refundable/);
  assert.throws(() => prescriptionRefundPreview({ ...data, prescriptionId: 'rx2' }), /confirm.*cancellation/);
});
test('subsequent refunds use remaining medicine quantities and shared fees', () => {
  const data = refundFixture(); let preview = prescriptionRefundPreview(data);
  const breakdown = composePrescriptionRefund(preview, request(preview, { dispensingPercent: 50 }));
  data.refunds = [{ id: 'refund1', paymentId: 'payment', orderId: 'order', organisationId: 'org', prescriptionId: 'rx1', amountPence: 9000, status: 'COMPLETED', breakdown }];
  data.allocations[0].amountPence = 6000;
  data.order.quoteSnapshot.curaleafSubOrders.rx2.purchaseOrderState = 'CANCELLED';
  preview = prescriptionRefundPreview({ ...data, prescriptionId: 'rx2' });
  assert.equal(preview.dispensing.remainingPence, 500);
  assert.equal(preview.availablePence, 6000);
  assert.throws(() => composePrescriptionRefund(preview, request(preview, { dispensingPercent: 100, medicines: [{ orderLineId: 'line2', quantity: 1 }] })), /remaining charge/);
  const second = composePrescriptionRefund(preview, request(preview, { dispensingPercent: 50, deliveryPercent: 100, medicines: [{ orderLineId: 'line2', quantity: 1 }] }));
  assert.equal(prescriptionRefundTotal(second), 6000);
  assert.equal(prescriptionRefundPreview(data).medicines[0]!.quantity, 0);
});
test('pending and uncertain refunds reserve medicine quantities and fees', () => {
  const data = refundFixture(); const preview = prescriptionRefundPreview(data);
  const breakdown = composePrescriptionRefund(preview, request(preview));
  data.refunds = [{ id: 'refund', paymentId: 'payment', prescriptionId: 'rx1', status: 'RECONCILIATION_REQUIRED', amountPence: 8500, breakdown } as RefundRecord];
  data.payment.pendingRefundId = 'refund';
  const reserved = prescriptionRefundPreview(data);
  assert.equal(reserved.reservedPence, 8500); assert.equal(reserved.availablePence, 6500);
  assert.equal(reserved.medicines[0]!.quantity, 0);
  assert.throws(() => composePrescriptionRefund(reserved, request(reserved)), /awaiting confirmation/);
});
test('partially supplied packs and stale previews cannot be refunded', () => {
  const data = refundFixture();
  data.lines[0].quantity = 2; data.lines[0].fixedPatientPricePence = 4250;
  data.order.quoteSnapshot.curaleafSubOrders.rx1.lines[0] = { productId: 'same-product', ordered: 2, shipped: 1, received: 1 };
  const preview = prescriptionRefundPreview(data);
  assert.equal(preview.medicines[0]!.quantity, 1);
  assert.throws(() => composePrescriptionRefund(preview, request(preview, { medicines: [{ orderLineId: 'line1', quantity: 2 }] })), /not refundable/);
  assert.throws(() => composePrescriptionRefund(preview, request(preview, { previewVersion: 'old' })), /balance changed/);
});
test('legacy refunds, unknown dispatch and replacement funding fail closed', () => {
  const data = refundFixture();
  assert.throws(() => prescriptionRefundPreview({ ...data, refunds: [{ id: 'old', paymentId: 'payment', amountPence: 20, status: 'COMPLETED' } as RefundRecord] }), /earlier refund/);
  assert.throws(() => prescriptionRefundPreview({ ...data, allocations: [...data.allocations, { sourceOrderId: 'order' } as any] }), /replacement/);
  data.order.quoteSnapshot.curaleafSubOrders.rx1.lines = [];
  assert.throws(() => prescriptionRefundPreview(data), /quantities.*unavailable/);
});
test('fee shares round once to pennies and cannot exceed balance', () => {
  const data = refundFixture(); data.order.dispensingFeePence = 999;
  const preview = prescriptionRefundPreview(data);
  assert.equal(composePrescriptionRefund(preview, request(preview, { dispensingPercent: 25 })).dispensingFeePence, 250);
  assert.throws(() => composePrescriptionRefund(preview, request(preview, { dispensingPercent: 13 })), /supported/);
  assert.throws(() => composePrescriptionRefund(preview, request(preview, { medicines: [{ orderLineId: 'line1', quantity: 1 }, { orderLineId: 'line1', quantity: 1 }] })), /once/);
});
