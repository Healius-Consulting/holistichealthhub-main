import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sendableEmailKinds,
  emailEntryTime,
  emailStatusLabel,
  emailStatusTone,
  failedEmailKinds,
  holdAvailability,
  holdReasonLabel,
  isHeldOrganisationStatus,
  summariseEmailLog,
} from '../src/pages/admin/onboardingAdmin.ts';
import type { OnboardingEmailLogEntry } from '../services/api-sql/src/application/pharmacy-onboarding/onboarding-emails.ts';

const entry = (overrides: Partial<OnboardingEmailLogEntry>): OnboardingEmailLogEntry => ({
  id: 'e',
  kind: 'sent',
  recipients: ['shop@example.com'],
  status: 'SENT',
  queuedAt: '2026-11-19T09:00:00Z',
  sentAt: '2026-11-19T09:00:05Z',
  failedAt: null,
  failureCode: null,
  ...overrides,
});

test('the send log has one row per email, in the order a pharmacy meets them', () => {
  const rows = summariseEmailLog([]);
  assert.deepEqual(rows.map(row => row.kind), ['sent', 'curaleafApplication', 'activation', 'hold', 'live']);
  assert.deepEqual(rows.map(row => row.label), ['Sent (to pharmacy)', 'Application to Curaleaf', 'Ready to try (activation)', 'On hold', 'Live']);
  assert.ok(rows.every(row => row.latest === null && !row.failed));
});

test('each row shows the newest send and keeps the rest as history', () => {
  const rows = summariseEmailLog([
    entry({ id: 'h1', kind: 'hold', queuedAt: '2026-11-19T09:00:00Z' }),
    entry({ id: 'h2', kind: 'hold', queuedAt: '2026-11-20T09:00:00Z', status: 'FAILED', sentAt: null, failedAt: '2026-11-20T09:01:00Z', failureCode: 'SMTP_REJECTED' }),
    entry({ id: 's1', kind: 'sent' }),
  ]);
  const hold = rows.find(row => row.kind === 'hold')!;
  assert.equal(hold.latest?.id, 'h2');
  assert.deepEqual(hold.history.map(item => item.id), ['h2', 'h1']);
  assert.equal(hold.failed, true);
  assert.deepEqual(failedEmailKinds(rows), ['hold']);
});

test('a failed send that was resent successfully no longer counts as failed', () => {
  const rows = summariseEmailLog([
    entry({ id: 'a', kind: 'live', status: 'FAILED', sentAt: null, failedAt: '2026-11-19T09:01:00Z', queuedAt: '2026-11-19T09:00:00Z' }),
    entry({ id: 'b', kind: 'live', queuedAt: '2026-11-19T10:00:00Z' }),
  ]);
  assert.deepEqual(failedEmailKinds(rows), []);
});

test('status labels and tones', () => {
  assert.equal(emailStatusLabel('SENT'), 'Sent');
  assert.equal(emailStatusLabel('PENDING'), 'Pending');
  assert.equal(emailStatusLabel('FAILED'), 'Failed');
  assert.equal(emailStatusLabel(null), 'Not sent');
  assert.equal(emailStatusTone('FAILED'), 'stop');
  assert.equal(emailStatusTone(null), 'off');
  assert.equal(emailEntryTime(entry({ sentAt: null, failedAt: null })), '2026-11-19T09:00:00Z');
});

test('hold reasons show with their letter', () => {
  assert.equal(holdReasonLabel('EXISTING_CURALEAF_CUSTOMER'), 'A. Existing Curaleaf customer');
  assert.equal(holdReasonLabel('MORE_INFORMATION_NEEDED'), 'B. More information needed');
  assert.equal(holdReasonLabel('CURALEAF_DECLINED'), 'C. Curaleaf declined');
});

test('a hold can be set on a new request or a branch that is not live, never a live one', () => {
  assert.deepEqual(holdAvailability({ requestStatus: 'pending' }), { allowed: true });
  assert.deepEqual(holdAvailability({ requestStatus: 'activated', organisationStatus: 'onboarding' }), { allowed: true });
  const live = holdAvailability({ requestStatus: 'activated', organisationStatus: 'live' });
  assert.equal(live.allowed, false);
  assert.match(live.allowed ? '' : live.why, /live branch cannot be put on hold/);
  assert.equal(holdAvailability({ requestStatus: 'activated', organisationStatus: 'paused' }).allowed, false);
  assert.equal(holdAvailability({ requestStatus: 'on_hold' }).allowed, false);
});

test('only the on_hold organisation status reads as held', () => {
  assert.equal(isHeldOrganisationStatus('on_hold'), true);
  assert.equal(isHeldOrganisationStatus('onboarding'), false);
});

test('an email that applies but was never queued can be sent; one that does not apply cannot', () => {
  assert.deepEqual(sendableEmailKinds({ termsAccepted: false, termsRequired: true, requestStatus: 'pending', activated: false, live: false }), []);
  // Terms switched off: the Curaleaf form alone is enough for Sent and the Curaleaf application.
  assert.deepEqual(sendableEmailKinds({ termsAccepted: false, requestStatus: 'pending', activated: false, live: false }), ['sent', 'curaleafApplication']);
  assert.deepEqual(sendableEmailKinds({ termsAccepted: true, requestStatus: 'on_hold', activated: false, live: false }), ['sent', 'curaleafApplication', 'hold']);
  assert.deepEqual(sendableEmailKinds({ termsAccepted: true, requestStatus: 'activated', activated: true, live: true }), ['sent', 'curaleafApplication', 'activation', 'live']);
});
