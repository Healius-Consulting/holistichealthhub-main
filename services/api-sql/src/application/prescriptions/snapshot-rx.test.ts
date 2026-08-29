import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allSnapshotRxsHavePurchaseOrders,
  compactOrderReferenceToken,
  customerReferenceForRx,
  packIdsForRx,
  pendingPlacementRxIndexes,
  pharmacyReferencePrefix,
  rxHasPurchaseOrder,
  snapshotRxKey,
  snapshotRxList,
} from './snapshot-rx.js';

describe('snapshot Rx helpers', () => {
  it('keeps an explicit snapshot correlation key while retaining the canonical HHH identity separately', () => {
    assert.equal(snapshotRxKey({ hhhPrescriptionId: 'hhh-rx', clientKey: 'client-rx', id: '12', fileId: 'file-1' }, 0), 'client-rx');
    assert.equal(snapshotRxKey({ clientKey: 'client-rx', id: '12', fileId: 'file-1' }, 0), 'client-rx');
    assert.equal(snapshotRxKey({ id: '12' }, 0), '12');
    assert.equal(snapshotRxKey({ hhhPrescriptionId: 'hhh-rx' }, 0), 'hhh-rx');
    assert.equal(snapshotRxKey({ fileId: 'file-1' }, 1), 'file-1');
    assert.equal(snapshotRxKey({}, 2), 'rx-2');
  });

  it('uses a compact pharmacy prefix and keeps each prescription reference unique', () => {
    const organisationId = 'pharmacy-one';
    const prefix = pharmacyReferencePrefix(organisationId);
    assert.equal(prefix.length, 3);
    assert.equal(pharmacyReferencePrefix(organisationId), prefix);
    assert.notEqual(pharmacyReferencePrefix('pharmacy-two'), prefix);
    assert.equal(compactOrderReferenceToken('ORD-MTDQOYO5-204A222B97', 'order-id'), '204A222B97');
    assert.equal(customerReferenceForRx('ORD-MTDQOYO5-204A222B97', 'order-id', 0, organisationId), `${prefix}-204A222B97-P1`);
    assert.equal(customerReferenceForRx('ORD-MTDQOYO5-204A222B97', 'order-id', 1, organisationId), `${prefix}-204A222B97-P2`);
    assert.equal(customerReferenceForRx('ORD-MTDQOYO5-204A222B97', 'order-id', 2, organisationId), `${prefix}-204A222B97-P3`);
  });

  it('fails closed when a pharmacy identity is unavailable', () => {
    assert.throws(
      () => customerReferenceForRx('ORD-1', 'order-id', 0, ''),
      /pharmacy organisation ID/,
    );
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
