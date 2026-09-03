import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateSandboxWorkspace, sandboxOverviewSnapshot, sandboxPatientId } from '../src/training/sandboxPack.ts';
import { WORKSPACE_TOUR_STEPS } from '../src/training/workspaceTour.ts';
import {
  hydrateWorkspaceTourFromPreferences,
  mergeStaffPreferences,
  replayWorkspaceTour,
  setWorkspaceTourCompleted,
  workspaceTourCompleted,
} from '../src/training/workspaceTourPreferences.ts';
import { orderBoardLane } from '../src/utils/orderBoardLanes.ts';
import { orderCancellationResolution, orderIsSplitFulfilment, orderStage } from '../src/utils/orderStage.ts';
import { DEFAULT_ACCESSIBILITY_PREFERENCES } from '../src/accessibility/preferences.ts';

const organisationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const frozen = new Date('2026-09-02T12:00:00.000Z');
const workspace = hydrateSandboxWorkspace(organisationId, frozen);
const byId = (id: number) => {
  const order = workspace.orders.find(item => item.id === id);
  assert.ok(order, `missing sandbox order ${id}`);
  return order;
};
const laneFor = (id: number) => {
  const order = byId(id);
  return orderBoardLane({ order, stage: orderStage(order).stage });
};

test('sandbox pack matches the fill-list people and twelve orders', () => {
  assert.equal(workspace.orders.length, 12);
  assert.equal(workspace.crm.length, 13);
  assert.equal(workspace.enquiries.length, 1);
  assert.equal(workspace.enquiries[0]?.caseReference, 'SBX-ENQ-01');
  assert.equal(workspace.enquiries[0]?.displayStatus, 'New enquiry');

  const casey = workspace.crm.find(patient => patient.id === sandboxPatientId(organisationId, 'casey'));
  const jamie = workspace.crm.find(patient => patient.id === sandboxPatientId(organisationId, 'jamie'));
  const morgan = workspace.crm.find(patient => patient.id === sandboxPatientId(organisationId, 'morgan'));
  assert.equal(casey?.status, 'Referred');
  assert.equal(workspace.orders.some(order => order.patientId === casey?.id), false);
  assert.equal(jamie?.status, 'Referred');
  assert.equal(byId(101).patientId, jamie?.id);
  assert.equal(morgan?.status, 'HHH approved');
  assert.equal(byId(107).patientId, morgan?.id);
  assert.equal(orderStage(byId(107)).stage, 'collected');
});

test('fill-list orders sit in the live lanes the tour points at', () => {
  assert.equal(orderStage(byId(101)).stage, 'awaiting-payment');
  assert.equal(laneFor(101), 'awaiting-payment');
  assert.equal(orderStage(byId(102)).stage, 'curaleaf-pending');
  assert.equal(laneFor(102), 'curaleaf');
  assert.equal(orderStage(byId(103)).stage, 'dispatched');
  assert.equal(laneFor(103), 'curaleaf');
  assert.equal(byId(104).prescriptions[0]?.status, 'received');
  assert.ok(byId(104).prescriptions[0]?.goodsInAt);
  assert.equal(laneFor(104), 'ready');
  assert.equal(orderStage(byId(105)).stage, 'ready');
  assert.equal(laneFor(105), 'ready');
  assert.equal(orderStage(byId(106)).stage, 'curaleaf-approved');
  assert.equal(laneFor(106), 'curaleaf');
  assert.equal(laneFor(108), 'needs-action');
  assert.equal(byId(108).quoteReview?.type, 'patient_price_changed');
  assert.equal(orderCancellationResolution(byId(109)), 'needs-action');
  assert.equal(byId(109).prescriptions[0]?.purchaseOrderState, 'CANCELLED');
  assert.equal(byId(110).refund?.status, 'pending_confirmation');
  assert.equal(orderCancellationResolution(byId(110)), 'needs-action');
  assert.equal(orderIsSplitFulfilment(byId(111)), true);
  assert.equal(laneFor(111), 'split');
  assert.equal(byId(111).prescriptions.length, 1);
  assert.equal(orderStage(byId(112)).stage, 'paid');
  assert.equal(laneFor(112), 'curaleaf');
  assert.ok(byId(112).prescriptions[0]?.items.length);
});

test('sandbox pack is honest: no empty To send draft, Training flower, or fake GMC wall', () => {
  assert.equal(workspace.orders.some(order => order.orderNumber === 'TRAINING-100' || order.payment.status === 'none'), false);
  const names = workspace.orders.flatMap(order => order.prescriptions.flatMap(rx => rx.items.map(item => item.name)));
  assert.equal(names.every(name => name === 'Curaleaf flower 10g'), true);
  assert.equal(workspace.orders.every(order => order.prescriptions.every(rx => !rx.prescriberGmcNumber)), true);
  assert.equal(workspace.orders.every(order => order.prescriptions.every(rx => !rx.carrier)), true);
  const notes = workspace.orders.map(order => order.payment.manualNotes ?? '');
  assert.equal(notes.some(note => note.includes('Training flower') || note.includes('Training courier')), false);
});

test('overview snapshot is precomputed and has no patient names', () => {
  const overview = sandboxOverviewSnapshot(organisationId, frozen, 'Primary Branch');
  assert.equal(overview.enquiries.pendingCount, 1);
  assert.equal(overview.summary.awaitingPayment, 1);
  assert.equal(overview.summary.readyForCollection, 2);
  assert.equal(overview.finance?.payingPatientCount, 1);
  assert.equal(overview.priorityItems.every(item => !item.maskedPatientLabel.includes('Reed') && !item.maskedPatientLabel.includes('Hart')), true);
  assert.equal(overview.priorityItems.every(item => item.maskedPatientLabel.includes('——')), true);
});

test('tour walks every pharmacy section in order', () => {
  assert.deepEqual(WORKSPACE_TOUR_STEPS.map(step => step.screen), [
    'home', 'home', 'home', 'home', 'home',
    'patients', 'patients', 'patients',
    'orders', 'create', 'formulary', 'finance', 'settings',
  ]);
  assert.equal(WORKSPACE_TOUR_STEPS.some(step => /[A-Z][a-z]+ [A-Z][a-z]+/.test(step.body) && step.body.includes('@')), false);
});

test('skip and complete persist on preferences; replay clears the flag', () => {
  hydrateWorkspaceTourFromPreferences(undefined, false);
  assert.equal(workspaceTourCompleted(), false);
  setWorkspaceTourCompleted(true);
  assert.equal(workspaceTourCompleted(), true);
  assert.equal(mergeStaffPreferences(DEFAULT_ACCESSIBILITY_PREFERENCES).workspaceTourCompleted, true);
  replayWorkspaceTour();
  assert.equal(workspaceTourCompleted(), false);
  assert.equal(mergeStaffPreferences(DEFAULT_ACCESSIBILITY_PREFERENCES).workspaceTourCompleted, false);
});
