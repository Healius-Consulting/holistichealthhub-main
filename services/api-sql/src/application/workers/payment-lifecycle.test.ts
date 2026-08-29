import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderBlocksPaymentLifecycle, processPendingPaymentLifecycle, type PaymentLifecycleDeps } from './payment-lifecycle.js';

describe('payment lifecycle terminal-order guard', () => {
  it('blocks reminders for cancelled, completed, archived, and resolved orders', () => {
    assert.equal(orderBlocksPaymentLifecycle({ status: 'CANCELLED', paymentStatus: 'PENDING' }), true);
    assert.equal(orderBlocksPaymentLifecycle({ status: 'COMPLETED', paymentStatus: 'PENDING' }), true);
    assert.equal(orderBlocksPaymentLifecycle({ status: 'SUBMITTED', paymentStatus: 'PENDING', archivedAt: '2026-08-29T10:00:00.000Z' }), true);
    assert.equal(orderBlocksPaymentLifecycle({ status: 'SUBMITTED', paymentStatus: 'PENDING', resolutionStatus: 'RESOLVED' }), true);
    assert.equal(orderBlocksPaymentLifecycle({ status: 'SUBMITTED', paymentStatus: 'PENDING' }), false);
  });

  it('retires a stale pending payment instead of queuing a reminder for a cancelled order', async () => {
    const calls = { retired: 0, patientLookup: 0, queued: 0 };
    const deps = {
      paymentRepo: {
        listPendingWorldpayPayments: async () => [{
          id: 'payment-1',
          organisationId: 'organisation-1',
          orderId: 'order-1',
          status: 'PENDING',
          route: 'WORLDPAY',
          createdAt: '2026-08-27T10:00:00.000Z',
          providerPayload: {},
        }],
        cancelPendingPaymentsForOrder: async (orderId: string, organisationId: string) => {
          assert.equal(orderId, 'order-1');
          assert.equal(organisationId, 'organisation-1');
          calls.retired += 1;
        },
      },
      orderRepo: {
        findOrderById: async () => ({
          id: 'order-1',
          organisationId: 'organisation-1',
          patientId: 'patient-1',
          status: 'CANCELLED',
          paymentStatus: 'PENDING',
          quoteSnapshot: { prescriptions: [] },
        }),
      },
      patientRepo: {
        findPatientById: async () => {
          calls.patientLookup += 1;
          return { email: 'patient@example.com' };
        },
      },
      notificationRepo: {
        enqueue: async () => {
          calls.queued += 1;
          return { created: true };
        },
      },
      organisationRepo: {
        findOrganisationById: async () => null,
      },
    } as unknown as PaymentLifecycleDeps;

    const summary = await processPendingPaymentLifecycle(deps, new Date('2026-08-29T10:00:00.000Z'));

    assert.equal(summary.retired, 1);
    assert.equal(summary.reminders, 0);
    assert.deepEqual(calls, { retired: 1, patientLookup: 0, queued: 0 });
  });
});
