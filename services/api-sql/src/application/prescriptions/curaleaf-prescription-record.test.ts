import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asCuraleafPrescriptionState,
  normalizeCuraleafPurchaseOrder,
  stampCuraleafPrescriptionOnSnapshot,
} from './curaleaf-prescription-record.js';

describe('asCuraleafPrescriptionState', () => {
  it('does not invent a REJECTED prescription state', () => {
    assert.equal(asCuraleafPrescriptionState('REJECTED'), null);
    assert.equal(asCuraleafPrescriptionState('CANCELLED'), 'CANCELLED');
  });
});

describe('normalizeCuraleafPurchaseOrder', () => {
  it('fills CREATED, customer reference, and courier when the create response is only an id', () => {
    const normalized = normalizeCuraleafPurchaseOrder(
      { id: '7e1a8210-ba0d-48ae-8749-1f5ac2ec4100' },
      { customerReference: 'ORD-MT54WP94' },
    );
    assert.equal(normalized?.purchaseOrderState, 'CREATED');
    assert.equal(normalized?.state, 'CREATED');
    assert.equal(normalized?.customerReference, 'ORD-MT54WP94');
    assert.equal(normalized?.courier, null);
  });

  it('keeps the live Curaleaf purchase-order fields', () => {
    const normalized = normalizeCuraleafPurchaseOrder({
      id: '7e1a8210-ba0d-48ae-8749-1f5ac2ec4100',
      state: 'CREATED',
      customerReference: 'ORD-MT54WP94',
      courier: 'POLAR_SPEED',
    });
    assert.equal(normalized?.purchaseOrderState, 'CREATED');
    assert.equal(normalized?.customerReference, 'ORD-MT54WP94');
    assert.equal(normalized?.courier, 'POLAR_SPEED');
  });
});

describe('stampCuraleafPrescriptionOnSnapshot', () => {
  it('stores PO state, customer reference, and courier on the SQL snapshot', () => {
    const next = stampCuraleafPrescriptionOnSnapshot({
      curaleaf: {
        prescriptionId: 'b3b183b4-666d-4025-80c9-321a72789963',
        prescriberId: '1c2ccf78-1307-4233-b420-2348fd04065c',
        prescriptionState: 'ACTIVE',
      },
    }, {
      prescriptionId: 'b3b183b4-666d-4025-80c9-321a72789963',
      purchaseOrder: { id: '7e1a8210-ba0d-48ae-8749-1f5ac2ec4100' },
      customerReferenceFallback: 'ORD-MT54WP94',
    });
    const curaleaf = next.curaleaf as Record<string, unknown>;
    assert.equal(curaleaf.purchaseOrderId, '7e1a8210-ba0d-48ae-8749-1f5ac2ec4100');
    assert.equal(curaleaf.purchaseOrderState, 'CREATED');
    assert.equal(curaleaf.customerReference, 'ORD-MT54WP94');
    assert.equal(curaleaf.status, 'purchase_order_submitted');
  });

  it('keeps a live courier on the snapshot', () => {
    const next = stampCuraleafPrescriptionOnSnapshot({}, {
      purchaseOrder: {
        id: 'po-1',
        state: 'PROCESSING',
        customerReference: 'ORD-1',
        courier: 'POLAR_SPEED',
      },
    });
    const curaleaf = next.curaleaf as Record<string, unknown>;
    assert.equal(curaleaf.purchaseOrderState, 'PROCESSING');
    assert.equal(curaleaf.courier, 'POLAR_SPEED');
    assert.equal(curaleaf.customerReference, 'ORD-1');
  });

  it('stamps Curaleaf identity onto one prescription without cloning it onto the other', () => {
    const next = stampCuraleafPrescriptionOnSnapshot({
      prescriptions: [
        { id: '1', serialNumber: 'S1' },
        { id: '2', serialNumber: 'S2' },
      ],
    }, {
      prescriptionId: 'curaleaf-rx-2',
      purchaseOrder: { id: 'po-2' },
      rxKey: '2',
      customerReferenceFallback: 'ORD-1-r1',
    }) as Record<string, unknown>;
    const prescriptions = next.prescriptions as Array<Record<string, unknown>>;
    assert.equal(prescriptions[0]?.curaleafPrescriptionId, undefined);
    assert.equal(prescriptions[1]?.curaleafPrescriptionId, 'curaleaf-rx-2');
    const subOrders = next.curaleafSubOrders as Record<string, Record<string, unknown>>;
    assert.equal(subOrders['2']?.purchaseOrderId, 'po-2');
    assert.equal(subOrders['1'], undefined);
  });

  it('preserves three separately placed prescriptions and purchase orders', () => {
    let snapshot: unknown = {
      prescriptions: [
        { id: '1', serialNumber: 'MultiTest1' },
        { id: '2', serialNumber: 'MultiTest2' },
        { id: '3', serialNumber: 'MultiTest3' },
      ],
    };
    for (const [index, key] of ['1', '2', '3'].entries()) {
      snapshot = stampCuraleafPrescriptionOnSnapshot(snapshot, {
        rxKey: key,
        prescriptionId: `curaleaf-rx-${key}`,
        purchaseOrder: { id: `po-${key}` },
        customerReferenceFallback: index === 0 ? 'ORD-MTDQOYO5-204A222B97' : `ORD-MTDQOYO5-204A222B97-r${index}`,
      });
    }

    const subOrders = (snapshot as Record<string, unknown>).curaleafSubOrders as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.fromEntries(Object.entries(subOrders).map(([key, value]) => [key, {
      prescriptionId: value.prescriptionId,
      purchaseOrderId: value.purchaseOrderId,
      customerReference: value.customerReference,
    }])), {
      1: { prescriptionId: 'curaleaf-rx-1', purchaseOrderId: 'po-1', customerReference: 'ORD-MTDQOYO5-204A222B97' },
      2: { prescriptionId: 'curaleaf-rx-2', purchaseOrderId: 'po-2', customerReference: 'ORD-MTDQOYO5-204A222B97-r1' },
      3: { prescriptionId: 'curaleaf-rx-3', purchaseOrderId: 'po-3', customerReference: 'ORD-MTDQOYO5-204A222B97-r2' },
    });
  });
});
