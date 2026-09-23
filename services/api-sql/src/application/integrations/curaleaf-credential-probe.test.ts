import assert from 'node:assert/strict';
import test from 'node:test';
import { unexpectedCuraleafCustomerId } from './curaleaf.service.js';

test('a formula page cannot contradict the customer ID, because formulas omit it', () => {
  assert.equal(unexpectedCuraleafCustomerId({
    formulas: [{ id: 'f1', printedName: 'Flower', state: 'ACTIVE', unit: 'g' }],
    totalRecordCount: 1,
  }, 'PHAR1'), null);
});

test('a product page confirms the customer on the key', () => {
  assert.equal(unexpectedCuraleafCustomerId({
    products: [{ id: 'p1', customerId: 'PHAR1', formulaId: 'f1' }],
    totalRecordCount: 1,
  }, 'PHAR1'), null);
});

test('a product for another pharmacy is the mismatch that used to be saved', () => {
  assert.equal(unexpectedCuraleafCustomerId({
    products: [{ id: 'p1', customerId: 'PHAR9', formulaId: 'f1' }],
    totalRecordCount: 1,
  }, 'PHAR1'), 'PHAR9');
});

test('an empty product page does not invent a mismatch', () => {
  assert.equal(unexpectedCuraleafCustomerId({
    products: [],
    totalRecordCount: 0,
  }, 'PHAR1'), null);
});
