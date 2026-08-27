import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyShipmentSnapshot } from '../../application/integrations/curaleaf-events.js';
import {
  advanceFulfilmentStatus,
  applyPharmacyGoodsReceipt,
  normalisedFulfilmentLines,
} from '../../application/orders/curaleaf-fulfilment.js';
import { toPortalOrder } from './pharmacy-contracts.js';

/**
 * The seam the pharmacy actually depends on: Curaleaf reports a dispatch, the poller
 * persists it, and the portal contract has to hand the workspace enough to (a) show the
 * order as in transit and (b) let the dispensary book the packs in. If the shipment id
 * or the pack counts do not survive this trip, "Accept delivery" has nothing to act on.
 */
function baseOrder(fulfilmentStatus: string, curaleafExtra: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    organisationId: 'org-1',
    orderNumber: 'HHH-1001',
    patientId: 'patient-1',
    fulfilmentStatus,
    paymentStatus: 'PAID',
    paymentRoute: 'WORLDPAY',
    currency: 'GBP',
    totalPence: 17000,
    lifecycleStatus: 'ACTIVE',
    createdAt: '2026-08-20T09:00:00.000Z',
    submittedAt: '2026-08-20T09:00:00.000Z',
    paidAt: '2026-08-20T09:05:00.000Z',
    medicineTotalPence: 17000,
    dispensingFeePence: 0,
    quoteSnapshot: {
      lineItems: [{ packId: 'p1', productId: 'p1', quantity: 2, unitPricePence: 8500 }],
      curaleaf: {
        id: 'po-1',
        purchaseOrderId: 'po-1',
        state: 'FULLY_ALLOCATED',
        customerReference: 'HHH-1001',
        createdAt: '2026-08-21T09:00:00.000Z',
        items: [{ id: 'poi-1', productId: 'p1', packsOrderedCount: 2, packsAllocatedCount: 2 }],
        ...curaleafExtra,
      },
    },
  };
}

const dispatch = {
  id: 'ship-1',
  purchaseOrderId: 'po-1',
  purchaseOrderCustomerReference: 'HHH-1001',
  createdAt: '2026-08-22T08:00:00.000Z',
  items: [{ purchaseOrderItemId: 'poi-1', productId: 'p1', packCount: 2 }],
};

describe('Curaleaf dispatch reaches the pharmacy as something it can act on', () => {
  it('turns a shipment event into an in-transit order the dispensary can check in', () => {
    const order = baseOrder('SUPPLIER_ALLOCATED');
    const next = applyShipmentSnapshot(order as never, dispatch as never);
    const stored = {
      ...order,
      quoteSnapshot: next.snapshot,
      fulfilmentStatus: advanceFulfilmentStatus(order.fulfilmentStatus, next.fulfilmentStatus),
    };
    assert.equal(stored.fulfilmentStatus, 'DISPATCHED_TO_PHARMACY');

    const portal = toPortalOrder(stored as never);
    assert.equal(portal.fulfilmentStatus, 'dispatched_to_pharmacy');

    const flow = Object.values(portal.prescriptionFlow ?? {})[0] as {
      shipmentIds: string[];
      lines: Array<{ ordered: number; shipped: number; received: number }>;
      goodsInAt?: string | null;
    };
    // Without a shipment id the workspace refuses to record a goods receipt.
    assert.deepEqual(flow.shipmentIds, ['ship-1'], 'the shipment id must survive to the client');
    assert.equal(flow.lines[0]?.ordered, 2);
    assert.equal(flow.lines[0]?.shipped, 2, 'dispatched pack count drives the "Accept delivery (n pk)" action');
    assert.equal(flow.lines[0]?.received, 0, 'nothing is received until the dispensary says so');
    assert.equal(flow.goodsInAt, null, 'no check-in time before check-in');
  });

  it('reports a part-dispatched consignment as partially dispatched, not fully', () => {
    const order = baseOrder('SUPPLIER_ALLOCATED');
    const partial = { ...dispatch, items: [{ purchaseOrderItemId: 'poi-1', productId: 'p1', packCount: 1 }] };
    const next = applyShipmentSnapshot(order as never, partial as never);
    assert.equal(next.fulfilmentStatus, 'PARTIALLY_DISPATCHED_TO_PHARMACY');
    const portal = toPortalOrder({ ...order, quoteSnapshot: next.snapshot, fulfilmentStatus: next.fulfilmentStatus } as never);
    assert.equal(portal.fulfilmentStatus, 'partially_dispatched_to_pharmacy');
  });

  it('surfaces the dispensary check-in time, not the supplier dispatch time', () => {
    // What the goods-receipt route persists after a full check-in.
    const checkedIn = baseOrder('READY_FOR_COLLECTION', {
      shipments: [dispatch],
      shipmentIds: ['ship-1'],
      lines: [{ lineId: 'poi-1', purchaseOrderItemId: 'poi-1', productId: 'p1', ordered: 2, shipped: 2, received: 2, collected: 0, remaining: 0 }],
      goodsInAt: '2026-08-23T16:30:00.000Z',
    });
    const portal = toPortalOrder(checkedIn as never);
    const flow = Object.values(portal.prescriptionFlow ?? {})[0] as { goodsInAt?: string | null; latestShipmentAt?: string | null };
    assert.equal(flow.goodsInAt, '2026-08-23T16:30:00.000Z');
    assert.notEqual(flow.goodsInAt, flow.latestShipmentAt, 'check-in and dispatch are different facts');
    assert.equal(portal.fulfilmentStatus, 'ready_for_collection');
  });

  it('a full check-in puts the order in the collection queue, not back in partial limbo', () => {
    // Walk the real route: dispatch, then the transformation the goods-receipt handler
    // applies, then the contract the workspace reads.
    const order = baseOrder('SUPPLIER_ALLOCATED');
    const dispatched = applyShipmentSnapshot(order as never, dispatch as never);
    const curaleaf = (dispatched.snapshot as { curaleaf: Record<string, unknown> }).curaleaf;

    const { lines, shipmentStates } = applyPharmacyGoodsReceipt({
      lines: normalisedFulfilmentLines({
        purchaseOrder: curaleaf as never,
        shipments: (curaleaf.shipments ?? []) as never,
        requestedItems: [{ packId: 'p1', productId: 'p1', quantity: 2 }],
        priorLines: curaleaf.lines,
      }),
      items: [{ productId: 'p1', receivedQuantity: 2 }],
      shipmentId: 'ship-1',
      shipmentStates: (curaleaf.shipmentStates ?? {}) as Record<string, string>,
    });
    assert.equal(lines[0]?.received, 2);

    const remainingOpen = lines.some(line => line.remaining > 0 || line.received < line.ordered);
    assert.equal(remainingOpen, false, 'every ordered pack is on the shelf');

    const stored = {
      ...order,
      quoteSnapshot: {
        ...(dispatched.snapshot as Record<string, unknown>),
        curaleaf: { ...curaleaf, lines, shipmentStates, goodsInAt: '2026-08-23T10:00:00.000Z' },
      },
      fulfilmentStatus: advanceFulfilmentStatus(order.fulfilmentStatus, 'READY_FOR_COLLECTION'),
    };
    assert.equal(stored.fulfilmentStatus, 'READY_FOR_COLLECTION');

    const portal = toPortalOrder(stored as never);
    // The whole point: uncollected is not the same as incomplete.
    assert.equal(portal.fulfilmentStatus, 'ready_for_collection');
    const flow = Object.values(portal.prescriptionFlow ?? {})[0] as { state: string; goodsInAt?: string | null };
    assert.equal(flow.state, 'READY_FOR_COLLECTION', 'the client maps this state to rx status "ready"');
    assert.equal(flow.goodsInAt, '2026-08-23T10:00:00.000Z');
  });

  it('a part-collected order stays collectable while packs remain on the shelf', () => {
    const partlyCollected = baseOrder('READY_FOR_COLLECTION', {
      shipments: [dispatch],
      shipmentIds: ['ship-1'],
      lines: [{ lineId: 'poi-1', purchaseOrderItemId: 'poi-1', productId: 'p1', ordered: 2, shipped: 2, received: 2, collected: 1, remaining: 0 }],
      goodsInAt: '2026-08-23T10:00:00.000Z',
    });
    const portal = toPortalOrder(partlyCollected as never);
    assert.equal(portal.fulfilmentStatus, 'ready_for_collection', 'one pack is still waiting for the patient');
  });
});
