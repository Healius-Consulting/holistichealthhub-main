import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ORDER_BOARD_LANES,
  orderBoardLane,
  orderBoardSection,
  orderBoardSlug,
  orderCardStageLabel,
  orderCardTagLabel,
  orderSplitCardLabel,
  recordAwaitingPayment,
  recordNeedsAction,
  recordReadyToCollect,
  type OrderBoardLane,
} from '../src/utils/orderBoardLanes.ts';
import { orderStage, type OrderStage } from '../src/utils/orderStage.ts';
import type { PatientOrder } from '../src/context/AppContext.tsx';

function line(partial: Record<string, unknown>) {
  return {
    productId: 'p1',
    ordered: 0,
    shipped: 0,
    received: 0,
    remaining: 0,
    collected: 0,
    requested: 0,
    sent: null,
    supplierReportedOrdered: 0,
    allocated: 0,
    returned: 0,
    backordered: false,
    quantityMismatch: false,
    ...partial,
  };
}

function record(order: Partial<PatientOrder>, stage: OrderStage) {
  return { order: { date: new Date(), prescriptions: [], payment: { status: 'paid' }, ...order } as PatientOrder, stage };
}

test('every live stage lands in exactly one lane', () => {
  const liveStages: OrderStage[] = ['awaiting-payment', 'paid', 'curaleaf-pending', 'curaleaf-approved', 'dispatched', 'delivered', 'ready', 'rejected'];
  const laneKeys = new Set(ORDER_BOARD_LANES.map(lane => lane.key));
  for (const stage of liveStages) {
    const lane = orderBoardLane(record({}, stage));
    assert.equal(laneKeys.has(lane), true, `${stage} produced unknown lane ${lane}`);
  }
});

test('lane assignment follows the documented stage mapping', () => {
  const expected: Array<[OrderStage, OrderBoardLane]> = [
    ['awaiting-payment', 'awaiting-payment'],
    ['paid', 'curaleaf'],
    ['curaleaf-pending', 'curaleaf'],
    ['curaleaf-approved', 'curaleaf'],
    ['dispatched', 'curaleaf'],
    ['delivered', 'ready'],
    ['ready', 'ready'],
    ['rejected', 'needs-action'],
  ];
  for (const [stage, lane] of expected) {
    assert.equal(orderBoardLane(record({}, stage)), lane, `${stage} should sit in ${lane}`);
  }
});

test('awaiting payment is its own lane and is not mixed into needs action exceptions', () => {
  const awaiting = record({ payment: { status: 'sent', amount: 120 } as PatientOrder['payment'] }, 'awaiting-payment');
  assert.equal(orderBoardLane(awaiting), 'awaiting-payment');
  assert.equal(recordAwaitingPayment(awaiting), true);
  // Still "work a human must pick up" for the summary tiles, just not an exception.
  assert.equal(recordNeedsAction(awaiting), true);

  const quoteReview = record({ quoteReview: { status: 'required' } as PatientOrder['quoteReview'] }, 'awaiting-payment');
  assert.equal(orderBoardLane(quoteReview), 'needs-action', 'an open quote review outranks the payment chase');
});

test('an open cancellation outranks wherever the packs are', () => {
  const cancelling = record({
    lifecycleStatus: 'cancelled',
    payment: { status: 'paid' } as PatientOrder['payment'],
    cancellation: { status: 'refund_required' } as PatientOrder['cancellation'],
    prescriptions: [{ status: 'cancelled' }] as PatientOrder['prescriptions'],
  }, 'delivered');
  assert.equal(orderBoardLane(cancelling), 'needs-action');
});

test('checked-in packs move to ready even while supplier remainder stays open', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'partially-received',
      fulfilmentLines: [line({ ordered: 5, shipped: 2, received: 2, remaining: 3, allocated: 2 })],
    }],
  } as PatientOrder;
  const resolved = orderStage(order);
  assert.equal(orderBoardLane({ order, stage: resolved.stage }), 'ready');
});

test('a split order with collectable packs stays in the handout queue', () => {
  // Ready outranks split: if a pack can be handed over now, the counter must see it.
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'ready',
      fulfilmentLines: [line({ ordered: 5, shipped: 2, received: 2, remaining: 3, allocated: 2 })],
    }],
  } as PatientOrder;
  const stage = orderStage(order).stage;
  assert.equal(stage, 'ready');
  assert.equal(orderBoardLane({ order, stage }), 'ready');
  assert.equal(recordReadyToCollect({ order, stage }), true);
  // The split state is not lost — it moves onto the card.
  assert.equal(orderSplitCardLabel({ order, stage }), '2/5 ready');
});

test('partial collection with remainder awaiting dispatch sits with Curaleaf, not ready to collect', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'partially-received',
      fulfilmentLines: [line({ ordered: 2, shipped: 1, received: 1, remaining: 1, allocated: 2, collected: 1 })],
    }],
  } as PatientOrder;
  const stage = orderStage(order).stage;
  assert.equal(stage, 'curaleaf-approved');
  assert.equal(orderBoardLane({ order, stage }), 'curaleaf');
  assert.equal(recordReadyToCollect({ order, stage }), false);
  assert.equal(orderBoardSection({ order, stage }, 'curaleaf', 'x').key, 'preparing');
  assert.equal(orderSplitCardLabel({ order, stage }), '1/2 collected');
});

test('split card label names the stage the fraction refers to', () => {
  const inTransit = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'partially-received',
      fulfilmentLines: [line({ ordered: 5, shipped: 4, received: 2, remaining: 1, allocated: 4 })],
    }],
  } as PatientOrder;
  assert.equal(orderSplitCardLabel({ order: inTransit, stage: 'dispatched' }), '2/5 arrived');

  const awaitingDispatch = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'partially-received',
      fulfilmentLines: [line({ ordered: 5, shipped: 2, received: 2, remaining: 3, allocated: 2 })],
    }],
  } as PatientOrder;
  assert.equal(orderSplitCardLabel({ order: awaitingDispatch, stage: 'dispatched' }), '2/5 arrived');

  const notSplit = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'received', fulfilmentLines: [line({ ordered: 2, shipped: 2, received: 2, allocated: 2 })] }],
  } as PatientOrder;
  assert.equal(orderSplitCardLabel({ order: notSplit, stage: 'delivered' }), null);
});

test('card stage copy never names the supplier', () => {
  const stages: OrderStage[] = ['awaiting-payment', 'paid', 'curaleaf-pending', 'curaleaf-approved', 'dispatched', 'delivered', 'ready', 'collected', 'rejected', 'archived', 'cancelled'];
  for (const stage of stages) {
    const label = orderCardStageLabel(stage, 'Curaleaf Fallback');
    assert.equal(/curaleaf/i.test(label), false, `${stage} card label leaked the supplier name: ${label}`);
  }
});

test('sectioning is total: every live stage gets a section inside its own lane', () => {
  const liveStages: OrderStage[] = ['awaiting-payment', 'paid', 'curaleaf-pending', 'curaleaf-approved', 'dispatched', 'delivered', 'ready', 'rejected'];
  for (const stage of liveStages) {
    const entry = record({}, stage);
    const section = orderBoardSection(entry, orderBoardLane(entry), 'Needs action');
    assert.equal(typeof section.key, 'string');
    assert.equal(section.key.length > 0, true, `${stage} produced an empty section key`);
    assert.equal(section.label.length > 0, true, `${stage} produced an empty section label`);
  }
});

test('the With Curaleaf lane breaks down into its four real waits', () => {
  const seen = new Map<string, string>();
  for (const stage of ['paid', 'curaleaf-pending', 'curaleaf-approved', 'dispatched'] as OrderStage[]) {
    const section = orderBoardSection(record({}, stage), 'curaleaf', 'unused');
    seen.set(section.key, section.label);
  }
  assert.deepEqual([...seen.keys()], ['to-send', 'rx-check', 'preparing', 'in-transit']);
});

test('a section heading and the card tag under it never say the same thing twice', () => {
  // The board hides a tag whose slug matches its section key, so these must agree.
  assert.equal(orderBoardSection(record({}, 'curaleaf-pending'), 'curaleaf', 'unused').key, orderBoardSlug(orderCardTagLabel('Prescription check')));
  assert.equal(orderBoardSection(record({}, 'curaleaf-approved'), 'curaleaf', 'unused').key, orderBoardSlug(orderCardTagLabel('Being prepared')));
  assert.equal(orderBoardSection(record({}, 'dispatched'), 'curaleaf', 'unused').key, orderBoardSlug(orderCardTagLabel('In transit')));
  // Exceptions section on the card's own status, so they always match by construction.
  assert.equal(orderBoardSection(record({}, 'rejected'), 'needs-action', 'Quote review').key, orderBoardSlug('Quote review'));
});

test('the split lane is inbound only and does not invent part-here headings', () => {
  const noneHere = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'dispatched', fulfilmentLines: [line({ ordered: 2, shipped: 1, received: 0, remaining: 1, allocated: 1 })] }],
  } as PatientOrder;
  const someHere = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'partially-received', fulfilmentLines: [line({ ordered: 2, shipped: 1, received: 1, remaining: 1, allocated: 1 })] }],
  } as PatientOrder;
  assert.equal(orderBoardLane({ order: noneHere, stage: 'dispatched' }), 'split');
  assert.equal(orderBoardSection({ order: noneHere, stage: 'dispatched' }, 'split', 'x').key, 'split-inbound');
  // Packs on the shelf leave Split delivery, so those headings never appear live.
  assert.equal(orderBoardLane({ order: someHere, stage: 'ready' }), 'ready');
  assert.notEqual(orderBoardSection({ order: someHere, stage: 'ready' }, orderBoardLane({ order: someHere, stage: 'ready' }), 'x').key, 'split-here');
});
