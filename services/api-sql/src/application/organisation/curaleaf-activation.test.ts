import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCuraleafActivation, curaleafActivationChange, manualGoLiveChange, sendGoLiveEmail } from './curaleaf-activation.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';

const pharmacy = (overrides: Partial<OrganisationRecord> = {}) => ({
  id: '9b6e2f0c-6a6a-4c1f-9f55-6b8f6c1a2d3e',
  status: 'ONBOARDING',
  archivedAt: null,
  gphcNumber: '1123456',
  classification: 'STANDARD',
  intakeEnabled: false,
  ...overrides,
}) as OrganisationRecord;

test('live Curaleaf credentials take a new pharmacy live with its eligibility link on', async () => {
  const calls: string[] = [];
  const change = await applyCuraleafActivation({
    updateOrganisationStatus: async (_id, status) => { calls.push(`status:${status}`); },
    updateOrganisationIntakeEnabled: async (_id, on) => { calls.push(`intake:${on}`); },
  }, pharmacy(), 'PRODUCTION');
  assert.equal(change, 'went_live');
  assert.deepEqual(calls, ['status:LIVE', 'intake:true']);
});

test('test credentials never make a pharmacy live, and take a live one back to onboarding', () => {
  assert.equal(curaleafActivationChange(pharmacy(), 'TEST'), null);
  assert.equal(curaleafActivationChange(pharmacy({ status: 'LIVE' }), 'TEST'), 'left_live');
  assert.equal(curaleafActivationChange(pharmacy({ status: 'LIVE' }), 'PRODUCTION'), null);
});

test('a suspended pharmacy stays suspended on any credentials; rejected and training ones are left alone', () => {
  assert.equal(curaleafActivationChange(pharmacy({ status: 'PAUSED' }), 'PRODUCTION'), null);
  assert.equal(curaleafActivationChange(pharmacy({ status: 'PAUSED' }), 'TEST'), null);
  // Live credentials don't take a branch on hold live: HHH lifts the hold first.
  assert.equal(curaleafActivationChange(pharmacy({ status: 'ON_HOLD' }), 'PRODUCTION'), null);
  assert.equal(curaleafActivationChange(pharmacy({ archivedAt: '2026-11-16T00:00:00Z' }), 'PRODUCTION'), null);
  assert.equal(curaleafActivationChange(pharmacy({ gphcNumber: 'TRAINING-PRIMARY' }), 'PRODUCTION'), null);
});

test('the Live email goes once, on the transition to live only, never to a branch already live or on hold', async () => {
  const sent: string[] = [];
  const emails = { wentLive: async (input: { organisationId: string }) => { sent.push(input.organisationId); } };
  const repo = { updateOrganisationStatus: async () => undefined, updateOrganisationIntakeEnabled: async () => undefined };
  const branch = pharmacy();
  await sendGoLiveEmail(emails, branch.id, await applyCuraleafActivation(repo, branch, 'PRODUCTION'));
  // Saved again once live, re-saved as test credentials, held, or onboarding on test: nothing.
  await sendGoLiveEmail(emails, branch.id, await applyCuraleafActivation(repo, pharmacy({ status: 'LIVE' }), 'PRODUCTION'));
  await sendGoLiveEmail(emails, branch.id, await applyCuraleafActivation(repo, pharmacy({ status: 'LIVE' }), 'TEST'));
  await sendGoLiveEmail(emails, branch.id, await applyCuraleafActivation(repo, pharmacy({ status: 'ON_HOLD' }), 'PRODUCTION'));
  await sendGoLiveEmail(emails, branch.id, await applyCuraleafActivation(repo, pharmacy(), 'TEST'));
  assert.deepEqual(sent, [branch.id]);
});

test('a failing Live email never fails saving the credentials', async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await sendGoLiveEmail({ wentLive: async () => { throw new Error('down'); } }, 'org-1', 'went_live');
  } finally {
    console.error = originalError;
  }
});

test('HHH\'s manual Go live sends the same once-only Live email; already live, test and training branches get none', async () => {
  const sent: string[] = [];
  const emails = { wentLive: async (input: { organisationId: string }) => { sent.push(input.organisationId); } };
  const branch = pharmacy();
  assert.equal(manualGoLiveChange(branch), 'went_live');
  await sendGoLiveEmail(emails, branch.id, manualGoLiveChange(branch));
  await sendGoLiveEmail(emails, branch.id, manualGoLiveChange(pharmacy({ status: 'LIVE' })));
  await sendGoLiveEmail(emails, branch.id, manualGoLiveChange(pharmacy({ gphcNumber: 'TRAINING-PRIMARY' })));
  assert.deepEqual(sent, [branch.id]);
});

test('the manual go-live route sends the Live email after the branch goes live', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../transport/portal/setup.router.ts'), 'utf8');
  const handler = source.match(/router\.post\('\/portal\/admin\/organisations\/:id\/go-live',[\s\S]*?router\.post\(/)?.[0];
  assert.ok(handler, 'go-live handler is present');
  const live = handler.indexOf("updateOrganisationStatus(organisationId, 'LIVE')");
  const email = handler.indexOf('sendGoLiveEmail(');
  assert.ok(live > 0 && email > live, 'the Live email is sent once the status is LIVE');
  assert.match(handler, /manualGoLiveChange\(organisation\)/);
});
