import assert from 'node:assert/strict';
import test from 'node:test';
import { orderAllowsManualCancellation, orderMoneyWasTaken, stampUnpaidManualCancellation } from './paid-refund.js';

test('manual pharmacy cancellation is limited to explicit unpaid states', () => {
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'NONE', paidAt: null }), true);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'PENDING', paidAt: null }), true);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'FAILED', paidAt: null }), true);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'CANCELLED', paidAt: null }), false);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'unexpected', paidAt: null }), false);
});

test('paidAt fails closed even while the payment status is lagging', () => {
  assert.equal(orderMoneyWasTaken({ paymentStatus: 'PENDING', paidAt: '2026-08-28T00:00:00.000Z' }), true);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'PENDING', paidAt: '2026-08-28T00:00:00.000Z' }), false);
});

test('settled and refund states cannot use direct pharmacy cancellation', () => {
  for (const paymentStatus of ['PAID', 'REFUND_REQUIRED', 'REFUNDED']) {
    assert.equal(orderAllowsManualCancellation({ paymentStatus, paidAt: null }), false);
  }
});

test('unpaid manual cancellation closes without creating refund or Curaleaf work', () => {
  const snapshot = stampUnpaidManualCancellation({
    quoteReview: { status: 'required' },
    cancellation: { note: 'Prior note' },
  }, {
    reason: 'patient_request',
    actorUid: 'staff-1',
    now: '2026-08-28T01:00:00.000Z',
  });

  assert.deepEqual(snapshot.cancellation, {
    status: 'cancelled',
    reason: 'patient_request',
    note: 'Prior note',
    requestedAt: '2026-08-28T01:00:00.000Z',
    requestedBy: 'staff-1',
  });
  assert.equal(snapshot.curaleafCancellation, null);
  assert.equal(snapshot.quoteReview, null);
});
