import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { PharmacyOnboardingRequestRecord, PharmacyOnboardingStatus } from '../../domain/pharmacy-onboarding/request.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import { FakeClickupRepository, FakeVisitRepository } from '../../testing/clickup-fakes.js';
import { PharmsmartSsoService } from '../identity/pharmsmart-sso.service.js';
import { pharmacyRequestActions, type PharmacyRequestActionDeps } from '../pharmacy-onboarding/request-actions.js';
import { clickupHooks } from './clickup-hooks.js';

const REASON = 'Premises check failed against the register.';
const id = '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';

function request(status: PharmacyOnboardingStatus): PharmacyOnboardingRequestRecord {
  return {
    id,
    status,
    pharmacistName: 'Asha Shah',
    pharmacyName: 'Shah Pharmacy',
    registeredCompanyName: 'Shah Health Ltd',
    invoiceAddress: '1 High Street, Leeds, LS1 1AA',
    deliveryAddress: '1 High Street, Leeds, LS1 1AA',
    gphcNumber: '1234567',
    pharmacyEmail: 'shop@shah.test',
    accountsEmail: 'accounts@shah.test',
    pharmacyPhone: '0113 000 0000',
    accountsPhone: '0113 000 0001',
    faxNumber: null,
    signatureName: 'Asha Shah',
    signedOn: '2026-11-18',
    licenceStoragePath: '',
    licenceContentType: '',
    licenceFilename: '',
    filledFormStoragePath: '',
    organisationId: null,
    declineReason: status === 'ON_HOLD' ? REASON : null,
    decidedAt: null,
    decidedByUid: null,
    idempotencyKey: 'key-1',
    createdAt: '2026-11-18T09:00:00.000Z',
  };
}

function actions(status: PharmacyOnboardingStatus, clickup: PharmacyRequestActionDeps['clickup']) {
  let row = request(status);
  return pharmacyRequestActions({
    repo: {
      findById: async () => ({ ...row }),
      listOrganisationGphcNumbers: async () => [],
      activate: async (_id, organisationId) => { row = { ...row, status: 'ACTIVATED', organisationId }; },
      hold: async (_id, reason, decidedAt) => { row = { ...row, status: 'ON_HOLD', declineReason: reason, decidedAt }; },
      unhold: async () => { row = { ...row, status: 'PENDING' }; },
      linkTermsAcceptances: async () => undefined,
    },
    organisations: { createOrganisation: async () => undefined } as unknown as PharmacyRequestActionDeps['organisations'],
    referralLinks: { ensureEligibilityLink: async () => ({ token: 'token-1' }) },
    notificationRepo: { enqueue: async () => ({ created: true }) } as unknown as NotificationRepositoryPort,
    audit: async () => undefined,
    clickup,
  });
}

const throwing = {
  activated: async () => { throw new Error('ClickUp outbox down'); },
  held: async () => { throw new Error('ClickUp outbox down'); },
  unheld: async () => { throw new Error('ClickUp outbox down'); },
};

let originalError: typeof console.error;
beforeEach(() => {
  originalError = console.error;
  console.error = () => undefined;
});
afterEach(() => {
  console.error = originalError;
});

describe('ClickUp wiring into the admin request actions', () => {
  it('activates, holds and unholds even when queueing for ClickUp throws', async () => {
    const activated = await actions('PENDING', throwing).activate({ id, actorUid: 'admin-1' });
    assert.equal(activated.request?.status, 'ACTIVATED');
    const held = await actions('PENDING', throwing).hold({ id, reason: REASON, actorUid: 'admin-1' });
    assert.equal(held.status, 'ON_HOLD');
    const unheld = await actions('ON_HOLD', throwing).unhold({ id });
    assert.equal(unheld.status, 'PENDING');
  });

  it('queues each action for the card, and never the admin-only hold reason', async () => {
    const repo = new FakeClickupRepository();
    const hooks = clickupHooks({ clickupRepo: repo, visitRepo: new FakeVisitRepository() });
    await actions('PENDING', hooks).hold({ id, reason: REASON, actorUid: 'admin-1' });
    await actions('ON_HOLD', hooks).unhold({ id });
    const result = await actions('PENDING', hooks).activate({ id, actorUid: 'admin-1' });
    assert.deepEqual(repo.outbox.map(row => row.event), ['held', 'unheld', 'activated']);
    assert.equal(repo.outbox[2]!.payload.branchId, result.organisation.id);
    assert.equal(JSON.stringify(repo.outbox).includes(REASON), false);
  });
});

function pharmsmartInfo() {
  return JSON.stringify({
    status_code: 200,
    data: {
      pharmacy_id: 30,
      email: 'shop@pharmacy.test',
      gphc: '1234471',
      trading_name: 'Corner Pharmacy',
      sso_user: { first_name: 'Amina', last_name: 'Khan', email: 'amina.khan@pharmacy.test' },
    },
  });
}

function sso(recordFirstVisit: ConstructorParameters<typeof PharmsmartSsoService>[0]['recordFirstVisit'], requestStatus: PharmacyOnboardingStatus | null = null) {
  return new PharmsmartSsoService({
    fetchPharmacyInfo: async () => pharmsmartInfo(),
    listOrganisations: async () => [],
    findLatestOnboardingRequest: async () => (requestStatus ? { id: 'request-1', status: requestStatus, termsAccepted: true, pharmacyName: 'Test Pharmacy', registeredCompanyName: 'Test Pharmacy Ltd' } : null),
    listStaff: async () => [],
    findEmailOwner: async () => null,
    adoptAccount: async () => undefined,
    createAccount: async () => 'uid',
    createCustomToken: async () => 'token',
    audit: async () => undefined,
    setupSecret: 'secret',
    recordFirstVisit,
  });
}

describe('ClickUp wiring into the PharmSmart welcome', () => {
  it('records the first visit with the pharmacy\'s details only', async () => {
    const repo = new FakeClickupRepository();
    const visits = new FakeVisitRepository();
    const hooks = clickupHooks({ clickupRepo: repo, visitRepo: visits });
    const result = await sso(hooks.firstVisit).redeem('token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'welcome');
    assert.deepEqual(
      { ...visits.visits.get('1234471'), firstVisitAt: undefined },
      { gphcNumber: '1234471', pharmsmartPharmacyId: '30', tradingName: 'Corner Pharmacy', firstVisitAt: undefined, submittedAt: null },
    );
    assert.deepEqual(repo.outbox.map(row => row.event), ['interest']);
    assert.equal(JSON.stringify(repo.outbox).includes('amina'), false);
  });

  it('does not record a visit for a GPhC that already has a request', async () => {
    const calls: unknown[] = [];
    await sso(async visit => { calls.push(visit); }, 'PENDING').redeem('token', { requestId: null, ipHash: null });
    assert.deepEqual(calls, []);
  });

  it('still shows the welcome when recording the visit throws', async () => {
    const result = await sso(async () => { throw new Error('Data Connect down'); }).redeem('token', { requestId: null, ipHash: null });
    assert.equal(result.status, 'welcome');
  });
});
