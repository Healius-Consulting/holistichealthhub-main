import assert from 'node:assert/strict';
import test from 'node:test';

import { planFalseRejectionRepair } from './false-rejection-repair.js';

const order = {
  id: '6a0c090c-6c58-47e4-9ab9-d1b223e8e6ca',
  organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
  orderNumber: 'ORD-MT9EHKX0',
  status: 'CANCELLED',
  paymentStatus: 'PAID',
  fulfilmentStatus: 'EXCEPTION',
  paidAt: '2026-08-25T10:00:00.000Z',
  quoteSnapshot: {
    quote: { patientTotalPence: 10000 },
    curaleaf: { prescriberId: 'supplier-prescriber-1', status: 'prescription_closed' },
    curaleafCancellation: { reference: 'curaleaf_prescription_rejected', status: 'confirmed' },
    cancellation: { status: 'refund_required' },
    refund: { status: 'required' },
  },
};

test('repairs only the local false rejection and keeps the settled quote', () => {
  const plan = planFalseRejectionRepair({
    order,
    expectedOrderNumber: order.orderNumber,
    expectedOrganisationId: order.organisationId,
    payments: [{ status: 'PAID' }],
    refunds: [],
    operations: [{ operationType: 'post_prescription', status: 'FAILED' }],
    now: '2026-08-26T02:30:00.000Z',
  });

  assert.equal(plan.eligible, true);
  if (!plan.eligible) return;
  assert.equal(plan.nextOrderStatus, 'PROCESSING');
  assert.equal(plan.nextPaymentStatus, 'PAID');
  assert.equal(plan.nextFulfilmentStatus, 'SUPPLIER_PENDING');
  assert.deepEqual(plan.nextSnapshot.quote, { patientTotalPence: 10000 });
  assert.equal(plan.nextSnapshot.cancellation, undefined);
  assert.equal(plan.nextSnapshot.curaleafCancellation, undefined);
  assert.equal(plan.nextSnapshot.refund, undefined);
  assert.equal((plan.nextSnapshot.curaleaf as { prescriberState: string }).prescriberState, 'UNVERIFIED');
});

test('accepts the compact UUID format returned by Data Connect', () => {
  const plan = planFalseRejectionRepair({
    order: { ...order, organisationId: order.organisationId.replaceAll('-', '') },
    expectedOrderNumber: order.orderNumber,
    expectedOrganisationId: order.organisationId,
    payments: [{ status: 'PAID' }],
    refunds: [],
    operations: [],
  });

  assert.equal(plan.eligible, true);
});

test('fails closed if a refund or supplier prescription already exists', () => {
  const plan = planFalseRejectionRepair({
    order: {
      ...order,
      quoteSnapshot: {
        ...(order.quoteSnapshot as object),
        curaleaf: { prescriberId: 'supplier-prescriber-1', prescriptionId: 'rx-1' },
      },
    },
    expectedOrderNumber: order.orderNumber,
    expectedOrganisationId: order.organisationId,
    payments: [{ status: 'PAID' }],
    refunds: [{ status: 'PENDING_CONFIRMATION' }],
    operations: [],
  });

  assert.equal(plan.eligible, false);
  assert.deepEqual(new Set(plan.reasons), new Set([
    'refund_already_started',
    'supplier_prescription_already_exists',
  ]));
});

test('fails closed if a successful supplier operation returned an id', () => {
  const plan = planFalseRejectionRepair({
    order,
    expectedOrderNumber: order.orderNumber,
    expectedOrganisationId: order.organisationId,
    payments: [{ status: 'PAID' }],
    refunds: [],
    operations: [{ operationType: 'post_prescription', status: 'SUCCEEDED', responsePayload: { id: 'rx-2' } }],
  });

  assert.equal(plan.eligible, false);
  assert.ok(plan.reasons.includes('successful_supplier_clinical_operation_exists'));
});
