import assert from 'node:assert/strict';
import test from 'node:test';
import { businessOrderReference } from '../src/utils/orderReference.ts';
import type { BusinessReferenceOrder } from '../src/utils/orderReference.ts';

const order = (patch: Partial<BusinessReferenceOrder>): BusinessReferenceOrder => ({
  id: 7,
  payment: { status: 'none' },
  ...patch,
});

test('draft and committed references use durable business identity', () => {
  assert.equal(businessOrderReference(order({})), 'Draft');
  assert.equal(businessOrderReference(order({ draftId: '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })), 'Draft · 12345678');
  assert.equal(businessOrderReference(order({ payment: { status: 'sent' }, orderNumber: 'ORD-M5-ABC' })), '#ORD-M5-ABC');
  assert.equal(businessOrderReference(order({ payment: { status: 'sent' }, backendId: 'abcdef12-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })), '#ABCDEF12');
});

test('replacement references use the root business number plus sequence suffix', () => {
  assert.equal(businessOrderReference(order({
    payment: { status: 'paid' },
    orderNumber: 'ORD-REPLACEMENT',
    redoContext: { rootOrderNumber: 'ORD-ROOT', replacementSequence: 2 },
  })), '#ORD-ROOTB');
});
