import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import {
  alertStuckPrescribers,
  prescriberAlertEmail,
  prescriberAlertKey,
  prescriberAlertRecipients,
  stuckPrescriberGroups,
  type PrescriberAlertDeps,
} from './curaleaf-prescriber-alert.js';

const NOW = new Date('2026-11-19T12:00:00.000Z');
const connection = { organisationId: 'org-1', integration: 'CURALEAF', environment: 'PRODUCTION', status: 'ACTIVE', externalCustomerId: 'cust-9', secretResourceName: 'projects/p/secrets/s' } as IntegrationConnectionRecord;
const wait = { prescriberId: 'presc-1', prescriberState: 'UNVERIFIED', waitingFor: 'prescriber_verification', purchaseOrderId: null };

function order(id: string, paidAt: string, partial: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id,
    organisationId: 'org-1',
    patientId: 'patient-1',
    draftId: null,
    orderNumber: `ORD-${id}`,
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
    quoteSnapshot: {
      prescriptions: [{ clientKey: 'rx-1', patient: { name: 'Pat Example' }, prescriber: { name: 'Dr. Prescriber', pin: '123', gmcNumber: null, gphcNumber: '000123' } }],
      curaleaf: wait,
      curaleafSubOrders: { 'rx-1': wait },
    },
    version: 1,
    submittedAt: paidAt,
    paidAt,
    collectedAt: null,
    cancelledAt: null,
    createdAt: paidAt,
    updatedAt: paidAt,
    ...partial,
  };
}

function harness(options: { state?: string; lastSent?: string | null; sendFails?: boolean } = {}) {
  const sent: Array<{ to: string[]; subject: string; paragraphs: string[]; idempotencyKey: string }> = [];
  const recorded: string[] = [];
  const deps: PrescriberAlertDeps = {
    async lastSentAt() { return options.lastSent ?? null; },
    async recordSent(key) { recorded.push(key); },
    async curaleafGet() { return { id: 'presc-1', state: options.state ?? 'UNVERIFIED' }; },
    async pharmacy() { return { name: 'Primary Branch', gphcNumber: '1234567' }; },
    async send(email) {
      if (options.sendFails) throw new Error('Resend down');
      sent.push(email);
    },
  };
  return { deps, sent, recorded };
}

describe('stuck prescriber alert', () => {
  it('sends one forwardable email per pharmacy and prescriber once orders have waited 3 days', async () => {
    const { deps, sent, recorded } = harness();
    const orders = [order('b', '2026-11-13T09:00:00.000Z'), order('a', '2026-11-12T15:36:50.000Z'), order('new', '2026-11-18T09:00:00.000Z')];
    const summary = await alertStuckPrescribers([connection], orders, deps, NOW);
    assert.equal(summary.sent, 1);
    assert.equal(sent.length, 1);
    const email = sent[0]!;
    assert.deepEqual(email.to, ['admin@holistichealthhub.live']);
    assert.equal(email.subject, 'Please verify prescriber Dr. Prescriber for Primary Branch (2 orders waiting)');
    const body = email.paragraphs.join('\n');
    assert.match(body, /waited 6 days/);
    assert.match(body, /Curaleaf customer ID: cust-9/);
    assert.match(body, /PIN: 123/);
    assert.match(body, /GPhC: 000123/);
    assert.match(body, /Curaleaf prescriber ID: presc-1/);
    assert.match(body, /ORD-a \(paid 12 Nov 2026\)\nORD-b \(paid 13 Nov 2026\)/);
    assert.doesNotMatch(body, /ORD-new/, 'orders under 3 days are not listed');
    assert.doesNotMatch(body, /Pat Example/, 'no patient details');
    assert.deepEqual(recorded, [prescriberAlertKey('org-1', 'presc-1')]);
  });

  it('waits 3 days before repeating', async () => {
    const recent = harness({ lastSent: '2026-11-17T12:00:00.000Z' });
    await alertStuckPrescribers([connection], [order('a', '2026-11-12T15:36:50.000Z')], recent.deps, NOW);
    assert.equal(recent.sent.length, 0);
    const due = harness({ lastSent: '2026-11-16T11:00:00.000Z' });
    await alertStuckPrescribers([connection], [order('a', '2026-11-12T15:36:50.000Z')], due.deps, NOW);
    assert.equal(due.sent.length, 1);
  });

  it('says nothing when Curaleaf has verified the prescriber since our last check', async () => {
    const { deps, sent } = harness({ state: 'VERIFIED' });
    await alertStuckPrescribers([connection], [order('a', '2026-11-12T15:36:50.000Z')], deps, NOW);
    assert.equal(sent.length, 0);
  });

  it('does not record a failed send, so the next run tries again', async () => {
    const { deps, recorded } = harness({ sendFails: true });
    const summary = await alertStuckPrescribers([connection], [order('a', '2026-11-12T15:36:50.000Z')], deps, NOW);
    assert.equal(summary.errors, 1);
    assert.deepEqual(recorded, []);
  });

  it('ignores orders waiting for anything other than prescriber verification', () => {
    const activation = { prescriberId: 'presc-1', prescriptionId: 'rx-c', waitingFor: 'prescription_activation' };
    const waitingOnPrescription = order('a', '2026-11-12T15:36:50.000Z', {
      quoteSnapshot: { prescriptions: [{ clientKey: 'rx-1' }], curaleaf: activation, curaleafSubOrders: { 'rx-1': activation } },
    });
    const cancelled = order('b', '2026-11-12T15:36:50.000Z', { status: 'CANCELLED' });
    assert.deepEqual(stuckPrescriberGroups([waitingOnPrescription, cancelled], NOW), []);
  });

  it('marks UAT alerts and reads recipients from config', () => {
    const [group] = stuckPrescriberGroups([order('a', '2026-11-12T15:36:50.000Z')], NOW);
    const email = prescriberAlertEmail(group!, { name: 'Primary Branch', gphcNumber: null }, { externalCustomerId: 'cust-9', environment: 'TEST' }, NOW);
    assert.match(email.subject, /^\[Curaleaf UAT\] /);
    assert.match(email.paragraphs.join('\n'), /Environment: UAT \(test\)/);
    process.env.CURALEAF_STUCK_ALERT_TO = 'ops@example.com, Admin@Example.com';
    try {
      assert.deepEqual(prescriberAlertRecipients(), ['ops@example.com', 'admin@example.com']);
    } finally {
      delete process.env.CURALEAF_STUCK_ALERT_TO;
    }
  });
});

describe('stuck prescriber alert wording', () => {
  it('uses saved admin wording around the pharmacy, prescriber and order details', async () => {
    const { deps, sent } = harness();
    deps.copy = async () => ({ subject: 'Verify [Prescriber] please', body: 'Hi team,\n\n[Pharmacy] has [Order count] [Orders word] waiting [Days] days.' });
    await alertStuckPrescribers([connection], [order('a', '2026-11-12T15:36:50.000Z')], deps, NOW);
    const email = sent[0]!;
    assert.equal(email.subject, 'Verify Dr. Prescriber please');
    assert.equal(email.paragraphs[0], 'Hi team,');
    assert.equal(email.paragraphs[1], 'Primary Branch has 1 order waiting 6 days.');
    assert.match(email.paragraphs.join('\n'), /Curaleaf prescriber ID: presc-1/, 'the details stay automatic');
    assert.match(email.paragraphs.at(-1)!, /Holistic Health Hub/, 'the closing note was not edited, so it is the code’s');
  });
});
