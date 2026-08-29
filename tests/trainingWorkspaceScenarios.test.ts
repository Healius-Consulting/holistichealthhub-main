import assert from 'node:assert/strict';
import test from 'node:test';
import { trainingWorkspace } from '../src/training/workspace.ts';
import { orderBoardLane } from '../src/utils/orderBoardLanes.ts';
import { orderCancellationResolution, orderIsSplitFulfilment, orderStage } from '../src/utils/orderStage.ts';
import { businessOrderReference } from '../src/utils/orderReference.ts';
import { buildPrescriptionWorkItems } from '../src/utils/prescriptionWorkItems.ts';

const workspace = trainingWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const byId = (id: number) => {
  const order = workspace.orders.find(item => item.id === id);
  assert.ok(order, `missing training order ${id}`);
  return order;
};

test('training workspace exposes the full order drill set', () => {
  assert.equal(workspace.orders.length, 48);
  assert.equal(workspace.crm.every(patient => workspace.orders.some(order => order.patientId === patient.id)), true);
  assert.equal(workspace.orders.every(order => workspace.crm.some(patient => patient.id === order.patientId)), true);
  const submittedReferences = workspace.orders.filter(order => order.payment.status !== 'none').map(businessOrderReference);
  assert.equal(new Set(submittedReferences).size, submittedReferences.length, 'training order references must be distinguishable');
  assert.equal(byId(100).payment.status, 'none');
  assert.equal(orderStage(byId(101)).stage, 'awaiting-payment');
  assert.equal(orderStage(byId(102)).stage, 'curaleaf-pending');
  assert.equal(orderIsSplitFulfilment(byId(112)), true);
  assert.equal(orderStage(byId(104)).stage, 'ready');
  assert.equal(orderStage(byId(105)).stage, 'collected');
  assert.equal(byId(121).quoteReview?.status, 'required');
  assert.equal(byId(131).redoneByOrderId, 'training-order-132');
  assert.equal(byId(132).redoContext?.originalOrderId, 131);
});

const laneFor = (id: number) => {
  const order = byId(id);
  return orderBoardLane({ order, stage: orderStage(order).stage });
};

test('every current board lane has both single and multi-prescription training orders', () => {
  const laneShapes: Array<[string, number, number]> = [
    ['needs-action', 121, 151],
    ['awaiting-payment', 101, 152],
    ['curaleaf', 102, 154],
    ['split', 112, 157],
    ['ready', 170, 160],
    ['ready', 104, 161],
  ];

  for (const [lane, singleId, multiId] of laneShapes) {
    assert.equal(laneFor(singleId), lane, `${singleId} should demonstrate ${lane}`);
    assert.equal(byId(singleId).prescriptions.length, 1, `${singleId} should be single-prescription`);
    assert.equal(laneFor(multiId), lane, `${multiId} should demonstrate ${lane}`);
    assert.equal(byId(multiId).prescriptions.length > 1, true, `${multiId} should be multi-prescription`);
  }
});

test('Needs action contains single and multi examples for every operational breakdown', () => {
  const actionPairs = [
    { label: 'price review', single: 121, multi: 151 },
    { label: 'stock hold', single: 123, multi: 167 },
    { label: 'quote reconciliation', single: 168, multi: 169 },
    { label: 'cancelled PO resolution', single: 141, multi: 165 },
    { label: 'refund due', single: 144, multi: 166 },
    { label: 'rejected prescription', single: 143, multi: 164 },
  ];

  for (const scenario of actionPairs) {
    assert.equal(laneFor(scenario.single), 'needs-action', `${scenario.label} single missing`);
    assert.equal(byId(scenario.single).prescriptions.length, 1);
    assert.equal(laneFor(scenario.multi), 'needs-action', `${scenario.label} multi missing`);
    assert.equal(byId(scenario.multi).prescriptions.length, 2);
  }

  assert.equal(byId(151).quoteReview?.type, 'patient_price_changed');
  assert.equal(byId(167).quoteReview?.type, 'out_of_stock');
  assert.equal(byId(168).activeQuoteCheck?.status, 'RECONCILIATION_REQUIRED');
  assert.equal(byId(165).cancellation?.status, 'cancelled');
  assert.equal(byId(165).prescriptions.every(rx => rx.purchaseOrderState === 'CANCELLED'), true);
  assert.equal(byId(166).refund?.status, 'pending_confirmation');
  assert.equal(orderStage(byId(164)).stage, 'rejected');
});

test('With Curaleaf and split delivery expose their real internal stages', () => {
  assert.deepEqual([153, 154, 155, 156].map(id => orderStage(byId(id)).stage), [
    'paid',
    'curaleaf-pending',
    'curaleaf-approved',
    'dispatched',
  ]);
  assert.deepEqual([157, 158, 159].map(id => laneFor(id)), ['split', 'ready', 'split']);
  assert.equal(byId(157).prescriptions.some(rx => rx.status === 'dispatched'), true);
  assert.equal(byId(158).prescriptions.some(rx => rx.status === 'ready'), true);
  assert.equal(byId(159).prescriptions.some(rx => rx.status === 'collected'), true);
});

test('history filters have single and multi examples', () => {
  assert.deepEqual([orderStage(byId(105)).stage, orderStage(byId(162)).stage], ['collected', 'collected']);
  assert.deepEqual([orderStage(byId(142)).stage, orderStage(byId(163)).stage], ['archived', 'archived']);
  assert.deepEqual([orderStage(byId(143)).stage, orderStage(byId(164)).stage], ['rejected', 'rejected']);
  assert.equal(orderCancellationResolution(byId(131)), 'refunded');
  assert.equal(orderCancellationResolution(byId(166)), 'needs-action');
});

test('partial supplier cancellation creates one action item without closing its live sibling', () => {
  const order = byId(171);
  const patient = workspace.crm.find(item => item.id === order.patientId) ?? null;
  const items = buildPrescriptionWorkItems({ order, patient });

  assert.equal(items.length, 2);
  assert.equal(items[0]?.prescription?.purchaseOrderState, 'CANCELLED');
  assert.equal(items[0]?.record.stage, 'cancelled');
  assert.equal(orderBoardLane(items[0]!.record), 'needs-action');
  assert.equal(items[1]?.record.stage, 'dispatched');
  assert.equal(orderBoardLane(items[1]!.record), 'curaleaf');
  assert.notEqual(items[0]?.prescription?.purchaseOrderId, items[1]?.prescription?.purchaseOrderId);
});

test('training catalogue stays limited to one product', () => {
  const productIds = new Set(workspace.orders.flatMap(order => order.prescriptions.flatMap(rx => rx.items.map(item => item.productId))));
  assert.equal(productIds.size, 1);
});
