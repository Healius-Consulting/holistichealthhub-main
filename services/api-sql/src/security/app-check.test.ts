import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appCheckIsRequired, isAppCheckExempt } from './app-check-policy.js';

describe('appCheckIsRequired', () => {
  it('stays off unless REQUIRE_APP_CHECK is explicitly enabled', () => {
    assert.equal(appCheckIsRequired('true'), true);
    assert.equal(appCheckIsRequired('false'), false);
    assert.equal(appCheckIsRequired(undefined), false);
  });
});

describe('isAppCheckExempt', () => {
  it('skips CORS preflight, health, and the Worldpay webhook', () => {
    assert.equal(isAppCheckExempt('OPTIONS', '/v1/portal/orders'), true);
    assert.equal(isAppCheckExempt('GET', '/health'), true);
    assert.equal(isAppCheckExempt('POST', '/v1/public/payments/worldpay/webhook'), true);
  });

  it('requires attestation for staff and public browser routes', () => {
    assert.equal(isAppCheckExempt('GET', '/v1/public/payments/status'), false);
    assert.equal(isAppCheckExempt('POST', '/v1/auth/session'), false);
    assert.equal(isAppCheckExempt('GET', '/v1/portal/orders'), false);
  });
});
