import assert from 'node:assert/strict';
import test from 'node:test';
import { findTargetOrder } from '../src/utils/orderTarget.ts';

const records = [
  { order: { id: 12, backendId: '3f9c2d1e-7a4b-4c8e-9d2f-1b6a5e4c3d21' } },
  { order: { id: 101, backendId: 'sandbox-order-101' } },
  { order: { id: 205 } },
];

test('the Overview opens an order by its database id, as the API sends it', () => {
  assert.equal(findTargetOrder(records, '3f9c2d1e-7a4b-4c8e-9d2f-1b6a5e4c3d21')?.order.id, 12);
});

test('demo Overview items open their orders too', () => {
  assert.equal(findTargetOrder(records, 'sandbox-order-101')?.order.id, 101);
});

test('local order numbers still work, with or without the prescription', () => {
  assert.equal(findTargetOrder(records, '205')?.order.id, 205);
  assert.equal(findTargetOrder(records, '101-7')?.order.id, 101);
});

test('a UUID that starts with digits is never read as an order number', () => {
  const lookalike = [{ order: { id: 12345678, backendId: 'abc' } }];
  assert.equal(findTargetOrder(lookalike, '12345678-1234-4abc-8def-1234567890ab'), undefined);
});

test('an unknown key opens nothing', () => {
  assert.equal(findTargetOrder(records, 'missing'), undefined);
  assert.equal(findTargetOrder(records, '999'), undefined);
});
