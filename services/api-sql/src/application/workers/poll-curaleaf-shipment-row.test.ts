import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { supplierShipmentRowInput } from './poll-curaleaf-shipment-row.js';

const order = {
  id: 'order-1',
  organisationId: 'org-1',
  orderNumber: 'HHH-1001',
  quoteSnapshot: {
    curaleaf: {
      id: 'po-snapshot',
      purchaseOrderId: 'po-snapshot',
      customerReference: 'HHH-from-snapshot',
    },
  },
};

describe('a Curaleaf dispatch records its shipment row there and then', () => {
  it('takes the purchase order and dispatch time from the event itself', () => {
    const row = supplierShipmentRowInput(order as never, {
      id: 'ship-1',
      purchaseOrderId: 'po-event',
      purchaseOrderCustomerReference: 'HHH-from-event',
      createdAt: '2026-08-22T08:00:00.000Z',
    });
    assert.deepEqual(row, {
      organisationId: 'org-1',
      orderId: 'order-1',
      supplierPurchaseOrderId: 'po-event',
      supplierShipmentId: 'ship-1',
      supplierCustomerReference: 'HHH-from-event',
      // The whole point of writing at dispatch: the real time, not null.
      dispatchedAt: '2026-08-22T08:00:00.000Z',
    });
  });

  it('falls back to the order snapshot when the event omits the purchase order', () => {
    const row = supplierShipmentRowInput(order as never, { id: 'ship-1', createdAt: null });
    assert.equal(row?.supplierPurchaseOrderId, 'po-snapshot');
    assert.equal(row?.supplierCustomerReference, 'HHH-from-snapshot');
    assert.equal(row?.dispatchedAt, null, 'no dispatch time is better than a made-up one');
  });

  it('resolves the customer reference by precedence, ending at the order number', () => {
    const bare = { id: 'ship-1', purchaseOrderId: 'po-event' };
    assert.equal(
      supplierShipmentRowInput({ ...order, quoteSnapshot: {} } as never, bare)?.supplierCustomerReference,
      'HHH-1001',
    );
    assert.equal(
      supplierShipmentRowInput({ ...order, quoteSnapshot: {}, orderNumber: null } as never, bare)?.supplierCustomerReference,
      null,
    );
    assert.equal(
      supplierShipmentRowInput(order as never, { ...bare, customerReference: 'HHH-second-choice' })?.supplierCustomerReference,
      'HHH-second-choice',
    );
  });

  it('writes nothing rather than fabricating an identifier', () => {
    // No shipment id: there is nothing to key the row on.
    assert.equal(supplierShipmentRowInput(order as never, { purchaseOrderId: 'po-event' }), null);
    // No purchase order anywhere: a shipment with no PO to hang it on is not a row.
    assert.equal(
      supplierShipmentRowInput({ ...order, quoteSnapshot: {} } as never, { id: 'ship-1' }),
      null,
    );
  });
});
