import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogFromPortalOrderSources, composeRefund } from './refund-composition.js';

test('portal order sources prefer SQL lines and apply charge percents', () => {
  const catalog = catalogFromPortalOrderSources({
    orderLines: [{ packId: 'pack-1', formulaName: 'Oil', quantity: 1, lineMedicineRevenuePence: 12_000 }],
    snapshotLineItems: [{ packId: 'pack-1', name: 'Stale', quantity: 1, unitPricePence: 1 }],
    dispensingFeePence: 800,
    pharmacyDeliveryPence: 400,
    paidPence: 13_200,
  });
  const composed = composeRefund(catalog, {
    scope: 'partial',
    includedMedicineIds: ['pack-1'],
    dispensingPercent: 25,
    deliveryPercent: 100,
  });
  assert.equal(composed.amountPence, 12_000 + 200 + 400);
  assert.equal(catalog.medicines[0]?.label, 'Oil');
});
