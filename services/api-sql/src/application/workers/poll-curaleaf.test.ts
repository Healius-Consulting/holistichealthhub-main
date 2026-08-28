import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import { resolveOrdersForCuraleafEntity } from './poll-curaleaf-match.js';

function order(partial: Partial<OrderRecord> & { id: string }): OrderRecord {
  return {
    organisationId: 'org-1',
    patientId: 'patient-1',
    draftId: null,
    orderNumber: `ORD-${partial.id.slice(0, 4)}`,
    status: 'PROCESSING',
    paymentStatus: 'PAID',
    fulfilmentStatus: 'SUPPLIER_PROCESSING',
    paymentRoute: 'MANUAL',
    currency: 'GBP',
    medicineTotalPence: 1000,
    dispensingFeePence: 0,
    pharmacyDeliveryPence: 0,
    deliveryPence: 0,
    taxPence: 0,
    totalPence: 1000,
    quoteSnapshot: null,
    version: 1,
    submittedAt: '2026-08-01T10:00:00.000Z',
    paidAt: '2026-08-01T11:00:00.000Z',
    collectedAt: null,
    cancelledAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T11:00:00.000Z',
    ...partial,
  };
}

describe('resolveOrdersForCuraleafEntity', () => {
  it('loads matched orders by OrderPrescription supplier purchase-order id first', async () => {
    const matched = order({ id: 'sql-order' });
    let scanned = false;
    const found = await resolveOrdersForCuraleafEntity(
      'org-1',
      ['sql-order'],
      {
        orderRepo: {
          async findOrderById(id: string) {
            return id === 'sql-order' ? matched : null;
          },
          async listTenantOrders() {
            scanned = true;
            return [order({ id: 'snapshot-order' })];
          },
        } as any,
      },
      () => true,
    );
    assert.deepEqual(found.map(row => row.id), ['sql-order']);
    assert.equal(scanned, false);
  });

  it('falls back to snapshot customerReference matching when SQL has no row', async () => {
    const snapshotOrder = order({
      id: 'snapshot-order',
      orderNumber: 'ORD-FALLBACK',
      quoteSnapshot: { curaleaf: { purchaseOrderId: 'po-from-snapshot' } },
    });
    const found = await resolveOrdersForCuraleafEntity(
      'org-1',
      [],
      {
        orderRepo: {
          async findOrderById() { return null; },
          async listTenantOrders() { return [snapshotOrder, order({ id: 'other' })]; },
        } as any,
      },
      candidate => candidate.id === 'snapshot-order',
    );
    assert.deepEqual(found.map(row => row.id), ['snapshot-order']);
  });
});
