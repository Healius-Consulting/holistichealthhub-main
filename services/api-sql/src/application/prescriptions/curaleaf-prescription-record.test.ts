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
});
