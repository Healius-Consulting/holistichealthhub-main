import assert from 'node:assert/strict';
import test from 'node:test';
import { businessOrderReference, prescriptionReference, pharmacyReferencePrefix } from '../src/utils/orderReference.ts';
import type { BusinessReferenceOrder } from '../src/utils/orderReference.ts';

const order = (patch: Partial<BusinessReferenceOrder>): BusinessReferenceOrder => ({
  id: 7,
  payment: { status: 'none' },
  ...patch,
});

test('draft and committed references use durable business identity', () => {
  assert.equal(businessOrderReference(order({})), 'Draft');
  assert.equal(businessOrderReference(order({ draftId: '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })), 'Draft');
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

test('pharmacy references match the supplier code and retain prescription suffixes', () => {
  const sample = order({ payment: { status: 'paid' }, organisationId: 'org-1', orderNumber: 'ORD-MTSPRZ6G-382166C694' });
  assert.equal(businessOrderReference(sample), `#${pharmacyReferencePrefix('org-1')}-382166C694`);
  assert.equal(prescriptionReference(sample, 1), `${pharmacyReferencePrefix('org-1')}-382166C694-P2`);
  sample.prescriptions = [{ customerReference: '1DZ-382166C694-P1' }, { customerReference: '1DZ-382166C694-P2' }];
  assert.equal(businessOrderReference(sample), '#1DZ-382166C694');
  assert.equal(prescriptionReference(sample, 1), '1DZ-382166C694-P2');
});

test('legacy shared supplier references do not label every card as P2 or P3', () => {
  for (const count of [2, 3]) {
    const sample = order({
      payment: { status: 'paid' },
      prescriptions: Array.from({ length: count }, () => ({ customerReference: `1DZ-81DB74B60D-P${count}` })),
    });
    assert.deepEqual(sample.prescriptions!.map((_, index) => prescriptionReference(sample, index)),
      Array.from({ length: count }, (_, index) => `1DZ-81DB74B60D-P${index + 1}`));
  }
});

test('distinct supplier references survive a different display order', () => {
  const sample = order({ payment: { status: 'paid' }, prescriptions: [
    { customerReference: '1DZ-81DB74B60D-P2' }, { customerReference: '1DZ-81DB74B60D-P1' },
  ] });
  assert.equal(prescriptionReference(sample, 0), '1DZ-81DB74B60D-P2');
  assert.equal(prescriptionReference(sample, 1), '1DZ-81DB74B60D-P1');
});
