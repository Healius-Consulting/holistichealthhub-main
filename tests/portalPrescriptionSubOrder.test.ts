import assert from 'node:assert/strict';
import test from 'node:test';
import type { PortalOrderRecord } from '../src/shared/contracts.ts';
import {
  fulfilmentLinesForPrescription,
  resolvePortalPrescriptionCuraleaf,
  shipmentsForPrescription,
} from '../src/utils/portalPrescriptionSubOrder.ts';

const paidMulti: Pick<PortalOrderRecord, 'curaleaf' | 'curaleafSubOrders' | 'prescriptions'> = {
  prescriptions: [
    { id: 'rx-1', fileId: 'file-1' } as PortalOrderRecord['prescriptions'][number],
    { id: 'rx-2', fileId: 'file-2' } as PortalOrderRecord['prescriptions'][number],
  ],
  curaleaf: {
    status: 'purchase_order_submitted',
    customerReference: 'ORD-SHARED',
    purchaseOrderId: 'po-order',
  },
  curaleafSubOrders: {
    'rx-1': {
      status: 'purchase_order_submitted',
      customerReference: 'ORD-RX1',
      purchaseOrderId: 'po-1',
    },
  },
};

test('multi-Rx mapping keys sub-orders by prescription id, not fileId', () => {
  const first = resolvePortalPrescriptionCuraleaf(paidMulti, { id: 'rx-1', fileId: 'file-1' });
  const second = resolvePortalPrescriptionCuraleaf(paidMulti, { id: 'rx-2', fileId: 'file-2' });
  assert.equal(first?.purchaseOrderId, 'po-1');
  assert.equal(second, undefined);
});

test('fileId must not attach the order-level Curaleaf PO to every card', () => {
  const cloned = resolvePortalPrescriptionCuraleaf(paidMulti, { id: 'rx-2', fileId: 'file-1' });
  assert.equal(cloned, undefined);
});

test('single-Rx orders may still use the order-level Curaleaf record', () => {
  const single = {
    prescriptions: [{ id: 'rx-1', fileId: 'file-1' }] as PortalOrderRecord['prescriptions'],
    curaleaf: paidMulti.curaleaf,
  };
  const resolved = resolvePortalPrescriptionCuraleaf(single, { id: 'rx-1', fileId: 'file-1' });
  assert.equal(resolved?.purchaseOrderId, 'po-order');
});

test('fulfilment lines stay on the matching prescription packs', () => {
  const lines = [
    { productId: 'pack-a', ordered: 2 },
    { productId: 'pack-b', ordered: 3 },
  ];
  const rx1 = fulfilmentLinesForPrescription(lines, [{ packId: 'pack-a' }], { failClosedWhenEmpty: true });
  const rx2 = fulfilmentLinesForPrescription(lines, [{ packId: 'pack-b' }], { failClosedWhenEmpty: true });
  assert.deepEqual(rx1.map(line => line.productId), ['pack-a']);
  assert.deepEqual(rx2.map(line => line.productId), ['pack-b']);
});

test('shipments without overlapping packs are excluded from an unplaced sibling', () => {
  const shipments = [
    { id: 'ship-1', items: [{ productId: 'pack-a', packCount: 2 }] },
    { id: 'ship-2', items: [{ productId: 'pack-b', packCount: 1 }] },
  ];
  const rx2 = shipmentsForPrescription(shipments, [{ packId: 'pack-b' }], { failClosedWhenEmpty: true });
  assert.deepEqual(rx2.map(shipment => shipment.id), ['ship-2']);
  assert.equal(shipmentsForPrescription(shipments, [{ packId: 'pack-c' }], { failClosedWhenEmpty: true }).length, 0);
});
