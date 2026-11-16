import assert from 'node:assert/strict';
import test from 'node:test';
import { performancePeriodStart } from '../src/utils/performancePeriod.ts';

test('All has no cutoff', () => {
  assert.equal(performancePeriodStart('all', new Date('2026-11-16T12:00:00Z')), null);
});

test('1M and 3M start that many calendar months back, as a London date', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  assert.equal(performancePeriodStart('1m', now), '2026-10-16');
  assert.equal(performancePeriodStart('3m', now), '2026-08-16');
});

test('late evening UTC in summer counts as the next London day', () => {
  assert.equal(performancePeriodStart('1m', new Date('2026-07-31T23:30:00Z')), '2026-07-01');
});
