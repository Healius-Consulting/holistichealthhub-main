import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionEmailDelayUntil, collectionEmailSendAt } from './collection-email-schedule.js';

/** Formats an instant as London wall-clock, which is what the rule is written in. */
function london(instant: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(instant);
}

test('weekday before the cutoff sends immediately', () => {
  // Wednesday 10:00 London (BST, so 09:00Z).
  const now = new Date('2026-08-26T09:00:00Z');
  assert.equal(collectionEmailDelayUntil(now), null);
  assert.equal(collectionEmailSendAt(now).toISOString(), now.toISOString());
});

test('weekday at the cutoff waits for the next morning', () => {
  // Wednesday 15:00 London exactly — the cutoff is exclusive.
  const now = new Date('2026-08-26T14:00:00Z');
  assert.equal(london(collectionEmailSendAt(now)), 'Thu, 27/08/2026, 09:00');
});

test('weekday evening waits for the next morning', () => {
  const now = new Date('2026-08-26T19:30:00Z');
  assert.equal(london(collectionEmailSendAt(now)), 'Thu, 27/08/2026, 09:00');
});

test('friday after the cutoff skips the weekend', () => {
  // Friday 16:00 London.
  const now = new Date('2026-08-28T15:00:00Z');
  assert.equal(london(collectionEmailSendAt(now)), 'Mon, 31/08/2026, 09:00');
});

test('saturday morning waits for monday', () => {
  const now = new Date('2026-08-29T08:00:00Z');
  assert.equal(london(collectionEmailSendAt(now)), 'Mon, 31/08/2026, 09:00');
});

test('sunday evening waits for monday', () => {
  const now = new Date('2026-08-30T20:00:00Z');
  assert.equal(london(collectionEmailSendAt(now)), 'Mon, 31/08/2026, 09:00');
});

test('early hours on a weekday still wait for 09:00, not send at 03:00', () => {
  // Tuesday 03:00 London is before the cutoff, so it sends immediately by the
  // stated rule; this test pins that behaviour so a change is deliberate.
  const now = new Date('2026-08-25T02:00:00Z');
  assert.equal(collectionEmailDelayUntil(now), null);
});

test('scheduling in GMT resolves 09:00 London, not 09:00 UTC-with-offset', () => {
  // Saturday in January: London is GMT, so 09:00 London is 09:00Z.
  const now = new Date('2026-01-10T12:00:00Z');
  const sendAt = collectionEmailSendAt(now);
  assert.equal(london(sendAt), 'Mon, 12/01/2026, 09:00');
  assert.equal(sendAt.toISOString(), '2026-01-12T09:00:00.000Z');
});

test('scheduling in BST resolves 09:00 London as 08:00Z', () => {
  const now = new Date('2026-08-29T08:00:00Z');
  assert.equal(collectionEmailSendAt(now).toISOString(), '2026-08-31T08:00:00.000Z');
});
