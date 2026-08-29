import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  advanceFulfilmentStatus,
  applyPharmacyGoodsReceipt,
  applyPharmacyHandout,
  customerReferenceMatchesOrder,
  dispatchStatusFromLines,
  existingCuraleafPurchaseOrder,
  latestShipmentCreatedAt,
  matchPurchaseOrder,
  matchShipments,
  mergePriorPharmacyLines,
  normalisedFulfilmentLines,
  priorPurchaseOrderMatchesOrder,
  resolveLivePurchaseOrder,
  supplierFulfilmentStatus,
  syncSnapshotLineItemsFromPurchaseOrder,
} from './curaleaf-fulfilment.js';

const beachWeddingPo = {
  id: '99f4bc42-4312-45c5-b659-21583b5eb364',
  state: 'PROCESSING',
  courier: 'POLAR_SPEED',
  customerReference: 'HHH-5a8b4ac3-236c-41f7-a37b-0132b7892637-a9386eac93',
  issuedDate: '2026-08-13',
  createdAt: '2026-08-13T10:29:08.933558Z',
  items: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
    packsOrderedCount: 4,
    packsAllocatedCount: 2,
    packsReturnedCount: 0,
  }],
};

const beachWeddingShipment = {
  id: 'b13179c4-9515-4181-abd8-d1b87b50faa4',
  purchaseOrderId: '99f4bc42-4312-45c5-b659-21583b5eb364',
  purchaseOrderCustomerReference: 'HHH-5a8b4ac3-236c-41f7-a37b-0132b7892637-a9386eac93',
  createdAt: '2026-08-17T14:29:05.973745Z',
  items: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    packCount: 2,
    packsReturnedCount: 0,
    batchNumber: 'A409003',
    batchExpiryDate: '2027-02-06',
  }],
};

const order = {
  id: '5a8b4ac3-236c-41f7-a37b-0132b7892637',
  orderNumber: 'ORD-BEACH',
};

const fullyAllocatedPo = {
  id: '6e5e3d6e-5b14-4b8a-bb0e-d6d60ed6f69f',
  state: 'FULLY_ALLOCATED',
  courier: 'POLAR_SPEED',
  customerReference: 'HHH-93eea688-3a39-4b1d-b998-e43cc16acf4b-c10dbf6885',
  issuedDate: '2026-08-13',
  createdAt: '2026-08-13T10:31:34.825350Z',
  items: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
    packsOrderedCount: 2,
    packsAllocatedCount: 2,
    packsReturnedCount: 0,
  }],
};

const fullyAllocatedShipment = {
  id: 'f46d4159-f0dc-49fe-9189-4f0a59ea18e2',
  purchaseOrderId: '6e5e3d6e-5b14-4b8a-bb0e-d6d60ed6f69f',
  purchaseOrderCustomerReference: 'HHH-93eea688-3a39-4b1d-b998-e43cc16acf4b-c10dbf6885',
  createdAt: '2026-08-17T14:30:05.319618Z',
  items: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    packCount: 2,
    packsReturnedCount: 0,
    batchNumber: 'A409003',
    batchExpiryDate: '2027-02-06',
  }],
};

const tenPackPo = {
  id: '65ba3fdd-4507-4e39-a8ed-2d383b04e1d8',
  state: 'PROCESSING',
  courier: 'POLAR_SPEED',
  customerReference: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
  issuedDate: '2026-08-13',
  createdAt: '2026-08-13T09:23:29.241487Z',
  items: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
    packsOrderedCount: 10,
    packsAllocatedCount: 1,
    packsReturnedCount: 0,
  }],
};

const tenPackShipment = {
  id: '796adea9-f2d9-43b2-ad5c-ccfc4184ee62',
  purchaseOrderId: '65ba3fdd-4507-4e39-a8ed-2d383b04e1d8',
  purchaseOrderCustomerReference: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
  createdAt: '2026-08-17T08:50:45.621344Z',
  items: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    packCount: 1,
    packsReturnedCount: 0,
    batchNumber: 'A409003',
    batchExpiryDate: '2027-02-06',
  }],
};

describe('Curaleaf fulfilment mapping', () => {
  it('matches compact pharmacy-prefixed references for every prescription', () => {
    const order = { id: 'order-id', orderNumber: 'ORD-MTDQOYO5-204A222B97' };
    assert.equal(customerReferenceMatchesOrder('M75-204A222B97-P1', order), true);
    assert.equal(customerReferenceMatchesOrder('M75-204A222B97-P2', order), true);
    assert.equal(customerReferenceMatchesOrder('M75-204A222B97-P3', order), true);
    assert.equal(customerReferenceMatchesOrder('M75-204A222B97-r1', order), true);
    assert.equal(customerReferenceMatchesOrder('M75-AAAAAAAAAA-r1', order), false);
  });

  it('matches HHH-{orderId}-{hash} customer references to the SQL order id', () => {
    assert.equal(customerReferenceMatchesOrder(beachWeddingPo.customerReference, order), true);
    assert.equal(matchPurchaseOrder(order, [beachWeddingPo])?.id, beachWeddingPo.id);
    assert.equal(matchShipments(order, beachWeddingPo, [beachWeddingShipment]).length, 1);
  });

  it('maps the Beach Wedding consignment as a 2-of-4 split shipment', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.ordered, 4);
    assert.equal(lines[0]?.allocated, 2);
    assert.equal(lines[0]?.shipped, 2);
    assert.equal(lines[0]?.remaining, 2);
    assert.equal(lines[0]?.received, 0);
    assert.equal(lines[0]?.backordered, true);
    assert.equal(dispatchStatusFromLines([beachWeddingShipment], lines), 'partial');
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      lines,
    }), 'PARTIALLY_DISPATCHED_TO_PHARMACY');
    assert.equal(latestShipmentCreatedAt([beachWeddingShipment]), beachWeddingShipment.createdAt);
  });

  it('does not invent a full dispatch when shipment product ids do not match', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [{ ...beachWeddingShipment, items: [{ productId: 'other-pack', packCount: 2 }] }],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
    });
    assert.equal(lines[0]?.shipped, 0);
    assert.equal(lines[0]?.remaining, 4);
  });

  it('keeps pharmacy goods-in counts when Curaleaf is re-synced', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
      priorLines: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', received: 2, collected: 0 }],
    });
    assert.equal(lines[0]?.received, 2);
    assert.equal(lines[0]?.shipped, 2);
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      lines,
    }), 'PARTIALLY_RECEIVED');
  });

  it('does not regress a goods-in status back to in-transit', () => {
    assert.equal(
      advanceFulfilmentStatus('PARTIALLY_RECEIVED', 'PARTIALLY_DISPATCHED_TO_PHARMACY'),
      'PARTIALLY_RECEIVED',
    );
    assert.equal(
      advanceFulfilmentStatus('SUPPLIER_PROCESSING', 'PARTIALLY_DISPATCHED_TO_PHARMACY'),
      'PARTIALLY_DISPATCHED_TO_PHARMACY',
    );
  });

  it('matches and maps the fully allocated 2-pack consignment as complete dispatch', () => {
    const liveOrder = { id: '93eea688-3a39-4b1d-b998-e43cc16acf4b', orderNumber: 'ORD-OTHER' };
    assert.equal(customerReferenceMatchesOrder(fullyAllocatedPo.customerReference, liveOrder), true);
    assert.equal(matchPurchaseOrder(liveOrder, [fullyAllocatedPo])?.id, fullyAllocatedPo.id);
    assert.equal(matchShipments(liveOrder, fullyAllocatedPo, [fullyAllocatedShipment]).length, 1);
    const lines = normalisedFulfilmentLines({
      purchaseOrder: fullyAllocatedPo,
      shipments: [fullyAllocatedShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 2 }],
    });
    assert.equal(lines[0]?.ordered, 2);
    assert.equal(lines[0]?.allocated, 2);
    assert.equal(lines[0]?.shipped, 2);
    assert.equal(lines[0]?.remaining, 0);
    assert.equal(lines[0]?.received, 0);
    assert.equal(lines[0]?.backordered, false);
    assert.equal(dispatchStatusFromLines([fullyAllocatedShipment], lines), 'complete');
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: fullyAllocatedPo,
      shipments: [fullyAllocatedShipment],
      lines,
    }), 'DISPATCHED_TO_PHARMACY');
  });

  it('maps the 1-of-10 PROCESSING consignment as a split shipment, not full dispatch', () => {
    const liveOrder = { id: 'a55ee7d4-6466-4e95-bf7f-88a95241e60f', orderNumber: 'ORD-TEN' };
    assert.equal(matchPurchaseOrder(liveOrder, [tenPackPo])?.id, tenPackPo.id);
    const lines = normalisedFulfilmentLines({
      purchaseOrder: tenPackPo,
      shipments: [tenPackShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 10 }],
    });
    assert.equal(lines[0]?.ordered, 10);
    assert.equal(lines[0]?.allocated, 1);
    assert.equal(lines[0]?.shipped, 1);
    assert.equal(lines[0]?.remaining, 9);
    assert.equal(lines[0]?.received, 0);
    assert.equal(lines[0]?.backordered, true);
    assert.equal(dispatchStatusFromLines([tenPackShipment], lines), 'partial');
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: tenPackPo,
      shipments: [tenPackShipment],
      lines,
    }), 'PARTIALLY_DISPATCHED_TO_PHARMACY');
    assert.equal(latestShipmentCreatedAt([tenPackShipment]), tenPackShipment.createdAt);
  });

  it('keeps Curaleaf ordered pack count when the SQL requested quantity was wrongly shrunk', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: tenPackPo,
      shipments: [],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 1 }],
    });
    assert.equal(lines[0]?.ordered, 10);
    assert.equal(lines[0]?.requested, 1);
    assert.equal(lines[0]?.allocated, 1);
    assert.equal(lines[0]?.shipped, 0);
    assert.equal(lines[0]?.quantityMismatch, true);
  });

  it('maps Beach Wedding 2-of-4 allocation without a shipment as remaining at Curaleaf', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
    });
    assert.equal(lines[0]?.ordered, 4);
    assert.equal(lines[0]?.allocated, 2);
    assert.equal(lines[0]?.shipped, 0);
    assert.equal(lines[0]?.remaining, 4);
    assert.equal(dispatchStatusFromLines([], lines), 'not_dispatched');
  });

  it('records Beach Wedding 2-of-4 check-in and keeps it after a Curaleaf re-sync', () => {
    const before = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
    });
    const checkedIn = applyPharmacyGoodsReceipt({
      lines: before,
      items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', receivedQuantity: 2 }],
      shipmentId: beachWeddingShipment.id,
    });
    assert.equal(checkedIn.lines[0]?.received, 2);
    assert.equal(checkedIn.lines[0]?.remaining, 2);
    assert.equal(checkedIn.shipmentStates[beachWeddingShipment.id], 'ready_for_collection');
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      lines: checkedIn.lines,
    }), 'PARTIALLY_RECEIVED');

    const resynced = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
      priorLines: mergePriorPharmacyLines(checkedIn.lines, [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', shipped: 2 }]),
    });
    assert.equal(resynced[0]?.received, 2);
    assert.equal(resynced[0]?.shipped, 2);
    assert.equal(resynced[0]?.remaining, 2);
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      lines: resynced,
    }), 'PARTIALLY_RECEIVED');
    assert.equal(
      advanceFulfilmentStatus('PARTIALLY_RECEIVED', 'PARTIALLY_DISPATCHED_TO_PHARMACY'),
      'PARTIALLY_RECEIVED',
    );
  });

  it('records 1-of-10 check-in and keeps it after a Curaleaf re-sync', () => {
    const before = normalisedFulfilmentLines({
      purchaseOrder: tenPackPo,
      shipments: [tenPackShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 10 }],
    });
    const checkedIn = applyPharmacyGoodsReceipt({
      lines: before,
      items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', receivedQuantity: 1 }],
      shipmentId: tenPackShipment.id,
    });
    assert.equal(checkedIn.lines[0]?.received, 1);
    assert.equal(checkedIn.lines[0]?.remaining, 9);
    const resynced = normalisedFulfilmentLines({
      purchaseOrder: tenPackPo,
      shipments: [tenPackShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 10 }],
      priorLines: checkedIn.lines,
    });
    assert.equal(resynced[0]?.received, 1);
    assert.equal(resynced[0]?.remaining, 9);
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: tenPackPo,
      shipments: [tenPackShipment],
      lines: resynced,
    }), 'PARTIALLY_RECEIVED');
  });

  it('does not check in more packs than Curaleaf has shipped', () => {
    const before = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
    });
    const checkedIn = applyPharmacyGoodsReceipt({
      lines: before,
      items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', receivedQuantity: 4 }],
      shipmentId: beachWeddingShipment.id,
    });
    assert.equal(checkedIn.lines[0]?.received, 2);
  });

  it('hands out only arrived packs on a split consignment and refuses full collection', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 4 }],
      priorLines: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', received: 2, collected: 0 }],
    });
    const blocked = applyPharmacyHandout({
      lines,
      shipmentStates: { [beachWeddingShipment.id]: 'received' },
      shipmentId: beachWeddingShipment.id,
      partial: false,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remainingOpen, true);
    assert.equal(blocked.lines[0]?.collected, 0);

    const partial = applyPharmacyHandout({
      lines,
      shipments: [beachWeddingShipment],
      shipmentStates: { [beachWeddingShipment.id]: 'ready_for_collection' },
      shipmentId: beachWeddingShipment.id,
      partial: true,
    });
    assert.equal(partial.allowed, true);
    assert.equal(partial.remainingOpen, true);
    assert.equal(partial.lines[0]?.collected, 2);
    assert.equal(partial.shipmentStates[beachWeddingShipment.id], 'collected');
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: beachWeddingPo,
      shipments: [beachWeddingShipment],
      lines: partial.lines,
    }), 'PARTIALLY_RECEIVED');
  });

  it('hands out one ready consignment at a time and is idempotent on retry', () => {
    const first = { ...beachWeddingShipment, id: 'shipment-first', items: [{ productId: beachWeddingShipment.items[0]!.productId, packCount: 1 }] };
    const second = { ...beachWeddingShipment, id: 'shipment-second', items: [{ productId: beachWeddingShipment.items[0]!.productId, packCount: 1 }] };
    const twoPackPo = { ...beachWeddingPo, items: [{ ...beachWeddingPo.items[0]!, packsOrderedCount: 2, packsAllocatedCount: 2 }] };
    const lines = normalisedFulfilmentLines({
      purchaseOrder: twoPackPo,
      shipments: [first, second],
      requestedItems: [{ packId: beachWeddingShipment.items[0]!.productId, quantity: 2 }],
      priorLines: [{ productId: beachWeddingShipment.items[0]!.productId, received: 2, collected: 0 }],
    });
    const states = { 'shipment-first': 'ready_for_collection', 'shipment-second': 'ready_for_collection' };
    const firstHandout = applyPharmacyHandout({ lines, shipments: [first, second], shipmentStates: states, shipmentId: first.id, partial: true });
    assert.equal(firstHandout.lines[0]?.collected, 1);
    assert.equal(firstHandout.remainingOpen, true);
    const retry = applyPharmacyHandout({ lines: firstHandout.lines, shipments: [first, second], shipmentStates: firstHandout.shipmentStates, shipmentId: first.id, partial: true });
    assert.equal(retry.lines[0]?.collected, 1, 'retry must not collect the second consignment');
    const final = applyPharmacyHandout({ lines: retry.lines, shipments: [first, second], shipmentStates: retry.shipmentStates, shipmentId: second.id, partial: true });
    assert.equal(final.lines[0]?.collected, 2);
    assert.equal(final.remainingOpen, false);
  });

  it('keeps FULLY_ALLOCATED as supplier allocated when no shipment has been handed to courier', () => {
    const lines = normalisedFulfilmentLines({
      purchaseOrder: fullyAllocatedPo,
      shipments: [],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 2 }],
    });
    assert.equal(lines[0]?.shipped, 0);
    assert.equal(lines[0]?.remaining, 2);
    assert.equal(dispatchStatusFromLines([], lines), 'not_dispatched');
    assert.equal(supplierFulfilmentStatus({
      purchaseOrder: fullyAllocatedPo,
      shipments: [],
      lines,
    }), 'SUPPLIER_ALLOCATED');
  });

  it('prefers the exact HHH-{orderId} purchase order over weaker order-number matches', () => {
    const otherOrder = { id: '11111111-1111-4111-8111-111111111111', orderNumber: '5' };
    const weakPo = {
      id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      customerReference: 'HHH-5',
      items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packsOrderedCount: 10 }],
    };
    assert.equal(
      matchPurchaseOrder(otherOrder, [weakPo, beachWeddingPo])?.id,
      weakPo.id,
    );
    assert.equal(
      matchPurchaseOrder(order, [weakPo, beachWeddingPo])?.id,
      beachWeddingPo.id,
    );
  });

  it('ignores migrated purchase-order snapshots that belong to a different order', () => {
    const migratedOrder = { id: '22222222-2222-4222-8222-222222222222', orderNumber: '5' };
    const stalePrior = {
      purchaseOrderId: tenPackPo.id,
      customerReference: tenPackPo.customerReference,
      items: tenPackPo.items,
    };
    assert.equal(priorPurchaseOrderMatchesOrder(stalePrior, migratedOrder), false);
    assert.equal(resolveLivePurchaseOrder(migratedOrder, [tenPackPo, beachWeddingPo], stalePrior), null);
    const lines = normalisedFulfilmentLines({
      purchaseOrder: resolveLivePurchaseOrder(migratedOrder, [tenPackPo, beachWeddingPo], stalePrior),
      shipments: [],
      requestedItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 1 }],
    });
    assert.equal(lines[0]?.quantityMismatch, false);
    assert.equal(lines[0]?.supplierReportedOrdered, 0);
  });

  it('repairs migrated line-item quantities from the live Curaleaf purchase order', () => {
    const tenPackOrder = { id: 'a55ee7d4-6466-4e95-bf7f-88a95241e60f', orderNumber: '12' };
    const snapshot = {
      lineItems: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 1 }],
      curaleaf: { purchaseOrderId: tenPackPo.id, customerReference: tenPackPo.customerReference },
    };
    const repaired = syncSnapshotLineItemsFromPurchaseOrder(snapshot, tenPackPo, tenPackOrder);
    assert.equal((repaired.lineItems as Array<{ quantity: number }>)[0]?.quantity, 10);
    const lines = normalisedFulfilmentLines({
      purchaseOrder: tenPackPo,
      shipments: [tenPackShipment],
      requestedItems: repaired.lineItems as Array<{ packId: string; quantity: number }>,
    });
    assert.equal(lines[0]?.quantityMismatch, false);
    assert.equal(lines[0]?.ordered, 10);
    assert.equal(lines[0]?.shipped, 1);
    assert.equal(lines[0]?.remaining, 9);
  });

  it('repairs line-item quantities when the SQL order id is stored as compact hex', () => {
    const compactOrder = {
      id: 'a55ee7d464664e95bf7f88a95241e60f',
      orderNumber: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
    };
    const snapshot = {
      items: [{ packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', quantity: 1 }],
    };
    const repaired = syncSnapshotLineItemsFromPurchaseOrder(snapshot, tenPackPo, compactOrder);
    assert.equal((repaired.items as Array<{ quantity: number }>)[0]?.quantity, 10);
  });

  it('detects an existing purchase order already stored on the order snapshot', () => {
    const compactOrder = {
      id: 'a55ee7d464664e95bf7f88a95241e60f',
      orderNumber: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
      quoteSnapshot: {
        curaleaf: {
          purchaseOrderId: tenPackPo.id,
          customerReference: tenPackPo.customerReference,
        },
      },
    };
    assert.equal(existingCuraleafPurchaseOrder(compactOrder)?.purchaseOrderId, tenPackPo.id);
  });

  it('joins duplicate products by purchaseOrderItemId across multiple shipments', () => {
    const purchaseOrder = {
      id: 'po-duplicate-product',
      state: 'PROCESSING',
      items: [
        { id: 'poi-1', productId: 'pack-same', formulaId: 'formula-a', packsOrderedCount: 2 },
        { id: 'poi-2', productId: 'pack-same', formulaId: 'formula-b', packsOrderedCount: 3 },
      ],
    };
    const lines = normalisedFulfilmentLines({
      purchaseOrder,
      shipments: [
        { id: 'shipment-1', items: [{ purchaseOrderItemId: 'poi-1', productId: 'pack-same', packCount: 1 }] },
        { id: 'shipment-2', items: [{ purchaseOrderItemId: 'poi-2', productId: 'pack-same', packCount: 2 }] },
      ],
      requestedItems: [{ packId: 'pack-same', quantity: 5 }],
    });
    assert.equal(lines.length, 2);
    assert.equal(lines.find(line => line.purchaseOrderItemId === 'poi-1')?.shipped, 1);
    assert.equal(lines.find(line => line.purchaseOrderItemId === 'poi-2')?.shipped, 2);
    assert.equal(lines.some(line => line.reconciliationRequired), false);
    const received = applyPharmacyGoodsReceipt({
      lines,
      shipmentId: 'shipment-1',
      items: [{ purchaseOrderItemId: 'poi-1', productId: 'pack-same', receivedQuantity: 1 }],
    });
    assert.equal(received.lines.find(line => line.purchaseOrderItemId === 'poi-1')?.received, 1);
    assert.equal(received.lines.find(line => line.purchaseOrderItemId === 'poi-2')?.received, 0);
  });

  it('fails into reconciliation when a duplicate-product shipment omits purchaseOrderItemId', () => {
    const purchaseOrder = {
      id: 'po-ambiguous',
      state: 'PROCESSING',
      items: [
        { id: 'poi-1', productId: 'pack-same', packsOrderedCount: 1 },
        { id: 'poi-2', productId: 'pack-same', packsOrderedCount: 1 },
      ],
    };
    const shipments = [{ id: 'shipment-ambiguous', items: [{ productId: 'pack-same', packCount: 1 }] }];
    const lines = normalisedFulfilmentLines({ purchaseOrder, shipments });
    assert.equal(lines.every(line => line.shipped === 0), true);
    assert.equal(lines.every(line => line.reconciliationRequired), true);
    assert.equal(supplierFulfilmentStatus({ purchaseOrder, shipments, lines }), 'EXCEPTION');
  });

  it('preserves shipped packs and calculates only the cancelled remainder', () => {
    const purchaseOrder = {
      id: 'po-partial-cancel',
      state: 'CANCELLED',
      items: [{ id: 'poi-1', productId: 'pack-a', packsOrderedCount: 4 }],
    };
    const shipments = [{
      id: 'shipment-partial',
      purchaseOrderId: 'po-partial-cancel',
      items: [{ purchaseOrderItemId: 'poi-1', productId: 'pack-a', packCount: 2 }],
    }];
    const lines = normalisedFulfilmentLines({
      purchaseOrder,
      shipments,
      requestedItems: [{ packId: 'pack-a', quantity: 4 }],
    });
    assert.equal(lines[0]?.shipped, 2);
    assert.equal(lines[0]?.remaining, 0);
    assert.equal(lines[0]?.cancelledRemainder, 2);
    assert.equal(lines[0]?.backordered, false);
    assert.equal(supplierFulfilmentStatus({ purchaseOrder, shipments, lines }), 'EXCEPTION');
  });
});
