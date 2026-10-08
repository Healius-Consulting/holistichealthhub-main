import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { AppendAuditInput } from '../../repositories/ports/identity.port.js';
import type { PharmsmartStaffCandidate } from '../../domain/identity/pharmsmart-sso.js';
import { PharmsmartSsoService } from './pharmsmart-sso.service.js';

const organisationId = '70913a30-71c3-4a41-952e-d532927af58c';

function info(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    status_code: 200,
    status_message: 'Pharmacy info',
    data: {
      pharmacy_id: 30,
      email: 'amina.khan@pharmacy.test',
      first_name: 'Amina',
      last_name: 'Khan',
      gphc: '1234471',
      ...overrides,
    },
  });
}

function service(body = info()) {
  const audits: AppendAuditInput[] = [];
  const created: Array<{ email: string; displayName: string; organisationId: string }> = [];
  const adopted: string[] = [];
  const minted: string[] = [];
  const staff: PharmsmartStaffCandidate[] = [{
    uid: 'owner-uid',
    organisationId,
    email: 'owner@pharmacy.test',
    displayName: 'Alex Owner',
    role: 'PHARMACY_STAFF',
    status: 'ACTIVE',
    disabled: false,
  }];
  const sso = new PharmsmartSsoService({
    fetchPharmacyInfo: async () => body,
    listOrganisations: async () => [
      { id: '30', gphcNumber: '9999999', primaryContactUid: 'someone-else' },
      { id: organisationId, gphcNumber: '1234471', primaryContactUid: 'owner-uid' },
    ],
    listStaff: async () => staff,
    findEmailOwner: async email => staff.find(member => member.email === email) ?? null,
    adoptAccount: async member => { adopted.push(member.uid); },
    createAccount: async input => {
      created.push(input);
      const uid = `sso-${created.length}`;
      staff.push({
        uid,
        organisationId: input.organisationId,
        email: input.email,
        displayName: input.displayName,
        role: 'PHARMACY_STAFF',
        status: 'ACTIVE',
        disabled: false,
      });
      return uid;
    },
    createCustomToken: async uid => {
      minted.push(uid);
      return `custom-${uid}`;
    },
    audit: async input => { audits.push(input); },
    setupSecret: 'test-secret',
  });
  return { sso, audits, created, adopted, minted, staff };
}

describe('PharmSmart redemption', () => {
  it('creates an SSO account for a new person on the GPhC pharmacy', async () => {
    const { sso, created, minted, adopted } = service();
    const result = await sso.redeem('opaque-token', { requestId: 'req-1', ipHash: 'ip' });
    assert.equal(result.status, 'ready');
    assert.deepEqual(created, [{
      email: 'amina.khan@pharmacy.test',
      displayName: 'Amina Khan',
      organisationId,
    }]);
    assert.deepEqual(minted, ['sso-1']);
    assert.deepEqual(adopted, []);
    if (result.status === 'ready') assert.equal(result.customToken, 'custom-sso-1');
  });

  it('reuses the SSO account when the same person returns', async () => {
    const { sso, created, minted } = service();
    await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    const again = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(created.length, 1);
    assert.deepEqual(minted, ['sso-1', 'sso-1']);
    assert.equal(again.status, 'ready');
  });

  it('asks for an email when PharmSmart did not send one', async () => {
    const { sso, created } = service(info({ email: '' }));
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'setup');
    assert.equal(created.length, 0);
    if (result.status !== 'setup') return;
    assert.deepEqual(result.missing, ['email']);
    const finished = await sso.completeSetup({
      ticket: result.ticket,
      email: 'amina.khan@pharmacy.test',
    }, { requestId: null, ipHash: null });
    assert.equal(finished.status, 'ready');
    assert.equal(created[0]?.email, 'amina.khan@pharmacy.test');
  });

  it('refuses an expired token without creating an account', async () => {
    const { sso, created } = service('{"status_code":401,"status_message":"Token is expired"}');
    await assert.rejects(
      () => sso.redeem('opaque-token', { requestId: null, ipHash: null }),
      (error: unknown) => error instanceof HttpError && error.code === 'PHARMSMART_TOKEN_EXPIRED',
    );
    assert.equal(created.length, 0);
  });
});
