import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalChargeVisible, orderPricingTotals, validOptionalChargePence } from '../src/utils/pricing.ts';

test('shared ledger keeps Curaleaf Delivery supplier-side', () => {
  assert.deepEqual(orderPricingTotals({
    medicinePence: 17_000,
    dispensingPence: 500,
    pharmacyDeliveryPence: 1_000,
    wholesalePence: 13_600,
    curaleafDeliveryPence: 500,
  }), {
    medicinePence: 17_000,
    dispensingPence: 500,
    pharmacyDeliveryPence: 1_000,
    wholesalePence: 13_600,
    curaleafDeliveryPence: 500,
    patientTotalPence: 18_500,
    pharmacyTotalPence: 14_100,
    grossMarginPence: 4_400,
  });
});

test('optional ledger lines are shown only for nonzero charges', () => {
  assert.equal(optionalChargeVisible(0), false);
  assert.equal(optionalChargeVisible(undefined), false);
  assert.equal(optionalChargeVisible(1), true);
});

test('optional charges accept integer pence from £0 through £15', () => {
  assert.equal(validOptionalChargePence(0), true);
  assert.equal(validOptionalChargePence(1_500), true);
  assert.equal(validOptionalChargePence(-1), false);
  assert.equal(validOptionalChargePence(1_501), false);
  assert.equal(validOptionalChargePence(10.5), false);
});
