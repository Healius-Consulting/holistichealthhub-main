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

function service(
  body = info(),
  pharmacies?: Array<{ id: string; gphcNumber: string; primaryContactUid?: string | null }>,
) {
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
    listOrganisations: async () => pharmacies ?? [
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

  it('returns the onboarding guide when no pharmacy account matches the GPhC', async () => {
    const { sso, created, minted, audits } = service(info({ gphc: '5550001' }));
    const result = await sso.redeem('opaque-token', { requestId: 'req-welcome', ipHash: 'ip' });
    assert.deepEqual(result, {
      status: 'welcome',
      firstName: 'Amina',
      lastName: 'Khan',
      email: 'amina.khan@pharmacy.test',
    });
    assert.equal(created.length, 0);
    assert.equal(minted.length, 0);
    assert.equal(audits.at(-1)?.event, 'auth.pharmsmart_sso_refused');
    assert.equal(audits.at(-1)?.organisationId, null);
    assert.deepEqual(audits.at(-1)?.details, { reason: 'WELCOME' });
    assert.equal(JSON.stringify(audits.at(-1)?.details).includes('amina.khan'), false);
  });

  it('still opens the workspace when the GPhC matches a pharmacy account', async () => {
    const { sso, minted } = service();
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'ready');
    assert.equal(minted.length, 1);
  });

  it('refuses an ambiguous GPhC instead of showing the onboarding guide', async () => {
    const { sso, created, minted, audits } = service(info(), [
      { id: organisationId, gphcNumber: '1234471' },
      { id: 'other-pharmacy', gphcNumber: '1234471' },
    ]);
    await assert.rejects(
      () => sso.redeem('opaque-token', { requestId: null, ipHash: null }),
      (error: unknown) => error instanceof HttpError && error.code === 'PHARMACY_NOT_LINKED',
    );
    assert.equal(created.length, 0);
    assert.equal(minted.length, 0);
    assert.deepEqual(audits.at(-1)?.details, { reason: 'AMBIGUOUS' });
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
