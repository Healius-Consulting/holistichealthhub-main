import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogFromOrderPence, composeRefund, defaultRefundDraft, refundCompositionError } from '../src/utils/refundComposition.ts';
import * as server from '../services/api-sql/src/application/payments/refund-composition.ts';
const { resolveStaffRefund } = server;

const catalog = catalogFromOrderPence({
  medicines: [
    { id: 'pack-a', label: 'Oil 30ml', amountPence: 10_000 },
    { id: 'pack-b', label: 'Flower 10g', amountPence: 7_000 },
  ],
  dispensingFeePence: 1_000,
  deliveryFeePence: 500,
  paidPence: 18_500,
});

test('full refund lists every medicine and pharmacy charge at the paid amount', () => {
  const composed = composeRefund(catalog, defaultRefundDraft(catalog));
  assert.equal(composed.scope, 'full');
  assert.equal(composed.amountPence, 18_500);
  assert.deepEqual(composed.lines.map(line => [line.kind, line.amountPence]), [
    ['medicine', 10_000],
    ['medicine', 7_000],
    ['dispensing', 1_000],
    ['delivery', 500],
  ]);
});

test('partial refund keeps listed medicines and applies 100 75 50 25 0 on pharmacy charges', () => {
  const composed = composeRefund(catalog, {
    scope: 'partial',
    includedMedicineIds: ['pack-a'],
    dispensingPercent: 50,
    deliveryPercent: 0,
  });
  assert.equal(composed.amountPence, 10_500);
  assert.equal(composed.lines.some(line => line.kind === 'delivery'), false);
  assert.equal(composed.lines.find(line => line.kind === 'dispensing')?.percent, 50);
  assert.equal(refundCompositionError(catalog, {
    scope: 'partial',
    includedMedicineIds: [],
    dispensingPercent: 0,
    deliveryPercent: 0,
  }), 'Choose at least one item or charge to refund.');
});

test('staff refund requires an explicit partial selection and recomputes the amount', () => {
  const catalog = catalogFromOrderPence({
    medicines: [{ id: 'pack-a', label: 'Oil 30ml', amountPence: 10_000 }],
    dispensingFeePence: 1_000,
    deliveryFeePence: 0,
    paidPence: 11_000,
  });
  assert.equal(resolveStaffRefund(catalog, { scope: 'full', amountPence: 10_000 }).error, 'The refund total does not match the selected items.');
  assert.equal(resolveStaffRefund(catalog, { scope: 'partial', amountPence: 10_000 }).error, 'Partial refunds must list which medicines to return.');
  assert.equal(resolveStaffRefund(catalog, {
    scope: 'partial',
    amountPence: 10_500,
    includedMedicineIds: ['pack-a'],
    dispensingPercent: 50,
  }).composed?.amountPence, 10_500);
});

test('full refund fails closed when the breakdown does not equal the settled payment', () => {
  const mismatched = catalogFromOrderPence({
    medicines: [{ id: 'pack-a', label: 'Oil 30ml', amountPence: 10_000 }],
    dispensingFeePence: 0,
    deliveryFeePence: 0,
    paidPence: 11_000,
  });
  assert.equal(
    refundCompositionError(mismatched, defaultRefundDraft(mismatched)),
    'The item and charge breakdown does not match the settled payment.',
  );
  assert.equal(
    resolveStaffRefund(mismatched, { scope: 'full', amountPence: 10_000 }).error,
    'The item and charge breakdown does not match the settled payment.',
  );
});

test('portal and sql refund composition agree on the same draft', () => {
  const draft = { scope: 'partial' as const, includedMedicineIds: ['pack-b'], dispensingPercent: 75 as const, deliveryPercent: 25 as const };
  assert.deepEqual(composeRefund(catalog, draft), server.composeRefund(catalog, draft));
});
