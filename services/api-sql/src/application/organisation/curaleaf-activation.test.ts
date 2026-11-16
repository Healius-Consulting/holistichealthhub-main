import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCuraleafActivation, curaleafActivationChange } from './curaleaf-activation.js';
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

test('an old paused pharmacy goes live on live credentials; rejected and training ones are left alone', () => {
  assert.equal(curaleafActivationChange(pharmacy({ status: 'PAUSED' }), 'PRODUCTION'), 'went_live');
  assert.equal(curaleafActivationChange(pharmacy({ archivedAt: '2026-11-16T00:00:00Z' }), 'PRODUCTION'), null);
  assert.equal(curaleafActivationChange(pharmacy({ gphcNumber: 'TRAINING-PRIMARY' }), 'PRODUCTION'), null);
});
