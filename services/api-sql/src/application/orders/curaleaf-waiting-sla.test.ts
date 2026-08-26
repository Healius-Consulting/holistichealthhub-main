import assert from 'node:assert/strict';
import test from 'node:test';

import { curaleafWaitingSla } from './curaleaf-waiting-sla.js';

test('alerts three hours after a weekday wait starts inside the London window', () => {
  const sla = curaleafWaitingSla('2026-08-26T13:30:00.000Z', new Date('2026-08-26T16:30:00.000Z'));
  assert.deepEqual(sla, {
    startedAt: '2026-08-26T13:30:00.000Z',
    dueAt: '2026-08-26T16:30:00.000Z',
    alert: true,
    policy: 'three_hours',
    timeZone: 'Europe/London',
  });
});

test('uses next working day noon for an after-hours Friday wait', () => {
  const sla = curaleafWaitingSla('2026-08-28T17:00:00.000Z', new Date('2026-08-31T10:59:59.000Z'));
  assert.equal(sla?.dueAt, '2026-08-31T11:00:00.000Z');
  assert.equal(sla?.alert, false);
  assert.equal(sla?.policy, 'next_working_day_noon');
});

test('uses next working day noon across the winter GMT boundary', () => {
  const sla = curaleafWaitingSla('2026-10-25T10:00:00.000Z', new Date('2026-10-26T12:00:00.000Z'));
  assert.equal(sla?.dueAt, '2026-10-26T12:00:00.000Z');
  assert.equal(sla?.alert, true);
});

test('returns null for an invalid stored timestamp', () => {
  assert.equal(curaleafWaitingSla('not-a-date'), null);
});
