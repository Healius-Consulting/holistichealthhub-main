import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { liftSuspensionStatus, suspendStatus } from './suspension.js';

const pharmacy = (overrides: Partial<OrganisationRecord> = {}) => ({
  id: '9b6e2f0c-6a6a-4c1f-9f55-6b8f6c1a2d3e',
  status: 'LIVE',
  archivedAt: null,
  gphcNumber: '1123456',
  classification: 'STANDARD',
  ...overrides,
}) as OrganisationRecord;

test('a live pharmacy can be suspended, and suspending twice changes nothing', () => {
  assert.equal(suspendStatus(pharmacy()), 'PAUSED');
  assert.equal(suspendStatus(pharmacy({ status: 'PAUSED' })), null);
});

test('only live pharmacies can be suspended', () => {
  for (const status of ['ONBOARDING', 'INTAKE_LIVE'] as const) {
    assert.throws(() => suspendStatus(pharmacy({ status })), { code: 'SUSPEND_NOT_ALLOWED' });
  }
  assert.throws(() => suspendStatus(pharmacy({ archivedAt: '2026-11-16T00:00:00Z' })), { code: 'SUSPEND_NOT_ALLOWED' });
  assert.throws(() => suspendStatus(pharmacy({ id: '70913a30-71c3-4a41-952e-d532927af58c' })), { code: 'SUSPEND_NOT_ALLOWED' });
});

test('lifting returns a pharmacy to live only on live Curaleaf credentials', () => {
  assert.equal(liftSuspensionStatus(pharmacy({ status: 'PAUSED' }), 'PRODUCTION'), 'LIVE');
  assert.equal(liftSuspensionStatus(pharmacy({ status: 'PAUSED' }), 'TEST'), 'ONBOARDING');
  assert.equal(liftSuspensionStatus(pharmacy({ status: 'PAUSED' }), null), 'ONBOARDING');
  assert.equal(liftSuspensionStatus(pharmacy({ status: 'LIVE' }), 'PRODUCTION'), null);
});
