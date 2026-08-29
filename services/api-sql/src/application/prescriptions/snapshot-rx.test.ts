import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allSnapshotRxsHavePurchaseOrders,
  customerReferenceForRx,
  packIdsForRx,
  pendingPlacementRxIndexes,
  rxHasPurchaseOrder,
  snapshotRxKey,
  snapshotRxList,
} from './snapshot-rx.js';

describe('snapshot Rx helpers', () => {
  it('keys a prescription by id then fileId', () => {
    assert.equal(snapshotRxKey({ id: '12' }, 0), '12');
    assert.equal(snapshotRxKey({ fileId: 'file-1' }, 1), 'file-1');
    assert.equal(snapshotRxKey({}, 2), 'rx-2');
  });

  it('keeps the order number for the first prescription and suffixes the rest', () => {
    assert.equal(customerReferenceForRx('ORD-1', 'order-id', 0), 'ORD-1');
    assert.equal(customerReferenceForRx('ORD-1', 'order-id', 1), 'ORD-1-r1');
  });

  it('reads purchase orders per prescription key', () => {
    const snapshot = {
      prescriptions: [{ id: '1' }, { id: '2' }],
      curaleafSubOrders: {
        1: { purchaseOrderId: 'po-1' },
      },
    };
    assert.equal(rxHasPurchaseOrder(snapshot, '1'), true);
    assert.equal(rxHasPurchaseOrder(snapshot, '2'), false);
    assert.equal(allSnapshotRxsHavePurchaseOrders(snapshot), false);
    assert.equal(snapshotRxList(snapshot).length, 2);
  });

  it('places each prescription that does not yet have a purchase order', () => {
    const snapshot = {
      prescriptions: [
        { id: '1', items: [{ packId: 'pack-a' }] },
        { id: '2', items: [{ packId: 'pack-b' }, { packId: 'pack-c' }] },
      ],
      curaleafSubOrders: {
        1: { purchaseOrderId: 'po-1' },
      },
    };
    assert.deepEqual(pendingPlacementRxIndexes(snapshot), [1]);
    assert.deepEqual(pendingPlacementRxIndexes({
      prescriptions: [{ id: '1' }, { id: '2' }],
    }), [0, 1]);
    assert.deepEqual(packIdsForRx({ items: [{ packId: 'pack-a' }, { productId: 'pack-b' }] }), ['pack-a', 'pack-b']);
  });
});
