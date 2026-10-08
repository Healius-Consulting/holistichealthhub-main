import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchPharmsmartPharmacyInfo, PHARMSMART_PHARMACY_INFO_URL } from './pharmsmart-pharmacy-client.js';

describe('PharmSmart pharmacy lookup', () => {
  it('posts the opaque token as form fields and does not follow a redirect', async () => {
    const seen: { url: string; method: string; body: string; userAgent: string; redirect: string } = {
      url: '', method: '', body: '', userAgent: '', redirect: '',
    };
    const body = await fetchPharmsmartPharmacyInfo('opaque-token', (async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.url = String(url);
      seen.method = init?.method ?? '';
      seen.body = String(init?.body ?? '');
      seen.userAgent = headers.get('user-agent') ?? '';
      seen.redirect = init?.redirect ?? '';
      return new Response('\uFEFF{"status_code":200}', { status: 200 });
    }) as typeof fetch);

    assert.match(body, /"status_code":200/);
    assert.equal(seen.url, PHARMSMART_PHARMACY_INFO_URL);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.redirect, 'error');
    assert.match(seen.body, /request_type=get_pharmacy_info/);
    assert.match(seen.body, /token=opaque-token/);
    assert.ok(seen.userAgent.length > 0);
  });

  it('hides the token when PharmSmart rejects the lookup', async () => {
    await assert.rejects(
      () => fetchPharmsmartPharmacyInfo('secret-token-value', (async () => new Response('error code: 1010', { status: 403 })) as typeof fetch),
      (error: unknown) => error instanceof Error && !error.message.includes('secret-token-value'),
    );
  });
});
