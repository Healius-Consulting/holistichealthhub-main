import assert from 'node:assert/strict';
import test from 'node:test';
import { trainingWorkspace } from '../src/training/workspace.ts';
import {
  orderHasPartialCollection,
  orderHasPartialCuraleafDispense,
  orderHasPartialPharmacyReceipt,
  orderIsSplitFulfilment,
  orderSplitPackSnapshot,
  orderStage,
} from '../src/utils/orderStage.ts';

const workspace = trainingWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const byId = (id: number) => {
  const order = workspace.orders.find(item => item.id === id);
  assert.ok(order, `missing training order ${id}`);
  return order;
};

test('training workspace covers the happy-path order stages', () => {
  assert.equal(orderStage(byId(101)).stage, 'awaiting-payment');
  assert.equal(orderStage(byId(102)).stage, 'curaleaf-pending');
  assert.equal(orderStage(byId(103)).stage, 'dispatched');
  assert.equal(orderStage(byId(104)).stage, 'ready');
  assert.equal(orderStage(byId(105)).stage, 'collected');
});

test('training workspace shows every split-dispensed state', () => {
  assert.equal(orderHasPartialCuraleafDispense(byId(111)), true);
  assert.equal(orderIsSplitFulfilment(byId(111)), true);

  const firstShipment = orderSplitPackSnapshot(byId(112));
  assert.equal(orderIsSplitFulfilment(byId(112)), true);
  assert.equal(firstShipment.inTransit, 1);
  assert.equal(firstShipment.withCuraleaf, 1);

  const mixedArrival = orderSplitPackSnapshot(byId(113));
  assert.equal(orderIsSplitFulfilment(byId(113)), true);
  assert.equal(mixedArrival.atPharmacy, 1);
  assert.equal(mixedArrival.inTransit, 1);

  assert.equal(orderHasPartialPharmacyReceipt(byId(114)), true);
  assert.equal(orderIsSplitFulfilment(byId(114)), true);

  assert.equal(orderHasPartialCollection(byId(115)), true);
  assert.equal(orderIsSplitFulfilment(byId(115)), true);
});

test('training workspace shows quote review, cancelled replacements, and exception outcomes', () => {
  assert.equal(byId(121).quoteReview?.status, 'required');
  assert.equal(byId(121).quoteReview?.type, 'patient_price_changed');
  assert.ok((byId(121).quoteReview?.patientDeltaPence ?? 0) > 0);
  assert.ok((byId(122).quoteReview?.patientDeltaPence ?? 0) < 0);
  assert.equal(byId(123).quoteReview?.type, 'out_of_stock');
  assert.equal(byId(124).quoteReview?.type, 'supplier_cost_changed');
  assert.equal(byId(125).quoteReview?.status, 'required');
  assert.equal(byId(126).quoteReview?.status, 'required');

  assert.equal(byId(131).refund?.status, 'completed');
  assert.equal(byId(132).redoContext?.isPaidRedo, false);
  assert.equal(byId(134).redoContext?.isPaidRedo, true);
  assert.equal(byId(134).redoContext?.priceResolution, 'absorb');
  assert.equal(byId(136).redoContext?.isPaidRedo, true);
  assert.equal(byId(136).redoContext?.priceResolution, undefined);

  assert.equal(orderStage(byId(141)).stage, 'cancelled');
  assert.equal(orderStage(byId(142)).stage, 'archived');
  assert.equal(orderStage(byId(143)).stage, 'rejected');
  assert.equal(byId(144).refund?.status, 'pending_confirmation');
});
