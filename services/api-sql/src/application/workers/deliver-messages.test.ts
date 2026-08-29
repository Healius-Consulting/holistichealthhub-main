import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationRetryAt } from './deliver-messages.js';

test('notification retries keep the same message on a bounded exponential schedule', () => {
  const now = new Date('2026-08-29T10:00:00.000Z');
  assert.equal(notificationRetryAt(now, 1).toISOString(), '2026-08-29T10:05:00.000Z');
  assert.equal(notificationRetryAt(now, 2).toISOString(), '2026-08-29T10:10:00.000Z');
});
