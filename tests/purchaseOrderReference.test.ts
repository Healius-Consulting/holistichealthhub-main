import assert from 'node:assert/strict';
import test from 'node:test';
import { purchaseOrderReference } from '../src/utils/purchaseOrderReference.ts';

test('uses the real Curaleaf purchase-order id rather than an HHH customer reference', () => {
  assert.equal(
    purchaseOrderReference('55765734-2536-4e66-9b34-4a57e7e4fc8a', 'ORD-MTDXL5AT-9D5144077D'),
    '55765734-2536-4e66-9b34-4a57e7e4fc8a',
  );
});

test('keeps draft and pre-placement prescriptions free of invented PO references', () => {
  assert.equal(purchaseOrderReference(undefined, null, '  '), null);
});
