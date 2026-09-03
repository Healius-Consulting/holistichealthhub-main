import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLLECTION_EMAIL_CUTOFF_HOUR,
  COLLECTION_EMAIL_SEND_HOUR,
  collectionEmailDelayUntil,
  collectionEmailNotice,
  collectionEmailSendAt,
} from '../packages/domain/collection-window.js';
import * as server from '../services/api-sql/src/application/notifications/collection-email-schedule.ts';

/** London wall-clock instants across BST, GMT, both cut-off sides and a weekend. */
const INSTANTS = [
  '2026-08-27T09:00:00Z', // Thu 10:00 BST — before the cut-off
  '2026-08-27T13:59:00Z', // Thu 14:59 BST — still before
  '2026-08-27T14:01:00Z', // Thu 15:01 BST — past it
  '2026-08-27T22:30:00Z', // Thu 23:30 BST — night
  '2026-08-28T14:01:00Z', // Fri past the cut-off — skips the weekend
  '2026-08-29T09:00:00Z', // Saturday
  '2026-08-30T09:00:00Z', // Sunday
  '2026-01-15T09:00:00Z', // Thu GMT — before
  '2026-01-15T15:30:00Z', // Thu GMT — past
  '2026-03-29T00:30:00Z', // BST changeover morning
  '2026-10-25T00:30:00Z', // GMT changeover morning
].map(value => new Date(value));

test('the workspace and the send queue agree on the 15:00 rule for every instant', () => {
  assert.equal(COLLECTION_EMAIL_CUTOFF_HOUR, server.COLLECTION_EMAIL_CUTOFF_HOUR);
  assert.equal(COLLECTION_EMAIL_SEND_HOUR, server.COLLECTION_EMAIL_SEND_HOUR);
  for (const now of INSTANTS) {
    assert.equal(
      collectionEmailSendAt(now).toISOString(),
      server.collectionEmailSendAt(now).toISOString(),
      `send time diverged at ${now.toISOString()}`,
    );
    assert.equal(
      collectionEmailDelayUntil(now)?.toISOString() ?? null,
      server.collectionEmailDelayUntil(now)?.toISOString() ?? null,
      `delay diverged at ${now.toISOString()}`,
    );
  }
});

test('a weekday check-in before 15:00 London emails the patient immediately', () => {
  const notice = collectionEmailNotice(new Date('2026-08-27T09:00:00Z'));
  assert.equal(notice.immediate, true);
  assert.equal(notice.summary, 'Patient emailed now');
});

test('a check-in after 15:00 London is held to 09:00 the next working day', () => {
  const notice = collectionEmailNotice(new Date('2026-08-27T14:01:00Z'));
  assert.equal(notice.immediate, false);
  assert.match(notice.summary, /Friday 28 Aug, 09:00/);
});

test('a weekend check-in never invites a patient to a closed pharmacy', () => {
  const saturday = collectionEmailNotice(new Date('2026-08-29T10:00:00Z'));
  assert.equal(saturday.immediate, false);
  assert.match(saturday.summary, /Monday 31 Aug, 09:00/);
  // Friday afternoon skips the weekend entirely rather than landing on Saturday.
  assert.match(collectionEmailNotice(new Date('2026-08-28T15:00:00Z')).summary, /Monday 31 Aug/);
});
