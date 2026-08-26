import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { worldpayPaymentDisposition } from './worldpay-reconciliation.js';

describe('Worldpay reconciliation safety', () => {
  it('turns a paid retired link into a refund gate', () => {
    const result = worldpayPaymentDisposition({
      localPaymentStatus: 'CANCELLED',
      providerPaymentStatus: 'paid',
      order: { status: 'SUBMITTED' },
    });
    assert.equal(result.retiredLinkPaid, true);
    assert.equal(result.nextStatus, 'refund_required');
  });

  it('turns a late payment on an archived or resolved order into a refund gate', () => {
    assert.equal(worldpayPaymentDisposition({
      localPaymentStatus: 'PENDING',
      providerPaymentStatus: 'paid',
      order: { status: 'CANCELLED', archivedAt: '2026-08-26T10:00:00.000Z', resolutionStatus: 'RESOLVED' },
    }).nextStatus, 'refund_required');
  });

  it('does not let a provider refund event bypass staff confirmation', () => {
    const result = worldpayPaymentDisposition({
      localPaymentStatus: 'PAID',
      providerPaymentStatus: 'refunded',
      order: { status: 'PROCESSING' },
    });
    assert.equal(result.providerReportsRefund, true);
    assert.equal(result.nextStatus, 'refund_required');
  });
});
