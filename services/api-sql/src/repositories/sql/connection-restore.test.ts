import assert from 'node:assert/strict';
import test from 'node:test';
import { planConnectionRestore, preferIntegrationConnection, type RestorableConnection } from './connection-restore.js';

function row(overrides: Partial<RestorableConnection> & Pick<RestorableConnection, 'id' | 'environment'>): RestorableConnection {
  return {
    status: 'ACTIVE',
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

test('prefers the active connection, then the most recently updated', () => {
  const chosen = preferIntegrationConnection([
    row({ id: 'old', environment: 'TEST', updatedAt: '2026-09-01T00:00:00.000Z' }),
    row({ id: 'new', environment: 'PRODUCTION', updatedAt: '2026-09-20T00:00:00.000Z' }),
    row({ id: 'pending', environment: 'TEST', status: 'PENDING_VALIDATION', updatedAt: '2026-09-21T00:00:00.000Z' }),
  ]);
  assert.equal(chosen?.id, 'new');
});

test('inserts when the pharmacy has no connection yet', () => {
  assert.deepEqual(planConnectionRestore([], 'PRODUCTION'), { update: null, disconnectIds: [] });
});

test('moves the only connection onto the estate the vendor accepted', () => {
  const plan = planConnectionRestore([
    row({ id: 'test-row', environment: 'TEST', version: 4 }),
  ], 'PRODUCTION');
  assert.deepEqual(plan, { update: { id: 'test-row', version: 5 }, disconnectIds: [] });
});

test('updates the matching estate and retires the other live row', () => {
  const plan = planConnectionRestore([
    row({ id: 'test-row', environment: 'TEST', version: 2 }),
    row({ id: 'live-row', environment: 'PRODUCTION', status: 'DISCONNECTED', version: 3, updatedAt: '2026-08-01T00:00:00.000Z' }),
  ], 'PRODUCTION');
  assert.deepEqual(plan, { update: { id: 'live-row', version: 4 }, disconnectIds: ['test-row'] });
});

test('does not retarget a second row onto an estate that already exists', () => {
  const plan = planConnectionRestore([
    row({ id: 'test-row', environment: 'TEST', version: 2, updatedAt: '2026-09-01T00:00:00.000Z' }),
    row({ id: 'live-row', environment: 'PRODUCTION', version: 8, updatedAt: '2026-09-02T00:00:00.000Z' }),
  ], 'PRODUCTION');
  assert.equal(plan.update?.id, 'live-row');
  assert.deepEqual(plan.disconnectIds, ['test-row']);
});
