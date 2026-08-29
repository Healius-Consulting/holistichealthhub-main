import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { worldpayPaymentDisposition } from './worldpay-reconciliation.js';
import { paidWorldpayOrderNeedsPlacement, shouldPlaceWorldpayOrderAfterReconcile } from './worldpay-settlement.js';

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

  it('places Curaleaf only after a pending payment has been marked paid', () => {
    assert.equal(shouldPlaceWorldpayOrderAfterReconcile('PENDING', 'PAID'), true);
    assert.equal(shouldPlaceWorldpayOrderAfterReconcile('PENDING', 'FAILED'), false);
    assert.equal(shouldPlaceWorldpayOrderAfterReconcile('PAID', 'PAID'), false);
  });

  it('retries placement for paid Worldpay orders that still need a purchase order', () => {
    assert.equal(paidWorldpayOrderNeedsPlacement({
      id: 'order-1',
      orderNumber: 'HHH-1',
      paymentRoute: 'WORLDPAY',
      paymentStatus: 'PAID',
      paidAt: '2026-08-29T03:00:00.000Z',
      quoteSnapshot: { prescriptions: [{ id: 'rx-1' }] },
    }), true);
    assert.equal(paidWorldpayOrderNeedsPlacement({
      id: 'order-1',
      orderNumber: 'HHH-1',
      paymentRoute: 'WORLDPAY',
      paymentStatus: 'PAID',
      paidAt: '2026-08-29T03:00:00.000Z',
      quoteSnapshot: {
        prescriptions: [{ id: 'rx-1' }],
        curaleafSubOrders: { 'rx-1': { id: 'po-1', purchaseOrderId: 'po-1' } },
      },
    }), false);
    assert.equal(paidWorldpayOrderNeedsPlacement({
      id: 'order-1',
      orderNumber: 'HHH-1',
      paymentRoute: 'MANUAL',
      paymentStatus: 'PAID',
      paidAt: '2026-08-29T03:00:00.000Z',
      quoteSnapshot: { prescriptions: [{ id: 'rx-1' }] },
    }), false);
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
