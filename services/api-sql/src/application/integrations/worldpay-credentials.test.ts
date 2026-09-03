import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import { maskWorldpayIdentifier, safeWorldpayActionUrl, worldpayBaseUrl, worldpaySecretPayload, worldpayStatusPayload, WORLDPAY_DEFAULT_LINK_EXPIRY_SECONDS, WORLDPAY_LIVE_BASE_URL, WORLDPAY_TRY_BASE_URL } from './worldpay.service.js';

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

  it('expires hosted payment links after 72 hours by default', () => {
    assert.equal(WORLDPAY_DEFAULT_LINK_EXPIRY_SECONDS, 72 * 60 * 60);
  });

  it('uses try unless the stored connection is live', () => {
    assert.equal(worldpayBaseUrl(), WORLDPAY_TRY_BASE_URL);
    assert.equal(worldpayBaseUrl('TEST'), WORLDPAY_TRY_BASE_URL);
    assert.equal(worldpayBaseUrl('try'), WORLDPAY_TRY_BASE_URL);
    assert.equal(worldpayBaseUrl('PRODUCTION'), WORLDPAY_LIVE_BASE_URL);
    assert.equal(worldpayBaseUrl('live'), WORLDPAY_LIVE_BASE_URL);
  });

  it('allows only HTTPS actions on the configured Worldpay host', () => {
    assert.equal(
      safeWorldpayActionUrl('/payments/refunds/token', WORLDPAY_TRY_BASE_URL).href,
      'https://try.access.worldpay.com/payments/refunds/token',
    );
    assert.throws(
      () => safeWorldpayActionUrl('https://attacker.example/refund', WORLDPAY_TRY_BASE_URL),
      { code: 'WORLDPAY_REFUND_LINK_INVALID' },
    );
    assert.throws(
      () => safeWorldpayActionUrl('http://try.access.worldpay.com/refund', WORLDPAY_TRY_BASE_URL),
      { code: 'WORLDPAY_REFUND_LINK_INVALID' },
    );
  });

  it('masks the merchant entity without returning the full identifier', () => {
    const masked = maskWorldpayIdentifier('PO1234567890');
    assert.equal(masked.endsWith('7890'), true);
    assert.equal(masked.includes('PO1234'), false);
  });
});

function worldpayConnection(overrides: Partial<IntegrationConnectionRecord> = {}): IntegrationConnectionRecord {
  return {
    id: 'conn-1',
    organisationId: 'org-1',
    integration: 'WORLDPAY',
    environment: 'TEST',
    status: 'ACTIVE',
    secretResourceName: 'projects/demo/secrets/hhh-worldpay-org-europe-west2',
    externalCustomerId: 'PO1234567890',
    maskedCredential: '••••7890',
    validatedAt: null,
    lastSuccessfulAt: null,
    lastErrorCode: null,
    version: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Worldpay status payload', () => {
  it('does not report connected from a stored ACTIVE row that has never been checked', () => {
    const payload = worldpayStatusPayload(worldpayConnection());
    assert.equal(payload.configured, true);
    assert.equal(payload.connected, false);
    assert.equal(payload.status, 'attention');
    assert.equal(payload.checkedAt, null);
    assert.equal(payload.environment, 'try');
  });

  it('reports connected only when a successful vendor call can be pointed at', () => {
    const payload = worldpayStatusPayload(worldpayConnection({
      lastSuccessfulAt: '2026-08-16T09:00:00.000Z',
    }));
    assert.equal(payload.connected, true);
    assert.equal(payload.status, 'connected');
    assert.equal(payload.checkedAt, '2026-08-16T09:00:00.000Z');
  });

  it('accepts a just-completed check even if the row has not been re-read yet', () => {
    const payload = worldpayStatusPayload(worldpayConnection(), {
      checkedAt: '2026-08-29T00:10:00.000Z',
    });
    assert.equal(payload.connected, true);
    assert.equal(payload.checkedAt, '2026-08-29T00:10:00.000Z');
  });

  it('clears the check timestamp after disconnect', () => {
    const payload = worldpayStatusPayload(worldpayConnection({
      status: 'DISCONNECTED',
      lastSuccessfulAt: '2026-08-16T09:00:00.000Z',
    }));
    assert.equal(payload.configured, false);
    assert.equal(payload.connected, false);
    assert.equal(payload.checkedAt, null);
  });
});
