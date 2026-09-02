import assert from 'node:assert/strict';
import test from 'node:test';
import type { PortalOrderRecord } from '../src/shared/contracts.ts';
import {
  fulfilmentLinesForPrescription,
  portalPrescriptionFlow,
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

test('clientKey snapshots attach each purchase order without an id field', () => {
  const record: Pick<PortalOrderRecord, 'curaleaf' | 'curaleafSubOrders' | 'prescriptions' | 'prescriptionFlow'> = {
    prescriptions: [
      { clientKey: '3802', fileId: 'file-1', curaleafPrescriptionId: 'curaleaf-a' } as PortalOrderRecord['prescriptions'][number],
      { clientKey: '3803', fileId: 'file-2', curaleafPrescriptionId: 'curaleaf-b' } as PortalOrderRecord['prescriptions'][number],
    ],
    curaleaf: {
      status: 'purchase_order_submitted',
      customerReference: '1DZ-81DB74B60D-P2',
      purchaseOrderId: 'po-last',
    },
    curaleafSubOrders: {
      3802: { status: 'purchase_order_submitted', purchaseOrderId: 'po-1', prescriptionId: 'curaleaf-a' },
      3803: { status: 'purchase_order_submitted', purchaseOrderId: 'po-2', prescriptionId: 'curaleaf-b' },
    },
    prescriptionFlow: {
      3802: { id: '3802', state: 'PLACED', payable: true, expiryDate: '2026-09-30', purchaseOrderId: 'po-1', shipmentIds: [], lines: [] },
      3803: { id: '3803', state: 'PLACED', payable: true, expiryDate: '2026-09-30', purchaseOrderId: 'po-2', shipmentIds: [], lines: [] },
    },
  };
  const first = { clientKey: '3802', fileId: 'file-1', curaleafPrescriptionId: 'curaleaf-a' };
  const second = { clientKey: '3803', fileId: 'file-2', curaleafPrescriptionId: 'curaleaf-b' };
  assert.equal(resolvePortalPrescriptionCuraleaf(record, first)?.purchaseOrderId, 'po-1');
  assert.equal(resolvePortalPrescriptionCuraleaf(record, second)?.purchaseOrderId, 'po-2');
  assert.equal(portalPrescriptionFlow(record, first)?.purchaseOrderId, 'po-1');
  assert.equal(portalPrescriptionFlow(record, second)?.purchaseOrderId, 'po-2');
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
