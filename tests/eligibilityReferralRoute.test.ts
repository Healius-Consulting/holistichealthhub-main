import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEligibilityReferralRoute } from '../apps/eligibility/src/referralRoute.ts';

test('eligibility without a token parameter is the general HHH form', () => {
  assert.deepEqual(parseEligibilityReferralRoute(''), { kind: 'general' });
  assert.deepEqual(parseEligibilityReferralRoute('?utm_source=website'), { kind: 'general' });
});

test('a valid single token selects the pharmacy-specific form', () => {
  assert.deepEqual(parseEligibilityReferralRoute('?token=eastwood-3m8q2v'), {
    kind: 'token',
    token: 'eastwood-3m8q2v',
  });
});

test('printed stone URLs with mode=eligibility?token= still select the pharmacy form', () => {
  assert.deepEqual(parseEligibilityReferralRoute('?mode=eligibility?token=kchem-7x4p9k'), {
    kind: 'token',
    token: 'kchem-7x4p9k',
  });
});

test('a PharmSmart base64 token is accepted, including when a query string turned + into a space', () => {
  const token = `${'A'.repeat(116)}+/==`;
  assert.equal(token.length % 4, 0);
  assert.deepEqual(parseEligibilityReferralRoute(`?token=${encodeURIComponent(token)}`), {
    kind: 'token',
    token,
  });
  const search = `?token=${token.replaceAll('+', ' ')}`;
  assert.deepEqual(parseEligibilityReferralRoute(search), { kind: 'token', token });
});

test('a damaged PharmSmart token is rejected', () => {
  assert.deepEqual(parseEligibilityReferralRoute(`?token=${'A'.repeat(118)}==46`), { kind: 'invalid-token' });
});

test('present but empty, malformed, or ambiguous token parameters fail closed', () => {
  for (const search of ['?token=', '?token=%20', '?token=short', '?token=valid-token-value.', '?token=one-valid-token&token=another-valid-token']) {
    assert.deepEqual(parseEligibilityReferralRoute(search), { kind: 'invalid-token' });
  }
});
