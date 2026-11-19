import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { AppendAuditInput } from '../../repositories/ports/identity.port.js';
import type { PharmsmartStaffCandidate } from '../../domain/identity/pharmsmart-sso.js';
import { PharmsmartSsoService } from './pharmsmart-sso.service.js';
import { readPharmsmartNamesTicket } from '../../domain/pharmacy-onboarding/terms.js';

const organisationId = '70913a30-71c3-4a41-952e-d532927af58c';
const SECRET = 'test-secret';

function info(overrides: Record<string, unknown> = {}, person: Record<string, unknown> = {}) {
  return JSON.stringify({
    status_code: 200,
    status_message: 'Pharmacy info',
    data: {
      pharmacy_id: 30,
      email: 'shop@pharmacy.test',
      gphc: '1234471',
      sso_user: { first_name: 'Amina', last_name: 'Khan', email: 'amina.khan@pharmacy.test', ...person },
      ...overrides,
    },
  });
}

function service(
  body = info(),
  pharmacies?: Array<{ id: string; gphcNumber: string; primaryContactUid?: string | null; status?: string; name?: string }>,
  requests: Record<string, 'PENDING' | 'ON_HOLD' | 'ACTIVATED' | 'PENDING_NO_TERMS'> = {},
) {
  const lookedUp: string[] = [];
  const audits: AppendAuditInput[] = [];
  const created: Array<{ email: string; displayName: string; organisationId: string }> = [];
  const adopted: string[] = [];
  const minted: string[] = [];
  const branchHolds: Array<{ id: string; name?: string | null }> = [];
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
    findLatestOnboardingRequest: async gphcNumber => {
      lookedUp.push(gphcNumber);
      const status = requests[gphcNumber];
      if (!status) return null;
      return {
        id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11',
        status: status === 'PENDING_NO_TERMS' ? 'PENDING' : status,
        termsAccepted: status !== 'PENDING_NO_TERMS',
        pharmacyName: 'Shah Pharmacy',
        registeredCompanyName: 'Shah Health Ltd',
        holdReason: status === 'ON_HOLD' ? 'CURALEAF_DECLINED' as const : null,
      };
    },
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
    holdMessage: async (reason, branchName) => ({ reason: reason ?? 'EXISTING_CURALEAF_CUSTOMER', heading: 'Your application is on hold', paragraphs: [`${branchName} is on hold`], footer: 'Questions?' }),
    branchHoldMessage: async branch => {
      branchHolds.push(branch);
      return { reason: 'MORE_INFORMATION_NEEDED', heading: 'Your application is on hold', paragraphs: [`${branch.name} needs more information`], footer: 'Questions?' };
    },
    awaitingMessage: async branchName => ({ heading: 'We’re setting up your account', paragraphs: [`${branchName} is with Curaleaf`], footer: 'Questions?' }),
  });
  return { sso, audits, created, adopted, minted, staff, lookedUp, branchHolds };
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
    const { sso, created } = service(info({}, { email: '' }));
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
    assert.equal(result.status === 'welcome' && typeof result.pharmsmartTicket, 'string');
    const { pharmsmartTicket: _ticket, ...rest } = result as Extract<typeof result, { status: 'welcome' }>;
    assert.deepEqual(rest, {
      status: 'welcome',
      firstName: 'Amina',
      lastName: 'Khan',
      email: 'amina.khan@pharmacy.test',
      gphcNumber: '5550001',
      pharmsmartPharmacyId: '30',
      prefill: { pharmacyEmail: 'shop@pharmacy.test' },
      onboardingRequest: null,
      hold: null,
      awaiting: null,
      termsRequired: false,
      termsRequest: null,
    });
    assert.equal(created.length, 0);
    assert.equal(minted.length, 0);
    assert.equal(audits.at(-1)?.event, 'auth.pharmsmart_sso_refused');
    assert.equal(audits.at(-1)?.organisationId, null);
    assert.deepEqual(audits.at(-1)?.details, { reason: 'WELCOME' });
    assert.equal(JSON.stringify(audits.at(-1)?.details).includes('amina.khan'), false);
  });

  it('returns the awaiting-activation view for a GPhC whose request is pending', async () => {
    const { sso, created, minted, lookedUp } = service(info({ gphc: '555 0001' }), undefined, { '5550001': 'PENDING' });
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'welcome');
    if (result.status !== 'welcome') return;
    assert.equal(result.onboardingRequest, 'pending');
    assert.equal(result.awaiting?.heading, 'We’re setting up your account', 'the admin-edited Awaiting activation wording');
    assert.match(result.awaiting?.paragraphs[0] ?? '', /is with Curaleaf$/);
    assert.equal(result.hold, null);
    assert.deepEqual(lookedUp, ['5550001']);
    assert.equal(created.length, 0);
    assert.equal(minted.length, 0);
  });

  it('resumes at the Terms step when the request was sent but the Terms were never accepted', async () => {
    const { sso } = service(info({ gphc: '5550001' }), undefined, { '5550001': 'PENDING_NO_TERMS' });
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'welcome');
    if (result.status !== 'welcome') return;
    assert.equal(result.onboardingRequest, 'terms_outstanding');
    assert.deepEqual(result.termsRequest, {
      id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11',
      pharmacyName: 'Shah Pharmacy',
      registeredCompanyName: 'Shah Health Ltd',
    });
  });

  it('a pending request with the Terms accepted shows awaiting activation, with no Terms to resume', async () => {
    const { sso } = service(info({ gphc: '5550001' }), undefined, { '5550001': 'PENDING' });
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status === 'welcome' && result.termsRequest, null);
  });

  it('signs PharmSmart superintendent and manager names into the welcome for the Terms soft check', async () => {
    const { sso } = service(info({
      gphc: '5550001',
      superintendent: { first_name: 'Asha', last_name: 'Shah' },
      manager: { first_name: 'Ravi', last_name: 'Patel' },
    }));
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'welcome');
    if (result.status !== 'welcome') return;
    const claims = readPharmsmartNamesTicket(result.pharmsmartTicket, SECRET);
    assert.equal(claims?.gphcNumber, '5550001');
    assert.deepEqual(claims?.people, [{ firstName: 'Asha', lastName: 'Shah' }, { firstName: 'Ravi', lastName: 'Patel' }]);
    assert.equal(readPharmsmartNamesTicket(result.pharmsmartTicket, 'another-secret'), null);
  });

  it('returns the on-hold view for a GPhC whose request is on hold, with its reason\'s hold message', async () => {
    const { sso } = service(info({ gphc: '5550001' }), undefined, { '5550001': 'ON_HOLD' });
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status === 'welcome' && result.onboardingRequest, 'on_hold');
    assert.deepEqual(result.status === 'welcome' && result.hold, {
      reason: 'CURALEAF_DECLINED',
      heading: 'Your application is on hold',
      paragraphs: ['Shah Pharmacy is on hold'],
      footer: 'Questions?',
    });
  });

  it('carries no hold message for a pending request', async () => {
    const { sso } = service(info({ gphc: '5550001' }), undefined, { '5550001': 'PENDING' });
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status === 'welcome' && result.hold, null);
  });

  it('opens no session for a branch on hold: the welcome shows its hold message instead', async () => {
    const { sso, created, adopted, minted, audits, branchHolds } = service(info(), [
      { id: organisationId, gphcNumber: '1234471', primaryContactUid: 'owner-uid', status: 'ON_HOLD', name: 'Khan Pharmacy' },
    ]);
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'welcome');
    if (result.status !== 'welcome') return;
    assert.equal(result.onboardingRequest, 'on_hold');
    assert.deepEqual(result.hold?.paragraphs, ['Khan Pharmacy needs more information']);
    assert.equal(result.termsRequest, null);
    assert.deepEqual(branchHolds, [{ id: organisationId, name: 'Khan Pharmacy' }]);
    assert.deepEqual([created, adopted, minted], [[], [], []]);
    assert.equal(audits.at(-1)?.organisationId, organisationId);
    assert.deepEqual(audits.at(-1)?.details, { reason: 'ON_HOLD' });
  });

  it('refuses to finish PharmSmart setup for a branch put on hold meanwhile, with the hold message', async () => {
    const first = service(info({}, { email: '' }));
    const setup = await first.sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(setup.status, 'setup');
    if (setup.status !== 'setup') return;
    const held = service(info(), [{ id: organisationId, gphcNumber: '1234471', status: 'ON_HOLD', name: 'Khan Pharmacy' }]);
    await assert.rejects(
      () => held.sso.completeSetup({ ticket: setup.ticket, email: 'amina.khan@pharmacy.test' }, { requestId: null, ipHash: null }),
      (error: unknown) => error instanceof HttpError
        && error.statusCode === 403
        && error.code === 'PHARMACY_ON_HOLD'
        && (error.details as { hold: { reason: string } }).hold.reason === 'MORE_INFORMATION_NEEDED',
    );
    assert.deepEqual(held.minted, []);
  });

  it('shows the forms when the latest request is not pending or on hold', async () => {
    const { sso } = service(info({ gphc: '5550001' }), undefined, { '5550001': 'ACTIVATED' });
    const result = await sso.redeem('opaque-token', { requestId: null, ipHash: null });
    assert.equal(result.status === 'welcome' && result.onboardingRequest, null);
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
