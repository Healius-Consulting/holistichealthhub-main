import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toPortalOrderDraft } from './pharmacy-contracts.js';
import type { OrderDraftRecord } from '../../repositories/ports/order.port.js';

describe('Order Drafts and Prescription Files Lifecycle', () => {
  it('correctly projects an order draft with safe defaults for null/empty payload', () => {
    const rawDraft: OrderDraftRecord = {
      id: '00000000-0000-4000-a000-000000000010',
      organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
      patientId: null,
      status: 'DRAFT',
      paymentStatus: 'NONE',
      pharmacyDeliveryEnabledAtCreation: false,
      payload: null,
      version: 1,
      createdAt: '2026-08-17T02:00:00.000Z',
      updatedAt: '2026-08-17T02:00:00.000Z',
    };

    const projected = toPortalOrderDraft(rawDraft);
    assert.equal(projected.id, '00000000-0000-4000-a000-000000000010');
    assert.equal(projected.patientId, null);
    assert.equal(projected.status, 'draft');
    assert.deepEqual(projected.payload, {});
  });

  it('correctly projects an order draft containing prescriptions and payment route', () => {
    const rawDraft: OrderDraftRecord = {
      id: '00000000-0000-4000-a000-000000000011',
      organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
      patientId: '00000000-0000-4000-a000-000000000001',
      status: 'DRAFT',
      paymentStatus: 'NONE',
      pharmacyDeliveryEnabledAtCreation: false,
      payload: {
        prescriptions: [
          {
            id: 1000001,
            copyFileName: 'rx1.pdf',
            fileId: 'file-123',
            items: [{ productId: 'prod-1', qty: 2 }],
          },
        ],
        dispensingFeePence: 500,
        paymentRoute: 'worldpay',
      },
      version: 2,
      createdAt: '2026-08-17T02:00:00.000Z',
      updatedAt: '2026-08-17T02:05:00.000Z',
    };

    const projected = toPortalOrderDraft(rawDraft);
    assert.equal(projected.id, '00000000-0000-4000-a000-000000000011');
    assert.equal(projected.patientId, '00000000-0000-4000-a000-000000000001');
    assert.equal((projected.payload as any).paymentRoute, 'worldpay');
    assert.equal(Array.isArray((projected.payload as any).prescriptions), true);
    assert.equal((projected.payload as any).prescriptions.length, 1);
  });
});
