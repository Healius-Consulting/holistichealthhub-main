import assert from 'node:assert/strict';
import test from 'node:test';
import { trainingWorkspace } from '../src/training/workspace.ts';
import { orderIsSplitFulfilment, orderStage } from '../src/utils/orderStage.ts';

const workspace = trainingWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const byId = (id: number) => {
  const order = workspace.orders.find(item => item.id === id);
  assert.ok(order, `missing training order ${id}`);
  return order;
};

test('training workspace is the minimum CRM drill set', () => {
  assert.deepEqual(workspace.orders.map(order => order.id), [100, 101, 102, 104, 105, 112, 121, 131, 132]);
  assert.equal(new Set(workspace.orders.map(order => order.patientId)).size, workspace.crm.length);
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

test('training catalogue stays limited to one product', () => {
  const productIds = new Set(workspace.orders.flatMap(order => order.prescriptions.flatMap(rx => rx.items.map(item => item.productId))));
  assert.equal(productIds.size, 1);
});
