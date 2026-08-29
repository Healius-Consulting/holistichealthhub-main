import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MULTI_RX_REPAIR, planMultiRxPlacementRepair } from './multi-rx-placement-repair.js';

function fixture(): any {
  return {
    projectId: MULTI_RX_REPAIR.projectId,
    order: {
      id: MULTI_RX_REPAIR.orderId,
      organisationId: MULTI_RX_REPAIR.organisationId,
      orderNumber: MULTI_RX_REPAIR.orderNumber,
      status: 'PROCESSING', paymentStatus: 'PAID',
      quoteSnapshot: {
        prescriptions: [
          { id: '3504', hhhPrescriptionId: MULTI_RX_REPAIR.hhhPrescriptionId, serialNumber: 'PT1', curaleafPrescriptionId: MULTI_RX_REPAIR.overwrittenPrescriptionId, items: [{ productId: 'same-pack' }] },
          { id: '3505', serialNumber: 'PT2', curaleafPrescriptionId: 'c5e9b198-e836-4719-a8b6-559fc189fb65', items: [{ productId: 'other-pack' }] },
          { id: '3506', serialNumber: 'PT3', curaleafPrescriptionId: MULTI_RX_REPAIR.overwrittenPrescriptionId, items: [{ productId: 'same-pack' }] },
        ],
        curaleafSubOrders: {
          3504: { id: MULTI_RX_REPAIR.overwrittenPurchaseOrderId, purchaseOrderId: MULTI_RX_REPAIR.overwrittenPurchaseOrderId, prescriptionId: MULTI_RX_REPAIR.overwrittenPrescriptionId, items: [{ id: MULTI_RX_REPAIR.overwrittenPurchaseOrderItemId, productId: 'same-pack', purchaseOrderId: MULTI_RX_REPAIR.overwrittenPurchaseOrderId }] },
          3505: { id: '310eff18-6979-425b-91ee-d68def952e33', prescriptionId: 'c5e9b198-e836-4719-a8b6-559fc189fb65' },
          3506: { id: MULTI_RX_REPAIR.overwrittenPurchaseOrderId, prescriptionId: MULTI_RX_REPAIR.overwrittenPrescriptionId },
        },
      },
    },
    orderPrescriptions: [{ prescriptionId: MULTI_RX_REPAIR.hhhPrescriptionId, placementState: 'PENDING_PLACEMENT', supplierPurchaseOrderId: null }],
    serialUses: [{ id: MULTI_RX_REPAIR.serialUseId, serialNumber: 'PT1', curaleafPrescriptionId: MULTI_RX_REPAIR.overwrittenPrescriptionId }],
  };
}

describe('planMultiRxPlacementRepair', () => {
  it('repairs only P1 while keeping P2 and P3 byte-for-byte equivalent', () => {
    const input = fixture();
    const before = structuredClone(input.order.quoteSnapshot);
    const plan = planMultiRxPlacementRepair(input);
    assert.equal(plan.eligible, true);
    if (!plan.eligible) return;
    const next = plan.nextSnapshot as any;
    assert.equal(next.prescriptions[0]?.curaleafPrescriptionId, MULTI_RX_REPAIR.prescriptionId);
    assert.equal(next.curaleafSubOrders['3504']?.purchaseOrderId, MULTI_RX_REPAIR.purchaseOrderId);
    assert.equal(next.curaleafSubOrders['3504']?.items[0]?.id, MULTI_RX_REPAIR.purchaseOrderItemId);
    assert.deepEqual(next.prescriptions.slice(1), before.prescriptions.slice(1));
    assert.deepEqual(next.curaleafSubOrders['3505'], before.curaleafSubOrders['3505']);
    assert.deepEqual(next.curaleafSubOrders['3506'], before.curaleafSubOrders['3506']);
  });

  for (const [label, mutate] of [
    ['project', (value: ReturnType<typeof fixture>) => { value.projectId = 'wrong'; }],
    ['order', (value: ReturnType<typeof fixture>) => { value.order.orderNumber = 'wrong'; }],
    ['tenant', (value: ReturnType<typeof fixture>) => { value.order.organisationId = '00000000-0000-4000-8000-000000000000'; }],
    ['snapshot', (value: ReturnType<typeof fixture>) => { value.order.quoteSnapshot.curaleafSubOrders['3504'].id = 'unexpected'; }],
  ] as const) {
    it(`refuses an unexpected ${label}`, () => {
      const input = fixture(); mutate(input);
      assert.equal(planMultiRxPlacementRepair(input).eligible, false);
    });
  }
});
