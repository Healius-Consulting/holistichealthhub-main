import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FakeClickupRepository, FakeVisitRepository } from '../../testing/clickup-fakes.js';
import type { ClickupClient } from './clickup-client.js';
import { clickupConfig, type ClickupConfig } from './clickup-config.js';
import { clickupHooks } from './clickup-hooks.js';
import { tokenFromSecret } from './clickup-token.js';
import { CLICKUP_MAX_ATTEMPTS, clickupRetryAt, pruneStaleOnboardingVisits, syncClickup } from './sync-clickup.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');

const config: ClickupConfig = clickupConfig({
  CLICKUP_LIST_ID: 'list-1',
  CLICKUP_FIELD_GPHC: 'f-gphc',
  CLICKUP_FIELD_BRANCH_ID: 'f-branch',
  CLICKUP_FIELD_REQUEST_ID: 'f-request',
  CLICKUP_FIELD_LEGAL_ENTITY: 'f-legal',
  CLICKUP_FIELD_LEAD_SOURCE: 'f-lead',
  CLICKUP_FIELD_PHAR_CODE_ENTERED: 'f-phar',
  CLICKUP_FIELD_API_KEY_ENTERED: 'f-key',
  CLICKUP_FIELD_SETUP_COMPLETE: 'f-setup',
  CLICKUP_FIELD_CHECKLIST_PERCENT: 'f-checklist',
})!;

type Call = { op: string; args: unknown[] };

class MockClickup implements ClickupClient {
  calls: Call[] = [];
  tasks = new Map<string, { status: string; name: string; fields: Map<string, unknown> }>();
  failNext = 0;

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('ClickUp returned 503');
    }
  }

  async findTaskByField(listId: string, fieldId: string, value: string) {
    this.calls.push({ op: 'find', args: [listId, fieldId, value] });
    this.maybeFail();
    for (const [id, task] of this.tasks) if (task.fields.get(fieldId) === value) return id;
    return null;
  }

  async createTask(listId: string, task: { name: string; status: string; customFields: Array<{ id: string; value: unknown }> }) {
    this.calls.push({ op: 'create', args: [listId, task] });
    this.maybeFail();
    const id = `task-${this.tasks.size + 1}`;
    this.tasks.set(id, { status: task.status, name: task.name, fields: new Map(task.customFields.map(field => [field.id, field.value])) });
    return id;
  }

  async updateTask(taskId: string, change: { name?: string; status?: string }) {
    this.calls.push({ op: 'update', args: [taskId, change] });
    this.maybeFail();
    const task = this.tasks.get(taskId)!;
    if (change.status) task.status = change.status;
    if (change.name) task.name = change.name;
  }

  async setField(taskId: string, fieldId: string, value: unknown) {
    this.calls.push({ op: 'field', args: [taskId, fieldId, value] });
    this.maybeFail();
    this.tasks.get(taskId)!.fields.set(fieldId, value);
  }

  comments: Array<[string, string]> = [];
  async addComment(taskId: string, text: string) {
    this.calls.push({ op: 'comment', args: [taskId, text] });
    this.maybeFail();
    this.comments.push([taskId, text]);
  }
}

const request = {
  id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11',
  gphcNumber: '1234567',
  pharmacyName: 'Shah Pharmacy',
  registeredCompanyName: 'Shah Health Ltd',
  deliveryAddress: '1 High Street, Leeds, LS1 1AA',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
};
const branch = {
  id: '70913a30-71c3-4a41-952e-d532927af58c',
  gphcNumber: '1234567',
  name: 'Shah Pharmacy',
  tradingName: 'Shah Health Ltd',
  address: '1 High Street, Leeds, LS1 1AA',
  classification: 'STANDARD',
};

function setup(options: { config?: ClickupConfig | null; token?: string | null } = {}) {
  const repo = new FakeClickupRepository();
  const visits = new FakeVisitRepository();
  const clickup = new MockClickup();
  let tick = 0;
  const hooks = clickupHooks({ clickupRepo: repo, visitRepo: visits, now: () => new Date(NOW.getTime() + (tick++) * 1_000) });
  let now = NOW;
  const run = () => syncClickup({
    clickupRepo: repo,
    config: () => (options.config === undefined ? config : options.config),
    token: async () => (options.token === undefined ? 'pk_test' : options.token),
    client: () => clickup,
    now: () => now,
  });
  return { repo, visits, clickup, hooks, run, setNow: (value: Date) => { now = value; } };
}

let originalWarn: typeof console.warn;
beforeEach(() => {
  originalWarn = console.warn;
  console.warn = () => undefined;
});
afterEach(() => {
  console.warn = originalWarn;
});

describe('syncClickup', () => {
  it('creates one card at Interest and moves that same card through the journey', async () => {
    const { repo, clickup, hooks, run } = setup();
    await hooks.firstVisit({ gphcNumber: '1234567', pharmsmartPharmacyId: '30', tradingName: 'Shah Pharmacy' });
    let summary = await run();
    assert.equal(summary.sent, 1);
    assert.equal(clickup.tasks.size, 1);
    assert.equal(clickup.tasks.get('task-1')!.status, 'Interest');
    assert.equal(clickup.tasks.get('task-1')!.name, 'Shah Pharmacy (GPhC 1234567)');

    await hooks.requestSubmitted(request);
    await run();
    assert.equal(clickup.tasks.get('task-1')!.status, 'Awaiting activation');

    await hooks.held({ ...request, reason: 'MORE_INFORMATION_NEEDED', heldAt: '2026-11-18T12:05:00.000Z' });
    await run();
    assert.equal(clickup.tasks.get('task-1')!.status, 'On hold');

    await hooks.unheld(request);
    await run();
    assert.equal(clickup.tasks.get('task-1')!.status, 'Awaiting activation');
    assert.deepEqual(clickup.comments, [['task-1', 'On hold: B. More information needed'], ['task-1', 'Hold lifted']]);

    await hooks.activated({ requestId: request.id, organisation: branch });
    await run();
    const task = clickup.tasks.get('task-1')!;
    assert.equal(task.status, 'Awaiting Curaleaf');
    assert.equal(task.fields.get('f-branch'), branch.id);
    assert.equal(task.fields.get('f-request'), request.id);

    await hooks.curaleafConnectionSaved({ organisation: branch, pharCodeEntered: true, apiKeyEntered: true, wentLive: true });
    summary = await run();
    assert.equal(summary.sent, 3);
    assert.equal(task.status, 'Live');
    assert.equal(task.fields.get('f-phar'), true);
    assert.equal(task.fields.get('f-key'), true);
    assert.equal(task.fields.get('f-setup'), true);

    await hooks.checklistProgress({ organisation: branch, percent: 60 });
    await run();
    assert.equal(task.fields.get('f-checklist'), 60);
    assert.equal(task.status, 'Live');

    assert.equal(clickup.tasks.size, 1, 'never a second card');
    assert.equal(clickup.calls.filter(call => call.op === 'create').length, 1);
    assert.equal(repo.cards.get('1234567')!.clickupTaskId, 'task-1');
    assert.equal(repo.cards.get('1234567')!.organisationId, branch.id);
  });

  it('marks a Worldpay application on the card: payment route, a comment with the reference, then validated', async () => {
    const { clickup, hooks, run } = setup({ config: { ...config, fields: { ...config.fields, worldpayValidated: 'f-wp-valid', paymentRoute: 'f-payment' } } });
    await hooks.activated({ requestId: request.id, organisation: branch });
    await run();
    await hooks.worldpaySubmitted({ gphcNumber: '1234567', organisationId: branch.id, reference: 'HHH-WP-2026-0001', submittedAt: '2026-11-18T12:00:00.000Z' });
    await run();
    const task = clickup.tasks.get('task-1')!;
    assert.equal(task.status, 'Awaiting Curaleaf', 'a Worldpay event never moves the column');
    assert.equal(task.fields.get('f-payment'), 'WORLDPAY');
    assert.deepEqual(clickup.comments, [['task-1', 'Worldpay application HHH-WP-2026-0001 submitted 18 November 2026']]);
    await hooks.worldpayValidated({ gphcNumber: '1234567', organisationId: branch.id });
    await run();
    assert.equal(task.fields.get('f-wp-valid'), true);
  });

  it('creates the card at Awaiting activation when the pharmacy never came through PharmSmart', async () => {
    const { clickup, hooks, run } = setup();
    await hooks.requestSubmitted(request);
    await run();
    assert.equal(clickup.tasks.get('task-1')!.status, 'Awaiting activation');
    assert.equal(clickup.tasks.get('task-1')!.fields.get('f-lead'), 'Onboarding page');
  });

  it('finds the card already in ClickUp when our record of it was lost, instead of creating another', async () => {
    const { repo, clickup, hooks, run } = setup();
    await hooks.requestSubmitted(request);
    await run();
    repo.cards.clear();
    await hooks.activated({ requestId: request.id, organisation: branch });
    await run();
    assert.equal(clickup.tasks.size, 1);
    assert.equal(clickup.tasks.get('task-1')!.status, 'Awaiting Curaleaf');
  });

  it('moves a hold to its column by reason, comments the reason on every hold or change', async () => {
    const { clickup, hooks, run } = setup();
    await hooks.requestSubmitted(request);
    await hooks.held({ ...request, reason: 'EXISTING_CURALEAF_CUSTOMER', heldAt: '2026-11-18T12:00:00.000Z' });
    await run();
    const task = clickup.tasks.get('task-1')!;
    assert.equal(task.status, 'Existing Curaleaf — hold');
    await hooks.held({ ...request, reason: 'CURALEAF_DECLINED', heldAt: '2026-11-18T13:00:00.000Z', previousReason: 'EXISTING_CURALEAF_CUSTOMER' });
    await run();
    assert.equal(task.status, 'On hold');
    await hooks.held({ ...request, reason: 'MORE_INFORMATION_NEEDED', heldAt: '2026-11-18T14:00:00.000Z', previousReason: 'CURALEAF_DECLINED' });
    await run();
    assert.equal(task.status, 'On hold');
    assert.deepEqual(clickup.comments.map(([, text]) => text), [
      'On hold: A. Existing Curaleaf customer',
      'Hold reason changed to C. Curaleaf declined (was A. Existing Curaleaf customer)',
      'Hold reason changed to B. More information needed (was C. Curaleaf declined)',
    ]);
  });

  it('lifts a pending hold back to Awaiting activation, and an activated branch\'s back to where it sat', async () => {
    const { clickup, hooks, run } = setup();
    await hooks.activated({ requestId: request.id, organisation: branch });
    await hooks.held({ ...request, organisationId: branch.id, reason: 'MORE_INFORMATION_NEEDED', heldAt: '2026-11-18T12:00:00.000Z' });
    await hooks.unheld({ ...request, organisationId: branch.id });
    await run();
    const task = clickup.tasks.get('task-1')!;
    assert.equal(task.status, 'Awaiting Curaleaf');

    // With both Curaleaf details in (test credentials, so not live) it was in Setup.
    await hooks.curaleafConnectionSaved({ organisation: branch, pharCodeEntered: true, apiKeyEntered: true, wentLive: false });
    await run();
    assert.equal(task.status, 'Setup');
    await hooks.held({ ...request, organisationId: branch.id, reason: 'EXISTING_CURALEAF_CUSTOMER', heldAt: '2026-11-18T13:00:00.000Z' });
    await run();
    assert.equal(task.status, 'Existing Curaleaf — hold');
    await hooks.unheld({ ...request, organisationId: branch.id });
    await run();
    assert.equal(task.status, 'Setup');
    assert.equal(clickup.comments.at(-1)?.[1], 'Hold lifted');
  });

  it('retries a ClickUp failure with backoff and holds the card\'s later events behind it', async () => {
    const { repo, clickup, hooks, run, setNow } = setup();
    await hooks.requestSubmitted(request);
    await hooks.held({ ...request, reason: 'CURALEAF_DECLINED', heldAt: '2026-11-18T12:05:00.000Z' });
    clickup.failNext = 1;
    let summary = await run();
    assert.equal(summary.retried, 1);
    assert.equal(summary.waiting, 1);
    assert.equal(clickup.tasks.size, 0);
    const first = repo.outbox[0]!;
    assert.equal(first.status, 'PENDING');
    assert.equal(first.attemptCount, 1);
    assert.equal(first.nextAttemptAt, clickupRetryAt(NOW, 1).toISOString());

    // Not due yet: nothing is sent, and the held event doesn't jump the queue.
    summary = await run();
    assert.equal(summary.sent, 0);
    assert.equal(summary.waiting, 2);

    setNow(new Date(NOW.getTime() + 6 * 60_000));
    summary = await run();
    assert.equal(summary.sent, 2);
    assert.equal(clickup.tasks.get('task-1')!.status, 'On hold');
  });

  it('backs off exponentially, capped at six hours, and gives up after the last attempt', async () => {
    assert.equal(clickupRetryAt(NOW, 1).getTime() - NOW.getTime(), 5 * 60_000);
    assert.equal(clickupRetryAt(NOW, 3).getTime() - NOW.getTime(), 20 * 60_000);
    assert.equal(clickupRetryAt(NOW, 20).getTime() - NOW.getTime(), 360 * 60_000);

    const { repo, clickup, hooks, run } = setup();
    await hooks.requestSubmitted(request);
    repo.outbox[0]!.attemptCount = CLICKUP_MAX_ATTEMPTS - 1;
    clickup.failNext = 1;
    const summary = await run();
    assert.equal(summary.failed, 1);
    assert.equal(repo.outbox[0]!.status, 'FAILED');
  });

  it('leaves every event queued, without throwing, until ClickUp is configured', async () => {
    for (const options of [{ config: null }, { token: null }]) {
      const { repo, clickup, hooks, run } = setup(options);
      await hooks.requestSubmitted(request);
      const summary = await run();
      assert.equal(summary.notConfigured, true);
      assert.equal(summary.waiting, 1);
      assert.equal(repo.outbox[0]!.status, 'PENDING');
      assert.equal(repo.outbox[0]!.attemptCount, 0);
      assert.equal(clickup.calls.length, 0);
    }
  });

  it('sends no personal or patient details to ClickUp', async () => {
    const { clickup, hooks, run } = setup();
    await hooks.requestSubmitted({ ...request, pharmacistName: 'Asha Shah', pharmacyEmail: 'shop@shah.test' } as typeof request);
    await hooks.activated({ requestId: request.id, organisation: { ...branch, mainContactEmail: 'owner@shah.test' } as typeof branch });
    await run();
    const sent = JSON.stringify(clickup.calls);
    for (const banned of ['Asha Shah', 'shop@shah.test', 'owner@shah.test', 'High Street']) {
      assert.ok(!sent.includes(banned), `${banned} must not reach ClickUp`);
    }
  });
});

describe('ClickUp config and token', () => {
  it('is unset without a list id, and defaults the status names to the brief\'s', () => {
    assert.equal(clickupConfig({}), null);
    const configured = clickupConfig({ CLICKUP_LIST_ID: 'list-1', CLICKUP_STATUS_LIVE: 'LIVE ✅' })!;
    assert.equal(configured.statuses.awaiting_activation, 'Awaiting activation');
    assert.equal(configured.statuses.live, 'LIVE ✅');
    assert.deepEqual(configured.fields, {});
  });

  it('reads the token as text or as JSON', () => {
    assert.equal(tokenFromSecret(' pk_123 \n'), 'pk_123');
    assert.equal(tokenFromSecret('{"token":"pk_456"}'), 'pk_456');
    assert.equal(tokenFromSecret(''), null);
    assert.equal(tokenFromSecret('{"nope":1}'), null);
  });
});

describe('pruneStaleOnboardingVisits', () => {
  it('clears a visit after 12 months with no submission, and keeps newer or submitted ones', async () => {
    const visitRepo = new FakeVisitRepository();
    const add = (gphcNumber: string, firstVisitAt: string, submittedAt: string | null = null) => {
      visitRepo.visits.set(gphcNumber, { gphcNumber, pharmsmartPharmacyId: null, tradingName: null, firstVisitAt, submittedAt });
    };
    add('1111111', '2025-11-17T09:00:00.000Z');
    add('2222222', '2025-11-19T09:00:00.000Z');
    add('3333333', '2025-01-01T09:00:00.000Z', '2025-02-01T09:00:00.000Z');
    add('4444444', '2025-01-01T09:00:00.000Z');
    const summary = await pruneStaleOnboardingVisits({
      visitRepo,
      findLatestRequest: async gphcNumber => (gphcNumber === '4444444' ? { id: 'request-4' } : null),
      now: () => new Date('2026-11-18T09:00:00.000Z'),
    });
    assert.deepEqual(summary, { examined: 2, deleted: 1, keptSubmitted: 1, failed: 0 });
    assert.deepEqual([...visitRepo.visits.keys()].sort(), ['2222222', '3333333', '4444444']);
    assert.ok(visitRepo.visits.get('4444444')!.submittedAt);
  });
});
