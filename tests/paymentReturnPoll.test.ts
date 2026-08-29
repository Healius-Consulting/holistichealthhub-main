import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAYMENT_RETURN_GIVE_UP_MS,
  paymentReturnNextGapMs,
  paymentReturnShouldKeepPolling,
  paymentReturnWaitCopy,
} from '../src/utils/paymentReturnPoll.ts';

test('the success page keeps polling through Worldpay’s documented 60s query window', () => {
  assert.equal(paymentReturnShouldKeepPolling(0), true);
  assert.equal(paymentReturnShouldKeepPolling(12_000), true);
  assert.equal(paymentReturnShouldKeepPolling(59_999), true);
  assert.equal(paymentReturnShouldKeepPolling(PAYMENT_RETURN_GIVE_UP_MS), false);
});

test('wait copy stays patient-facing and tracks elapsed time, not a 9s give-up', () => {
  assert.equal(paymentReturnWaitCopy(0), 'Contacting the payment gateway…');
  assert.equal(paymentReturnWaitCopy(8_000), 'Confirming your payment with Worldpay…');
  assert.equal(paymentReturnWaitCopy(30_000), 'Worldpay is still confirming clearance…');
  assert.equal(paymentReturnWaitCopy(50_000), 'Still waiting for Worldpay to confirm…');
});

test('the next poll waits the remaining window instead of overlapping the previous request', () => {
  assert.equal(paymentReturnNextGapMs(0), 2_000);
  assert.equal(paymentReturnNextGapMs(59_000), 1_000);
  assert.equal(paymentReturnNextGapMs(60_000), 0);
});
