import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  awaitingSetupBanner,
  formatOnboardingDate,
  ONBOARDING_QUEUE,
  onboardingQueueItems,
  pharmacyAccountState,
  pharmacyAccountStateFromCode,
  PHARMACY_ACCOUNT_STATE_COPY,
  preLiveLockedScreen,
} from '../src/onboarding/branchOnboarding.ts';
import { PORTAL_ONBOARDING_QUEUE_UTM, pharmsmartOnboardingBookingUrl } from '../src/auth/pharmsmart-login.ts';
import { shouldDispatchSessionEnded } from '../src/shared/sessionEnded.ts';

const queue = (overrides: Partial<Parameters<typeof onboardingQueueItems>[0]> = {}) => onboardingQueueItems({
  live: false,
  termsAccepted: true,
  worldpaySubmittedAt: null,
  demoActive: false,
  ...overrides,
});

test('the status card has three states, and Live has none', () => {
  assert.equal(pharmacyAccountState('onboarding'), 'being_set_up');
  assert.equal(pharmacyAccountState('intake_live'), 'being_set_up');
  assert.equal(pharmacyAccountState('not_available'), 'not_available');
  assert.equal(pharmacyAccountState('paused'), 'suspended');
  assert.equal(pharmacyAccountState('live'), null);
  assert.equal(pharmacyAccountState(undefined), null);
});

test('Not available uses the near-future wording and Suspended reuses PAUSED', () => {
  assert.match(PHARMACY_ACCOUNT_STATE_COPY.not_available.body, /may be available to you in the near future/);
  assert.equal(pharmacyAccountStateFromCode('PHARMACY_NOT_AVAILABLE'), 'not_available');
  assert.equal(pharmacyAccountStateFromCode('PHARMACY_SUSPENDED'), 'suspended');
  assert.equal(pharmacyAccountStateFromCode('SESSION_IDLE_EXPIRED'), null);
  assert.equal(pharmacyAccountStateFromCode(null), null);
});

test('a Not available pharmacy is signed out wherever it is, like a suspended one', () => {
  assert.equal(shouldDispatchSessionEnded(403, 'PHARMACY_NOT_AVAILABLE', '/patients'), true);
  assert.equal(shouldDispatchSessionEnded(403, 'PHARMACY_SUSPENDED', '/orders'), true);
  assert.equal(shouldDispatchSessionEnded(403, 'PHARMACY_NOT_AVAILABLE', '/login'), false);
  assert.equal(shouldDispatchSessionEnded(403, 'FORBIDDEN', '/patients'), false);
});

test('the banner shows while awaiting Curaleaf, with the submission date', () => {
  const banner = awaitingSetupBanner({ status: 'onboarding', workspaceMode: 'training', demo: false, submittedAt: '2026-11-19T14:05:00.000Z' });
  assert.ok(banner);
  assert.equal(banner.title, 'Your forms have been submitted — your account is awaiting set-up');
  assert.equal(banner.submitted, 'Submitted 19 November 2026');
  assert.match(banner.body, /eligibility link is already open/);
  assert.match(banner.body, /Ordering opens when your account goes live/);
});

test('the banner leaves out a missing date rather than printing a bad one', () => {
  assert.equal(awaitingSetupBanner({ status: 'onboarding', workspaceMode: 'training', demo: false, submittedAt: null })?.submitted, null);
  assert.equal(awaitingSetupBanner({ status: 'onboarding', workspaceMode: 'training', demo: false, submittedAt: 'not a date' })?.submitted, null);
  assert.equal(formatOnboardingDate('2026-03-29T23:30:00.000Z'), '30 March 2026', 'dates are in UK time');
});

test('the banner clears at Live and gives way to Demo mode', () => {
  assert.equal(awaitingSetupBanner({ status: 'live', workspaceMode: 'live', demo: false, submittedAt: null }), null);
  assert.equal(awaitingSetupBanner({ status: 'onboarding', workspaceMode: 'live', demo: false, submittedAt: null }), null);
  assert.equal(awaitingSetupBanner({ status: 'onboarding', workspaceMode: 'training', demo: true, submittedAt: null }), null);
  assert.equal(awaitingSetupBanner({ status: 'paused', workspaceMode: 'training', demo: false, submittedAt: null }), null);
});

test('stock, prices and orders wait for go-live, but patients and eligibility do not', () => {
  const preLive = { workspaceMode: 'training', demo: false, sandbox: false };
  for (const screen of ['formulary', 'create', 'orders']) assert.equal(preLiveLockedScreen(screen, preLive), true, screen);
  for (const screen of ['home', 'patients', 'finance', 'settings', 'contacts', 'onboarding']) assert.equal(preLiveLockedScreen(screen, preLive), false, screen);
});

test('nothing is locked live, in Demo mode, or in the local sandbox', () => {
  assert.equal(preLiveLockedScreen('orders', { workspaceMode: 'live', demo: false, sandbox: false }), false);
  assert.equal(preLiveLockedScreen('orders', { workspaceMode: 'training', demo: true, sandbox: false }), false);
  assert.equal(preLiveLockedScreen('orders', { workspaceMode: 'training', demo: false, sandbox: true }), false);
});

test('the queue is a fixed list in the brief order', () => {
  assert.deepEqual(ONBOARDING_QUEUE.map(entry => entry.id), ['awaiting_curaleaf', 'worldpay', 'demo_account', 'demo_call']);
});

test('Awaiting Curaleaf is never clickable and ticks itself at Live', () => {
  const waiting = queue()[0];
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.action, null);
  assert.equal(waiting.status, 'Awaiting Curaleaf');
  const done = queue({ live: true })[0];
  assert.equal(done.state, 'done');
  assert.equal(done.action, null);
  assert.equal(done.status, 'Live');
});

test('Worldpay offers the form, then shows Submitted with the date and no button', () => {
  const open = queue()[1];
  assert.deepEqual(open.action, { kind: 'worldpay', label: 'Submit form' });
  const sent = queue({ worldpaySubmittedAt: '2026-11-20T09:00:00.000Z' })[1];
  assert.equal(sent.state, 'done');
  assert.equal(sent.action, null);
  assert.equal(sent.status, 'Submitted 20 November 2026');
});

test('a branch without accepted Partner Terms is offered the Terms first, not a dead end', () => {
  const item = queue({ termsAccepted: false })[1];
  assert.equal(item.state, 'open');
  assert.deepEqual(item.action, { kind: 'terms', label: 'Accept Partner Terms' });
  assert.match(item.detail, /Accept the Partner Terms first/);
});

test('the demo account item turns Demo mode on, and says so once it is on', () => {
  assert.deepEqual(queue()[2].action, { kind: 'demo', label: 'Open demo account' });
  const on = queue({ demoActive: true })[2];
  assert.equal(on.action, null);
  assert.equal(on.status, 'Demo mode is on');
  assert.deepEqual(queue()[3].action, { kind: 'book', label: 'Book a call' });
});

test('a booking from the queue carries the portal UTM tag; other bookings do not', () => {
  const person = { firstName: 'Asha', lastName: 'Patel', email: 'asha@example.co.uk' };
  const tagged = new URL(pharmsmartOnboardingBookingUrl(person, { utm: PORTAL_ONBOARDING_QUEUE_UTM }));
  assert.equal(tagged.searchParams.get('utm_source'), 'hhh-portal');
  assert.equal(tagged.searchParams.get('utm_campaign'), 'onboarding-queue');
  assert.equal(tagged.searchParams.get('name'), 'Asha Patel');
  const plain = new URL(pharmsmartOnboardingBookingUrl(person));
  assert.equal(plain.searchParams.get('utm_source'), null);
  assert.equal(plain.searchParams.get('utm_campaign'), null);
});

test('the portal shows one Awaiting Curaleaf banner, and the Onboarding page embeds the go-live checklist', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.equal((app.match(/<AwaitingSetupBanner/g) ?? []).length, 1);
  assert.doesNotMatch(app, /'Awaiting Curaleaf' :/, 'the old Step 1 banner text is gone');
  const page = readFileSync(new URL('../src/pages/PharmacyOnboarding.tsx', import.meta.url), 'utf8');
  assert.match(page, /<GoLiveChecklist\b/);
  const header = readFileSync(new URL('../src/components/Header.tsx', import.meta.url), 'utf8');
  assert.match(header, /screen: 'onboarding'/);
});
