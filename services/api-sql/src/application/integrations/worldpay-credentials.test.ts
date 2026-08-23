import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskWorldpayIdentifier, worldpayBaseUrl, worldpaySecretPayload, WORLDPAY_LIVE_BASE_URL, WORLDPAY_TRY_BASE_URL } from './worldpay.service.js';

describe('Worldpay credential helpers', () => {
  it('omits customisationId unless a value is present', () => {
    assert.deepEqual(worldpaySecretPayload({
      username: 'merchant',
      password: 'secret-pass',
      entityId: 'PO1234567890',
    }), {
      username: 'merchant',
      password: 'secret-pass',
      entityId: 'PO1234567890',
    });
  });

  it('stores customisationId beside merchant credentials', () => {
    assert.deepEqual(worldpaySecretPayload({
      username: 'merchant',
      password: 'secret-pass',
      entityId: 'PO1234567890',
      customisationId: 'hpp-channel-123',
    }), {
      username: 'merchant',
      password: 'secret-pass',
      entityId: 'PO1234567890',
      customisationId: 'hpp-channel-123',
    });
  });

  it('uses try unless the stored connection is live', () => {
    assert.equal(worldpayBaseUrl(), WORLDPAY_TRY_BASE_URL);
    assert.equal(worldpayBaseUrl('TEST'), WORLDPAY_TRY_BASE_URL);
    assert.equal(worldpayBaseUrl('try'), WORLDPAY_TRY_BASE_URL);
    assert.equal(worldpayBaseUrl('PRODUCTION'), WORLDPAY_LIVE_BASE_URL);
    assert.equal(worldpayBaseUrl('live'), WORLDPAY_LIVE_BASE_URL);
  });

  it('masks the merchant entity without returning the full identifier', () => {
    const masked = maskWorldpayIdentifier('PO1234567890');
    assert.equal(masked.endsWith('7890'), true);
    assert.equal(masked.includes('PO1234'), false);
  });
});
