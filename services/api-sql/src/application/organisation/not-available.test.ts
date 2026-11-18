import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import {
  clearNotAvailableStatus,
  clearPharmacyNotAvailable,
  markPharmacyNotAvailable,
  notAvailableStatus,
  type NotAvailableDeps,
} from './not-available.js';

const pharmacy = (overrides: Partial<OrganisationRecord> = {}) => ({
  id: '9b6e2f0c-6a6a-4c1f-9f55-6b8f6c1a2d3e',
  status: 'ONBOARDING',
  archivedAt: null,
  gphcNumber: '1123456',
  classification: 'STANDARD',
  intakeEnabled: true,
  ...overrides,
}) as OrganisationRecord;

function memory(requestId: string | null = 'req-1') {
  const calls: string[] = [];
  const audits: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const clickup: unknown[] = [];
  const deps: NotAvailableDeps = {
    organisations: {
      async updateOrganisationStatus(id, status) { calls.push(`status:${status}`); },
      async updateOrganisationIntakeEnabled(id, enabled) { calls.push(`intake:${enabled}`); },
    },
    clickup: { async notAvailable(input) { clickup.push(input); } },
    findRequestIdByOrganisation: async () => requestId,
    audit: async input => { audits.push(input); },
  };
  return { deps, calls, audits, clickup };
}

test('only a pharmacy awaiting Curaleaf can be marked Not available, and marking twice changes nothing', () => {
  assert.equal(notAvailableStatus(pharmacy()), 'NOT_AVAILABLE');
  assert.equal(notAvailableStatus(pharmacy({ status: 'INTAKE_LIVE' })), 'NOT_AVAILABLE');
  assert.equal(notAvailableStatus(pharmacy({ status: 'NOT_AVAILABLE' })), null);
  for (const status of ['LIVE', 'PAUSED'] as const) {
    assert.throws(() => notAvailableStatus(pharmacy({ status })), { code: 'NOT_AVAILABLE_NOT_ALLOWED' });
  }
  assert.throws(() => notAvailableStatus(pharmacy({ archivedAt: '2026-11-16T00:00:00Z' })), { code: 'NOT_AVAILABLE_NOT_ALLOWED' });
  assert.throws(() => notAvailableStatus(pharmacy({ id: '70913a30-71c3-4a41-952e-d532927af58c' })), { code: 'NOT_AVAILABLE_NOT_ALLOWED' });
});

test('marking Not available turns intake off, is audited and tells ClickUp', async () => {
  const { deps, calls, audits, clickup } = memory();
  const result = await markPharmacyNotAvailable(deps, pharmacy(), 'Existing Curaleaf customer');
  assert.deepEqual(result, { status: 'not_available', changed: true });
  assert.deepEqual(calls, ['status:NOT_AVAILABLE', 'intake:false']);
  assert.deepEqual(audits.map(row => row.event), ['organisation.not_available']);
  assert.deepEqual(audits[0]!.details, { reason: 'Existing Curaleaf customer' });
  assert.deepEqual(clickup, [{ gphcNumber: '1123456', organisationId: pharmacy().id, onboardingRequestId: 'req-1' }]);
});

test('marking an already Not available pharmacy again writes nothing and sends ClickUp nothing', async () => {
  const { deps, calls, audits, clickup } = memory();
  const result = await markPharmacyNotAvailable(deps, pharmacy({ status: 'NOT_AVAILABLE', intakeEnabled: false }));
  assert.deepEqual(result, { status: 'not_available', changed: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(audits, []);
  assert.deepEqual(clickup, []);
});

test('a branch HHH added by hand still reaches ClickUp, keyed by its GPhC', async () => {
  const { deps, clickup } = memory(null);
  await markPharmacyNotAvailable(deps, pharmacy({ intakeEnabled: false }));
  assert.deepEqual(clickup, [{ gphcNumber: '1123456', organisationId: pharmacy().id, onboardingRequestId: null }]);
});

test('clearing puts the pharmacy back to awaiting Curaleaf with intake on, or live on live credentials', async () => {
  assert.equal(clearNotAvailableStatus(pharmacy({ status: 'NOT_AVAILABLE' }), null), 'ONBOARDING');
  assert.equal(clearNotAvailableStatus(pharmacy({ status: 'NOT_AVAILABLE' }), 'TEST'), 'ONBOARDING');
  assert.equal(clearNotAvailableStatus(pharmacy({ status: 'NOT_AVAILABLE' }), 'PRODUCTION'), 'LIVE');
  assert.equal(clearNotAvailableStatus(pharmacy({ status: 'ONBOARDING' }), null), null);

  const { deps, calls, audits } = memory();
  const result = await clearPharmacyNotAvailable(deps, pharmacy({ status: 'NOT_AVAILABLE', intakeEnabled: false }), null);
  assert.deepEqual(result, { status: 'onboarding', changed: true });
  assert.deepEqual(calls, ['status:ONBOARDING', 'intake:true']);
  assert.deepEqual(audits.map(row => row.event), ['organisation.not_available_cleared']);
});

test('clearing a pharmacy that is not Not available changes nothing', async () => {
  const { deps, calls, audits } = memory();
  const result = await clearPharmacyNotAvailable(deps, pharmacy({ status: 'LIVE' }), 'PRODUCTION');
  assert.deepEqual(result, { status: 'live', changed: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(audits, []);
});
