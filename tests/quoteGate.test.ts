import assert from 'node:assert/strict';
import test from 'node:test';
import type { CuraleafQuoteCheckSummary } from '../src/shared/contracts.ts';
import { visiblePaymentGateCheck } from '../src/utils/quoteGate.ts';

function check(status: CuraleafQuoteCheckSummary['status'], checkedAt: string): CuraleafQuoteCheckSummary {
  return {
    id: `${status}-${checkedAt}`,
    phase: 'PRE_PAYMENT',
    status,
    checkedAt,
    basketFingerprint: 'basket',
    patientTotalPence: 10_000,
    wholesaleTotalPence: 5_000,
    shippingPence: 0,
    stockAvailable: true,
  };
}

test('a latest MATCHED check hides the Payment Gate summary', () => {
  assert.equal(visiblePaymentGateCheck([
    check('CHANGED', '2026-08-27T09:00:00.000Z'),
    check('MATCHED', '2026-08-27T10:00:00.000Z'),
  ]), null);
});

test('the latest non-matched check remains actionable', () => {
  assert.equal(visiblePaymentGateCheck([
    check('MATCHED', '2026-08-27T09:00:00.000Z'),
    check('OUT_OF_STOCK', '2026-08-27T10:00:00.000Z'),
  ])?.status, 'OUT_OF_STOCK');
});
