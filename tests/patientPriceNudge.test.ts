import assert from 'node:assert/strict';
import test from 'node:test';
import { linePriceError, nudgePatientPricePence } from '../src/utils/commercial.ts';

test('price steps stop on the wholesale floor and the 35% margin cap', () => {
  const wholesale = 6_800;
  const cap = nudgePatientPricePence(10_400, 10, wholesale);
  assert.equal(cap, 10_461);
  assert.equal(linePriceError(cap, wholesale), null);
  assert.equal(nudgePatientPricePence(cap, 1, wholesale), cap);
  assert.match(linePriceError(cap + 1, wholesale) ?? '', /35%/);

  const floor = nudgePatientPricePence(6_900, -10, wholesale);
  assert.equal(floor, wholesale);
  assert.equal(linePriceError(floor, wholesale), null);
  assert.equal(nudgePatientPricePence(floor, -1, wholesale), floor);
  assert.match(linePriceError(floor - 1, wholesale) ?? '', /wholesale/);
});

test('a step inside the band moves by exactly that many pounds', () => {
  assert.equal(nudgePatientPricePence(9_000, 1, 6_800), 9_100);
  assert.equal(nudgePatientPricePence(9_000, -1, 6_800), 8_900);
});
