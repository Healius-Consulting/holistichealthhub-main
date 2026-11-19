import test from 'node:test';
import assert from 'node:assert/strict';
import {
  afterCuraleafSent,
  afterTermsAccepted,
  initialSetupState,
  requestStateView,
  setUpNowTarget,
  setupFinished,
  worldpayUnlocked,
} from '../src/auth/onboarding-flow.ts';

const request = { id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11', pharmacyName: 'Shah Pharmacy', registeredCompanyName: 'Shah Health Ltd' };

test('while the Terms are on, Worldpay stays locked until the Curaleaf form is sent and the Terms are accepted', () => {
  const start = initialSetupState({ onboardingRequest: null, termsRequest: null, termsRequired: true });
  assert.equal(worldpayUnlocked(start), false);
  const sent = afterCuraleafSent(start, request);
  assert.equal(worldpayUnlocked(sent), false);
  const accepted = afterTermsAccepted(sent);
  assert.equal(worldpayUnlocked(accepted), true);
  assert.equal(accepted.worldpay, 'open');
  assert.equal(setupFinished(accepted), false);
  assert.equal(setupFinished({ ...accepted, worldpay: 'skipped' }), true);
  assert.equal(setupFinished({ ...accepted, worldpay: 'sent' }), true);
});

test('while the Terms are off there is no Terms step: Worldpay opens straight after the Curaleaf form', () => {
  const start = initialSetupState({ onboardingRequest: null, termsRequest: null, termsRequired: false });
  assert.equal(worldpayUnlocked(start), false);
  const sent = afterCuraleafSent(start, request);
  assert.equal(worldpayUnlocked(sent), true);
  assert.equal(sent.worldpay, 'open');
  assert.equal(setupFinished({ ...sent, worldpay: 'skipped' }), true);
});

test('a pharmacy that left before the Terms resumes at them, with the Curaleaf form already done', () => {
  const resumed = initialSetupState({ onboardingRequest: 'terms_outstanding', termsRequest: request });
  assert.deepEqual(resumed.termsRequest, request);
  assert.equal(resumed.termsAccepted, false);
  assert.equal(worldpayUnlocked(resumed), false);
  assert.equal(requestStateView('terms_outstanding'), null);
});

test('pending and on-hold requests show their message instead of the forms', () => {
  assert.equal(requestStateView('pending'), 'pending');
  assert.equal(requestStateView('on_hold'), 'on_hold');
  assert.equal(requestStateView(null), null);
  assert.equal(requestStateView(undefined), null);
});

test('Set up now always opens something: the first step not done, then the set-up card', () => {
  const start = initialSetupState({ onboardingRequest: null, termsRequest: null, termsRequired: true });
  assert.equal(setUpNowTarget(start), 'curaleaf');
  const sent = afterCuraleafSent(start, request);
  assert.equal(setUpNowTarget(sent), 'terms');
  const accepted = afterTermsAccepted(sent);
  assert.equal(setUpNowTarget(accepted), 'worldpay');
  assert.equal(setUpNowTarget({ ...accepted, worldpay: 'sent' }), 'card');
  assert.equal(setUpNowTarget({ ...accepted, worldpay: 'skipped' }), 'card');
  const noTerms = afterCuraleafSent(initialSetupState({ onboardingRequest: null, termsRequest: null, termsRequired: false }), request);
  assert.equal(setUpNowTarget(noTerms), 'worldpay');
});
