import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyShipmentSnapshot } from '../integrations/curaleaf-events.js';
import { advanceFulfilmentStatus } from '../orders/curaleaf-fulfilment.js';

/**
 * Goods-in is pharmacy authority: Curaleaf can say a consignment was dispatched, but
 * only the dispensary can say it arrived, was verified, and is ready for the patient.
 * `supplierFulfilmentStatus` cannot express READY_FOR_COLLECTION at all, so persisting
 * the supplier's view raw let a late or re-sent shipment event pull a checked-in order
 * back out of the collection queue — after the patient had already been emailed.
 */
function orderAt(fulfilmentStatus: string, received: number) {
  return {
    id: 'order-1',
    organisationId: 'org-1',
    orderNumber: 'HHH-1001',
    fulfilmentStatus,
    quoteSnapshot: {
      lineItems: [{ packId: 'p1', productId: 'p1', quantity: 2 }],
      curaleaf: {
        id: 'po-1',
        purchaseOrderId: 'po-1',
        state: 'FULLY_ALLOCATED',
        customerReference: 'HHH-1001',
        items: [{ id: 'poi-1', productId: 'p1', packsOrderedCount: 2, packsAllocatedCount: 2 }],
        shipments: [{ id: 'ship-1', purchaseOrderId: 'po-1', items: [{ purchaseOrderItemId: 'poi-1', productId: 'p1', packCount: 2 }] }],
        lines: [{ lineId: 'poi-1', purchaseOrderItemId: 'poi-1', productId: 'p1', ordered: 2, shipped: 2, received, collected: 0, remaining: 0 }],
      },
    },
  };
}

const shipment = {
  id: 'ship-1',
  purchaseOrderId: 'po-1',
  purchaseOrderCustomerReference: 'HHH-1001',
  items: [{ purchaseOrderItemId: 'poi-1', productId: 'p1', packCount: 2 }],
};

describe('Curaleaf shipment events never regress pharmacy goods-in', () => {
  it('leaves a ready-to-collect order in the collection queue', () => {
    const order = orderAt('READY_FOR_COLLECTION', 2);
    const next = applyShipmentSnapshot(order as never, shipment as never);
    // The supplier's own view has no notion of "ready", so it computes RECEIVED.
    assert.equal(next.fulfilmentStatus, 'RECEIVED');
    // What the poller persists must keep the pharmacy's higher state.
    assert.equal(advanceFulfilmentStatus(order.fulfilmentStatus, next.fulfilmentStatus), 'READY_FOR_COLLECTION');
  });

  it('leaves a collected order collected', () => {
    const order = orderAt('COLLECTED', 2);
    const next = applyShipmentSnapshot(order as never, shipment as never);
    assert.equal(advanceFulfilmentStatus(order.fulfilmentStatus, next.fulfilmentStatus), 'COLLECTED');
  });

  it('still lets a genuine supplier advance through', () => {
    const order = orderAt('SUPPLIER_ALLOCATED', 0);
    const next = applyShipmentSnapshot(order as never, shipment as never);
    assert.equal(advanceFulfilmentStatus(order.fulfilmentStatus, next.fulfilmentStatus), 'DISPATCHED_TO_PHARMACY');
  });

  it('still lets a supplier exception outrank goods-in', () => {
    // A cancelled purchase order must reach a checked-in order, not be ratcheted away.
    assert.equal(advanceFulfilmentStatus('READY_FOR_COLLECTION', 'EXCEPTION'), 'EXCEPTION');
  });

  it('preserves the dispensary pack counts across the event', () => {
    const order = orderAt('READY_FOR_COLLECTION', 2);
    const next = applyShipmentSnapshot(order as never, shipment as never);
    const lines = (next.snapshot as { curaleaf: { lines: Array<{ received: number }> } }).curaleaf.lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.received, 2, 'a supplier event must never clear a verified goods-in count');
  });
});
