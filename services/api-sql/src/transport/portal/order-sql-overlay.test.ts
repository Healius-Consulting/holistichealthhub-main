import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrderLineRecord } from '../../repositories/ports/order-line.port.js';
import type { PaymentAllocationRecord, QuoteCheckRecord, RefundRecord } from '../../repositories/ports/payment.port.js';
import { latestPaymentAllocation, latestRefund, mapPortalOrderFromSql, sqlLinesToPortal } from './order-sql-overlay.js';

const order: OrderRecord = {
  id: '00000000-0000-4000-a000-000000000002',
  organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
  patientId: '00000000-0000-4000-a000-000000000001',
  draftId: null,
  orderNumber: 'ORD-1001',
  status: 'CANCELLED',
  paymentStatus: 'REFUND_REQUIRED',
  fulfilmentStatus: 'EXCEPTION',
  paymentRoute: 'MANUAL',
  currency: 'GBP',
  medicineTotalPence: 10000,
  dispensingFeePence: 500,
  deliveryPence: 0,
  taxPence: 0,
  totalPence: 10500,
  quoteSnapshot: {
    lineItems: [{ packId: 'snap-pack', productId: 'snap-pack', name: 'Snapshot pack', quantity: 1, unitPricePence: 100 }],
    refund: { id: 'snapshot-refund', status: 'pending_confirmation' },
  },
  version: 1,
  submittedAt: '2026-08-01T10:00:00.000Z',
  paidAt: '2026-08-01T11:00:00.000Z',
  collectedAt: null,
  cancelledAt: '2026-08-01T12:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T12:00:00.000Z',
};

describe('SQL order overlay', () => {
  it('maps GET list and default GET by id from SQL children without a live Curaleaf fetch', () => {
    const routerSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'order.router.ts'), 'utf8');
    const listSrc = routerSrc.match(/router\.get\('\/portal\/orders',[\s\S]*?router\.get\('\/portal\/orders\/:id'/ )?.[0];
    const getByIdSrc = routerSrc.match(/router\.get\('\/portal\/orders\/:id',[\s\S]*?router\.post\('\/portal\/orders\/:id\/prescriptions/ )?.[0];
    assert.ok(listSrc, 'GET /portal/orders handler is present');
    assert.ok(getByIdSrc, 'GET /portal/orders/:id handler is present');
    assert.equal(listSrc.includes('fetchCuraleafPurchaseOrders'), false);
    assert.equal(listSrc.includes('fetchCuraleafShipments'), false);
    assert.equal(listSrc.includes('mapPortalOrderFromSql'), true);
    assert.equal(getByIdSrc.includes('fetchCuraleafPurchaseOrders'), false);
    assert.equal(getByIdSrc.includes('fetchCuraleafShipments'), false);
    assert.equal(getByIdSrc.includes('mapPortalOrderFromSql'), true);
  });

  it('uses the newest SQL refund and quoted SQL lines on the portal contract', () => {
    const refunds: RefundRecord[] = [
      {
        id: 'older',
        organisationId: order.organisationId,
        orderId: order.id,
        paymentId: 'pay-1',
        status: 'PENDING_CONFIRMATION',
        amountPence: 10500,
        createdAt: '2026-08-01T12:00:00.000Z',
      },
      {
        id: 'newer',
        organisationId: order.organisationId,
        orderId: order.id,
        paymentId: 'pay-1',
        status: 'COMPLETED',
        amountPence: 10500,
        createdAt: '2026-08-01T13:00:00.000Z',
      },
    ];
    const lines: OrderLineRecord[] = [{
      id: 'line-1',
      orderId: order.id,
      packId: 'sql-pack',
      formulaId: 'formula-1',
      formulaName: 'SQL pack',
      quantity: 2,
      fixedPatientPricePence: 8500,
      wholesalePackPricePence: 4000,
      allocatedDispensingFeePence: 0,
      lineMedicineRevenuePence: 17000,
      placementState: 'PENDING_PLACEMENT',
    }];
    assert.equal(latestRefund(refunds)?.id, 'newer');
    const mapped = mapPortalOrderFromSql(order, { refunds, lines });
    assert.equal(mapped.refund?.id, 'newer');
    assert.equal(mapped.refund?.status, 'completed');
    assert.equal(sqlLinesToPortal(lines)[0]?.packId, 'sql-pack');
    assert.equal(mapped.lineItems[0]?.packId, 'sql-pack');
    assert.equal(mapped.lineItems[0]?.quantity, 2);
  });

  it('does not project a SQL refund while the Curaleaf purchase order is still live', () => {
    const mapped = mapPortalOrderFromSql({
      ...order,
      paymentStatus: 'REFUNDED',
      quoteSnapshot: {
        cancellation: { status: 'refund_required' },
        refund: { id: 'snapshot-refund', status: 'completed' },
        curaleaf: {
          purchaseOrderId: '2bf991a2-3bbf-43ea-ae5b-45654ae5bc4b',
          purchaseOrderState: 'CREATED',
          state: 'CREATED',
          prescriptionState: 'ACTIVE',
        },
      },
    }, {
      refunds: [{
        id: 'sql-refund',
        organisationId: order.organisationId,
        orderId: order.id,
        paymentId: 'pay-1',
        status: 'COMPLETED',
        amountPence: 10500,
        createdAt: '2026-08-16T12:00:00.000Z',
      }],
      lines: [],
    });
    assert.equal(mapped.paymentStatus, 'paid');
    assert.equal(mapped.refund, undefined);
    assert.equal(mapped.status, 'processing');
    assert.equal(mapped.curaleaf?.purchaseOrderState, 'CREATED');
  });

  it('projects durable refund verification gates without collapsing them to pending confirmation', () => {
    const verifying = mapPortalOrderFromSql(order, {
      refunds: [{
        id: 'refund-verifying',
        organisationId: order.organisationId,
        orderId: order.id,
        paymentId: 'pay-1',
        status: 'VERIFICATION_PENDING',
        amountPence: 10500,
        verificationStatus: 'worldpay_query_pending',
        createdAt: '2026-08-01T13:00:00.000Z',
      }],
      lines: [],
    });
    assert.equal(verifying.refund?.status, 'verifying');
    assert.equal(verifying.refund?.verificationReference, 'worldpay_query_pending');

    const reconciliation = mapPortalOrderFromSql(order, {
      refunds: [{
        id: 'refund-reconciliation',
        organisationId: order.organisationId,
        orderId: order.id,
        paymentId: 'pay-1',
        status: 'RECONCILIATION_REQUIRED',
        amountPence: 10500,
        verificationStatus: 'worldpay_refund_not_proven',
        createdAt: '2026-08-01T13:00:00.000Z',
      }],
      lines: [],
    });
    assert.equal(reconciliation.refund?.status, 'reconciliation_required');
  });

  it('uses authoritative SQL quote checks and the newest order payment allocation', () => {
    const quoteChecks: QuoteCheckRecord[] = [{
      id: 'quote-post',
      organisationId: order.organisationId,
      orderId: order.id,
      paymentId: 'pay-1',
      phase: 'POST_PAYMENT',
      status: 'REVIEW_REQUIRED',
      baselineQuoteCheckId: 'quote-pre',
      basketFingerprint: 'basket-a',
      quoteFingerprint: 'quote-a',
      patientTotalPence: 11000,
      wholesaleTotalPence: 7000,
      shippingPence: 500,
      taxPence: 0,
      rawQuote: {},
      comparison: { patientDeltaPence: 500 },
      createdAt: '2026-08-01T13:00:00.000Z',
    }];
    const paymentAllocations: PaymentAllocationRecord[] = [{
      id: 'allocation-old',
      organisationId: order.organisationId,
      paymentId: 'pay-1',
      orderId: order.id,
      amountPence: 5000,
      status: 'TRANSFERRED',
      version: 2,
      createdAt: '2026-08-01T11:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
    }, {
      id: 'allocation-new',
      organisationId: order.organisationId,
      paymentId: 'pay-2',
      orderId: order.id,
      sourceOrderId: 'source-order',
      amountPence: 5500,
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-08-01T12:30:00.000Z',
      updatedAt: '2026-08-01T13:30:00.000Z',
    }];

    const mapped = mapPortalOrderFromSql(order, { refunds: [], lines: [], quoteChecks, paymentAllocations });
    assert.equal(mapped.quoteChecks.length, 1);
    assert.equal(mapped.activeQuoteCheck?.id, 'quote-post');
    assert.equal(mapped.activeQuoteCheck?.status, 'CHANGED');
    assert.equal(mapped.activeQuoteCheck?.checkedAt, '2026-08-01T13:00:00.000Z');
    assert.equal(latestPaymentAllocation(paymentAllocations)?.id, 'allocation-new');
    assert.equal(mapped.paymentAllocation?.id, 'allocation-new');
    assert.equal(mapped.paymentAllocation?.sourceOrderId, 'source-order');
  });
});
