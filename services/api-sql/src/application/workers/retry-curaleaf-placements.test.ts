import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import {
  pendingPlacements,
  placementCheckIntervalMs,
  placementRetrySkipReason,
  retryWaitingCuraleafPlacements,
  type PlacementRetryDeps,
} from './retry-curaleaf-placements.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const connection = { organisationId: 'org-1', integration: 'CURALEAF', environment: 'TEST', status: 'ACTIVE', secretResourceName: 'projects/p/secrets/s' } as IntegrationConnectionRecord;

function waitingSnapshot(curaleaf: Record<string, unknown>) {
  return {
    prescriptions: [{ clientKey: 'rx-1', prescriber: { pin: '123', gphcNumber: '000123' } }],
    curaleaf,
    curaleafSubOrders: { 'rx-1': curaleaf },
  };
}

const verificationWait = { prescriberId: 'presc-1', prescriberState: 'UNVERIFIED', waitingFor: 'prescriber_verification', purchaseOrderId: null };

function order(partial: Partial<OrderRecord> & { id: string }): OrderRecord {
  return {
    organisationId: 'org-1',
    patientId: 'patient-1',
    draftId: null,
    orderNumber: `ORD-${partial.id}`,
    status: 'PROCESSING',
    paymentStatus: 'PAID',
    fulfilmentStatus: 'SUPPLIER_PENDING',
    paymentRoute: 'MANUAL',
    currency: 'GBP',
    medicineTotalPence: 1000,
    dispensingFeePence: 0,
    pharmacyDeliveryPence: 0,
    deliveryPence: 0,
    taxPence: 0,
    totalPence: 1000,
    quoteSnapshot: waitingSnapshot(verificationWait),
    version: 1,
    submittedAt: '2026-11-12T15:36:49.000Z',
    paidAt: '2026-11-12T15:36:50.000Z',
    collectedAt: null,
    cancelledAt: null,
    createdAt: '2026-11-12T15:36:49.000Z',
    updatedAt: '2026-11-12T15:37:35.000Z',
    ...partial,
  };
}

function harness(options: { states?: Record<string, string>; lastChecked?: Record<string, string>; placeResult?: unknown } = {}) {
  const calls = { gets: [] as string[], placed: [] as string[], events: [] as Array<{ orderId: string; reason?: string | null }>, recorded: [] as string[], afterPlaced: 0 };
  const deps: PlacementRetryDeps = {
    orderRepo: { async appendPlacementEvent(event) { calls.events.push({ orderId: event.orderId, reason: event.reason }); } },
    checks: {
      async lastCheckedAt(orderId) { return options.lastChecked?.[orderId] ?? null; },
      async recordCheck(row) { calls.recorded.push(row.id); },
    },
    async curaleafGet(_connection, path) {
      calls.gets.push(path);
      const id = path.split('/').filter(Boolean).pop()!;
      return { id, state: options.states?.[id] ?? 'UNVERIFIED' };
    },
    async place(_connection, row) {
      calls.placed.push(row.id);
      return options.placeResult ?? { purchaseOrder: { id: `po-${row.id}` } };
    },
    async afterPlaced() { calls.afterPlaced += 1; },
  };
  return { deps, calls };
}

describe('Curaleaf placement retry', () => {
  it('places held orders once Curaleaf shows the prescriber verified, with one lookup per prescriber', async () => {
    const { deps, calls } = harness({ states: { 'presc-1': 'VERIFIED' } });
    const summary = await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' }), order({ id: 'b' })], deps, { now: NOW });
    assert.deepEqual(calls.placed, ['a', 'b']);
    assert.deepEqual(calls.gets, ['/v1/prescribers/presc-1/']);
    assert.equal(summary.placed, 2);
    assert.equal(calls.afterPlaced, 2);
    assert.match(calls.events[0]!.reason!, /po-a placed automatically/);
  });

  it('leaves an order waiting while the prescriber is still unverified, and records the check', async () => {
    const { deps, calls } = harness();
    const summary = await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' })], deps, { now: NOW });
    assert.deepEqual(calls.placed, []);
    assert.deepEqual(calls.recorded, ['a']);
    assert.equal(summary.stillWaiting, 1);
  });

  it('checks a prescription waiting for activation and places it once active', async () => {
    const wait = { prescriberId: 'presc-1', prescriptionId: 'rx-c', prescriptionState: 'PENDING', waitingFor: 'prescription_activation' };
    const { deps, calls } = harness({ states: { 'rx-c': 'ACTIVE' } });
    await retryWaitingCuraleafPlacements([connection], [order({ id: 'a', quoteSnapshot: waitingSnapshot(wait) })], deps, { now: NOW });
    assert.deepEqual(calls.gets, ['/v1/prescriptions/rx-c/']);
    assert.deepEqual(calls.placed, ['a']);
  });

  it('retries an order whose earlier attempt recorded nothing at Curaleaf', async () => {
    const { deps, calls } = harness();
    await retryWaitingCuraleafPlacements([connection], [order({ id: 'a', quoteSnapshot: { prescriptions: [{ clientKey: 'rx-1' }] } })], deps, { now: NOW });
    assert.deepEqual(calls.gets, []);
    assert.deepEqual(calls.placed, ['a']);
  });

  it('waits out the backoff since the last check', async () => {
    const { deps, calls } = harness({ states: { 'presc-1': 'VERIFIED' }, lastChecked: { a: '2026-11-19T11:30:00.000Z' } });
    await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' })], deps, { now: NOW });
    assert.deepEqual(calls.placed, []);
    const due = harness({ states: { 'presc-1': 'VERIFIED' }, lastChecked: { a: '2026-11-19T10:30:00.000Z' } });
    await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' })], due.deps, { now: NOW });
    assert.deepEqual(due.calls.placed, ['a']);
  });

  it('caps placements per pharmacy per run', async () => {
    const { deps, calls } = harness({ states: { 'presc-1': 'VERIFIED' } });
    const orders = ['a', 'b', 'c', 'd'].map(id => order({ id }));
    await retryWaitingCuraleafPlacements([connection], orders, deps, { now: NOW, maxPlacementsPerConnection: 2 });
    assert.deepEqual(calls.placed, ['a', 'b']);
    assert.deepEqual(calls.recorded, ['a', 'b'], 'orders left for the next run are not marked as checked');
  });

  it('records a purchase order Curaleaf already had, and does not count a skip without one', async () => {
    const found = harness({ states: { 'presc-1': 'VERIFIED' }, placeResult: { skipped: true, reason: 'Purchase order already exists at Curaleaf', purchaseOrder: { id: 'po-old' } } });
    await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' })], found.deps, { now: NOW });
    assert.match(found.calls.events[0]!.reason!, /po-old found at Curaleaf/);
    const held = harness({ states: { 'presc-1': 'VERIFIED' }, placeResult: { skipped: true, reason: 'Quote review required' } });
    const summary = await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' })], held.deps, { now: NOW });
    assert.equal(summary.placed, 0);
    assert.deepEqual(held.calls.events, []);
  });

  it('ignores pharmacies without an active Curaleaf connection', async () => {
    const { deps, calls } = harness({ states: { 'presc-1': 'VERIFIED' } });
    await retryWaitingCuraleafPlacements([connection], [order({ id: 'a', organisationId: 'org-2' })], deps, { now: NOW });
    assert.deepEqual(calls.placed, []);
  });

  it('keeps going when one order fails', async () => {
    const { deps, calls } = harness({ states: { 'presc-1': 'VERIFIED' } });
    const place = deps.place;
    deps.place = async (conn, row) => { if (row.id === 'a') throw new Error('Curaleaf timeout'); return place(conn, row); };
    const summary = await retryWaitingCuraleafPlacements([connection], [order({ id: 'a' }), order({ id: 'b' })], deps, { now: NOW });
    assert.equal(summary.errors, 1);
    assert.deepEqual(calls.placed, ['b']);
  });
});

describe('placementRetrySkipReason', () => {
  it('retries a paid order waiting at Curaleaf', () => {
    assert.equal(placementRetrySkipReason(order({ id: 'a' })), null);
  });

  it('leaves orders that need a person or are finished', () => {
    const snapshot = waitingSnapshot(verificationWait);
    assert.equal(placementRetrySkipReason(order({ id: 'a', paymentStatus: 'PENDING', paidAt: null })), 'not_paid');
    assert.equal(placementRetrySkipReason(order({ id: 'a', status: 'CANCELLED' })), 'closed');
    assert.equal(placementRetrySkipReason(order({ id: 'a', archivedAt: '2026-11-13T00:00:00.000Z' })), 'resolved');
    assert.equal(placementRetrySkipReason(order({ id: 'a', quoteSnapshot: { ...snapshot, quoteReview: { status: 'required', type: 'patient_price_changed', fingerprint: 'f' } } })), 'quote_review');
    assert.equal(placementRetrySkipReason(order({ id: 'a', quoteSnapshot: { ...snapshot, curaleafAttention: { status: 'correction_required' } } })), 'needs_correction');
    assert.equal(placementRetrySkipReason(order({ id: 'a', quoteSnapshot: { ...snapshot, curaleafCancellation: { status: 'confirmed' } } })), 'cancelled');
    assert.equal(placementRetrySkipReason(order({ id: 'a', quoteSnapshot: waitingSnapshot({ ...verificationWait, purchaseOrderId: 'po-1' }) })), 'placed');
  });
});

describe('pendingPlacements', () => {
  it('reads what each unplaced prescription is waiting for', () => {
    assert.deepEqual(pendingPlacements(waitingSnapshot(verificationWait)), [
      { rxIndex: 0, waitingFor: 'prescriber_verification', prescriberId: 'presc-1', prescriptionId: null },
    ]);
  });
});

describe('placementCheckIntervalMs', () => {
  it('checks often at first and hourly after two days', () => {
    const at = (iso: string) => placementCheckIntervalMs({ paidAt: iso, createdAt: iso }, NOW) / 60_000;
    assert.equal(at('2026-11-19T11:00:00.000Z'), 5);
    assert.equal(at('2026-11-18T12:00:00.000Z'), 15);
    assert.equal(at('2026-11-12T15:36:50.000Z'), 60);
  });
});
