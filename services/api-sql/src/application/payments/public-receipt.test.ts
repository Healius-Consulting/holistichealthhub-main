import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPublicPaymentReceipt } from './public-receipt.js';

describe('buildPublicPaymentReceipt', () => {
  const payment = {
    id: 'pay-1',
    amountPence: 8500,
    currency: 'GBP',
    status: 'PAID',
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:05:00.000Z',
  };

  it('returns a paid receipt with the order number when no refunds completed', () => {
    assert.deepEqual(buildPublicPaymentReceipt({
      payment,
      orderNumber: 'ORD-SBX-108',
      completedRefunds: [],
    }), {
      id: 'pay-1',
      amountPence: 8500,
      currency: 'GBP',
      status: 'paid',
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:05:00.000Z',
      orderNumber: 'ORD-SBX-108',
      refundedAmountPence: null,
      partial: false,
    });
  });

  it('marks a full completed refund as refunded', () => {
    const body = buildPublicPaymentReceipt({
      payment: { ...payment, status: 'REFUNDED' },
      orderNumber: 'ORD-SBX-109',
      completedRefunds: [{ paymentId: 'pay-1', amountPence: 8500, status: 'COMPLETED' }],
    });
    assert.equal(body.status, 'refunded');
    assert.equal(body.refundedAmountPence, 8500);
    assert.equal(body.partial, false);
  });

  it('marks a smaller completed refund as partial while keeping paid payment status', () => {
    const body = buildPublicPaymentReceipt({
      payment,
      orderNumber: 'ORD-SBX-110',
      completedRefunds: [{ paymentId: 'pay-1', amountPence: 2500, status: 'COMPLETED' }],
    });
    assert.equal(body.status, 'paid');
    assert.equal(body.refundedAmountPence, 2500);
    assert.equal(body.partial, true);
  });

  it('breaks the amount into medicine and the pharmacy charges that were applied', () => {
    const body = buildPublicPaymentReceipt({
      payment,
      orderNumber: 'ORD-SBX-111',
      order: { medicineTotalPence: 7000, dispensingFeePence: 1000, pharmacyDeliveryPence: 500, deliveryPence: 0 },
      completedRefunds: [],
    });
    assert.deepEqual(body.breakdown, [
      { key: 'medicine', label: 'Medicine', amountPence: 7000 },
      { key: 'dispensing', label: 'Dispensing Cost', amountPence: 1000 },
      { key: 'pharmacyDelivery', label: 'Pharmacy Delivery', amountPence: 500 },
    ]);
  });

  it('omits pharmacy charges the pharmacy did not apply', () => {
    const body = buildPublicPaymentReceipt({
      payment,
      order: { medicineTotalPence: 8500, dispensingFeePence: 0, pharmacyDeliveryPence: 0, deliveryPence: 0 },
    });
    assert.deepEqual(body.breakdown, [{ key: 'medicine', label: 'Medicine', amountPence: 8500 }]);
  });

  it('includes supplier delivery when legacy pricing charged the patient for it', () => {
    const body = buildPublicPaymentReceipt({
      payment,
      order: { medicineTotalPence: 7000, dispensingFeePence: 1000, pharmacyDeliveryPence: 0, deliveryPence: 500 },
    });
    assert.deepEqual(body.breakdown, [
      { key: 'medicine', label: 'Medicine', amountPence: 7000 },
      { key: 'dispensing', label: 'Dispensing Cost', amountPence: 1000 },
      { key: 'delivery', label: 'Delivery', amountPence: 500 },
    ]);
  });

  it('drops the breakdown when the parts do not reconcile with the amount charged', () => {
    const body = buildPublicPaymentReceipt({
      payment,
      order: { medicineTotalPence: 6000, dispensingFeePence: 1000, pharmacyDeliveryPence: 0, deliveryPence: 0 },
    });
    assert.equal(body.breakdown, undefined);
  });

  it('has no breakdown when the order could not be read', () => {
    assert.equal(buildPublicPaymentReceipt({ payment, order: null }).breakdown, undefined);
  });

  it('ignores refunds for other payments and open refund tasks', () => {
    const body = buildPublicPaymentReceipt({
      payment,
      completedRefunds: [
        { paymentId: 'pay-2', amountPence: 8500, status: 'COMPLETED' },
        { paymentId: 'pay-1', amountPence: 1000, status: 'PENDING_CONFIRMATION' },
      ],
    });
    assert.equal(body.refundedAmountPence, null);
    assert.equal(body.partial, false);
  });
});
