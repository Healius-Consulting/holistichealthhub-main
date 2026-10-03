import assert from 'node:assert/strict';
import test from 'node:test';
import { linePriceError, nudgePatientPricePence } from '../src/utils/commercial.ts';

test('price steps stop on the existing wholesale floor and 10% catalogue cap', () => {
  const rrp = 8_500;
  const wholesale = 6_800;
  const cap = nudgePatientPricePence(9_000, 10, rrp, wholesale);
  assert.equal(cap, 9_350);
  assert.equal(linePriceError(cap, rrp, wholesale), null);
  assert.equal(nudgePatientPricePence(cap, 1, rrp, wholesale), cap);

  const floor = nudgePatientPricePence(6_900, -10, rrp, wholesale);
  assert.equal(floor, wholesale);
  assert.equal(linePriceError(floor, rrp, wholesale), null);
  assert.equal(nudgePatientPricePence(floor, -1, rrp, wholesale), floor);
  assert.match(linePriceError(floor - 1, rrp, wholesale) ?? '', /wholesale/);
});

test('a step inside the band moves by exactly that many pounds', () => {
  assert.equal(nudgePatientPricePence(9_000, 1, 8_500, 6_800), 9_100);
  assert.equal(nudgePatientPricePence(9_000, -5, 8_500, 6_800), 8_500);
});
