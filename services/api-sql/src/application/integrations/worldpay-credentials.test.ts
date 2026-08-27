import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskWorldpayIdentifier, worldpayBaseUrl, worldpaySecretPayload, WORLDPAY_LIVE_BASE_URL, WORLDPAY_TRY_BASE_URL } from './worldpay.service.js';

describe('Worldpay credential helpers', () => {
  // Hosted-page customisation was removed: the stored secret is now exactly the
  // three merchant fields, and nothing else may ride along into Secret Manager.
  it('stores only the merchant credentials', () => {
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

  it('drops any customisation field left over from an older stored secret', () => {
    const legacy = {
      username: 'merchant',
      password: 'secret-pass',
      entityId: 'PO1234567890',
      customisationId: 'hpp-channel-123',
    } as unknown as Parameters<typeof worldpaySecretPayload>[0];
    assert.deepEqual(worldpaySecretPayload(legacy), {
      username: 'merchant',
      password: 'secret-pass',
      entityId: 'PO1234567890',
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
