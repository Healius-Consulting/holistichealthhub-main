import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retentionActionFor, type RetentionSubject } from './policy.js';

const base: RetentionSubject = {
  outcomeStatus: 'DECLINED',
  closedAt: '2026-01-15T00:00:00.000Z',
  lastActivityAt: null,
  minimalSince: null,
};

const at = (iso: string) => new Date(iso);

describe('retention policy', () => {
  it('keeps an open application indefinitely', () => {
    assert.deepEqual(
      retentionActionFor({ ...base, outcomeStatus: 'OPEN', closedAt: null }, at('2030-01-01T00:00:00.000Z')),
      { action: 'retain' },
    );
  });

  it('keeps a declined application for its first three months', () => {
    assert.deepEqual(retentionActionFor(base, at('2026-04-14T00:00:00.000Z')), { action: 'retain' });
  });

  it('reduces a declined application to a minimal record at three months', () => {
    const result = retentionActionFor(base, at('2026-04-15T00:00:00.000Z'));
    assert.equal(result.action, 'reduce_to_minimal_record');
  });

  it('does not reduce a record that has already been reduced', () => {
    assert.deepEqual(
      retentionActionFor({ ...base, minimalSince: '2026-04-15T00:00:00.000Z' }, at('2026-06-01T00:00:00.000Z')),
      { action: 'retain' },
    );
  });

  it('deletes the minimal record twelve months after the decision, not after the reduction', () => {
    const reduced = { ...base, minimalSince: '2026-04-15T00:00:00.000Z' };
    assert.deepEqual(retentionActionFor(reduced, at('2027-01-14T00:00:00.000Z')), { action: 'retain' });
    assert.equal(retentionActionFor(reduced, at('2027-01-15T00:00:00.000Z')).action, 'delete');
  });

  it('treats a withdrawal the same as a decline', () => {
    const withdrawn = { ...base, outcomeStatus: 'WITHDRAWN' as const };
    assert.equal(retentionActionFor(withdrawn, at('2026-04-15T00:00:00.000Z')).action, 'reduce_to_minimal_record');
  });

  it('deletes a referred application two years after its last activity', () => {
    const referred: RetentionSubject = {
      outcomeStatus: 'COMPLETED',
      closedAt: '2026-01-15T00:00:00.000Z',
      lastActivityAt: '2026-06-01T00:00:00.000Z',
      minimalSince: null,
    };
    assert.deepEqual(retentionActionFor(referred, at('2028-05-31T00:00:00.000Z')), { action: 'retain' });
    assert.equal(retentionActionFor(referred, at('2028-06-01T00:00:00.000Z')).action, 'delete');
  });

  it('measures a referred application from activity, not from the referral date', () => {
    const referred: RetentionSubject = {
      outcomeStatus: 'COMPLETED',
      closedAt: '2026-01-15T00:00:00.000Z',
      lastActivityAt: '2027-01-15T00:00:00.000Z',
      minimalSince: null,
    };
    assert.deepEqual(retentionActionFor(referred, at('2028-06-01T00:00:00.000Z')), { action: 'retain' });
  });

  it('does not let a month-end decision date gain a day', () => {
    const endOfMonth = { ...base, closedAt: '2026-01-31T00:00:00.000Z' };
    // Three months from 31 January is 30 April, not 1 May.
    assert.deepEqual(retentionActionFor(endOfMonth, at('2026-04-29T00:00:00.000Z')), { action: 'retain' });
    assert.equal(retentionActionFor(endOfMonth, at('2026-04-30T00:00:00.000Z')).action, 'reduce_to_minimal_record');
  });
});
