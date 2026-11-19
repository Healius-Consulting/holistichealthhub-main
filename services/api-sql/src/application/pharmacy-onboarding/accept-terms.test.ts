import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { PharmacyOnboardingRequestRecord, PharmacyOnboardingStatus } from '../../domain/pharmacy-onboarding/request.js';
import {
  issuePharmsmartNamesTicket,
  partnerTermsAcceptanceSchema,
  type PartnerTermsAcceptanceRecord,
} from '../../domain/pharmacy-onboarding/terms.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import { acceptPartnerTerms } from './accept-terms.js';

const REQUEST_ID = '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';
const SECRET = 'terms-test-secret';

function request(status: PharmacyOnboardingStatus = 'PENDING'): PharmacyOnboardingRequestRecord {
  return {
    id: REQUEST_ID,
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
    signedOn: '2026-11-19',
    licenceStoragePath: '',
    licenceContentType: '',
    licenceFilename: '',
    filledFormStoragePath: `pharmacy-onboarding/${REQUEST_ID}/curaleaf-account.pdf`,
    organisationId: null,
    declineReason: null,
    decidedAt: null,
    decidedByUid: null,
    idempotencyKey: 'idempotency-key-1',
    createdAt: '2026-11-19T14:05:00.000Z',
  };
}

function harness(status: PharmacyOnboardingStatus = 'PENDING', options: { failQueueOnce?: boolean } = {}) {
  const rows: PartnerTermsAcceptanceRecord[] = [];
  const emails: Array<{ templateCode: string; idempotencyKey: string; toRecipients?: string[] | null }> = [];
  let failQueue = options.failQueueOnce ?? false;
  const notificationRepo = {
    async enqueue(data: { templateCode: string; idempotencyKey: string; toRecipients?: string[] | null }) {
      if (failQueue) {
        failQueue = false;
        throw new Error('outbox unavailable');
      }
      if (emails.some(row => row.idempotencyKey === data.idempotencyKey)) return { created: false };
      emails.push(data);
      return { created: true };
    },
  } as unknown as NotificationRepositoryPort;
  const deps = {
    repo: {
      findById: async (id: string) => (id === REQUEST_ID ? request(status) : null),
      findTermsAcceptances: async (id: string) => rows.filter(row => row.onboardingRequestId === id),
      insertTermsAcceptance: async (row: Omit<PartnerTermsAcceptanceRecord, 'organisationId'>) => {
        rows.push({ ...row, organisationId: null });
      },
    },
    notificationRepo,
    termsVersion: 'v-test',
    ticketSecret: SECRET,
  };
  return { deps, rows, emails };
}

function input(overrides: Record<string, unknown> = {}) {
  return partnerTermsAcceptanceSchema.parse({
    onboardingRequestId: REQUEST_ID,
    signerName: 'Asha Shah',
    signerRole: 'SUPERINTENDENT_PHARMACIST',
    signerEmail: 'Asha@Shah.test',
    signerGphcNumber: '2045 678',
    authorised: true,
    ...overrides,
  });
}

const curaleaf = <T extends { templateCode: string }>(emails: T[]) => emails.filter(row => row.templateCode === 'curaleaf_new_account_application');

describe('Partner Terms validation', () => {
  it('requires the declaration to be ticked', () => {
    assert.throws(() => input({ authorised: false }));
    assert.throws(() => input({ authorised: undefined }));
  });

  it('requires a typed-name signature', () => {
    assert.throws(() => input({ signerName: ' ' }));
    assert.throws(() => input({ signerName: undefined }));
  });

  it('requires a 7-digit GPhC registration from a pharmacist, and not from anyone else', () => {
    assert.throws(() => input({ signerGphcNumber: '' }), /GPhC registration/);
    assert.throws(() => input({ signerRole: 'PHARMACIST', signerGphcNumber: '12345' }), /GPhC registration/);
    assert.doesNotThrow(() => input({ signerRole: 'DIRECTOR', signerGphcNumber: '' }));
    assert.doesNotThrow(() => input({ signerRole: 'PHARMACY_MANAGER', signerGphcNumber: undefined }));
  });

  it('refuses an unknown role and a bad email', () => {
    assert.throws(() => input({ signerRole: 'OWNER' }));
    // Other needs the role in the signer's own words.
    assert.throws(() => input({ signerRole: 'OTHER', signerRoleOther: ' ' }), /Type your role/);
    assert.doesNotThrow(() => input({ signerRole: 'OTHER', signerRoleOther: 'Company secretary' }));
    assert.throws(() => input({ signerEmail: 'not-an-email' }));
  });
});

describe('acceptPartnerTerms', () => {
  it('writes one acceptance row against the request with the version, signer and hashed IP', async () => {
    const h = harness();
    const result = await acceptPartnerTerms(h.deps, input(), { ipHash: 'hashed-ip', now: new Date('2026-11-19T14:20:00.000Z') });
    assert.equal(h.rows.length, 1);
    const row = h.rows[0]!;
    assert.equal(row.onboardingRequestId, REQUEST_ID);
    assert.equal(row.organisationId, null);
    assert.equal(row.termsVersion, 'v-test');
    assert.equal(row.signerName, 'Asha Shah');
    assert.equal(row.signerRole, 'SUPERINTENDENT_PHARMACIST');
    assert.equal(row.signerEmail, 'asha@shah.test');
    assert.equal(row.signerGphcNumber, '2045678');
    assert.equal(row.registeredCompanyName, 'Shah Health Ltd');
    assert.equal(row.acceptedAt, '2026-11-19T14:20:00.000Z');
    assert.equal(row.ipAddress, 'hashed-ip');
    assert.equal(row.source, 'signup');
    assert.equal(row.nameMatchesPharmsmart, null);
    assert.equal(result.acceptance.id, row.id);
  });

  it('keeps no GPhC registration for a signer who is not a pharmacist', async () => {
    const h = harness();
    await acceptPartnerTerms(h.deps, input({ signerRole: 'DIRECTOR', signerGphcNumber: '2045678' }), { ipHash: null });
    assert.equal(h.rows[0]!.signerGphcNumber, null);
  });

  it('queues the Curaleaf application and the pharmacy receipt once, only after the Terms', async () => {
    const h = harness();
    assert.equal(h.emails.length, 0);
    await acceptPartnerTerms(h.deps, input(), { ipHash: null });
    assert.equal(curaleaf(h.emails).length, 1);
    assert.deepEqual(curaleaf(h.emails)[0]!.toRecipients, ['robbie.allison@curaleaflaboratories.co.uk', 'ellis.walters@curaleaflaboratories.co.uk']);
    assert.deepEqual(h.emails.map(row => row.templateCode).sort(), ['curaleaf_new_account_application', 'pharmacy_onboarding_submitted']);
  });

  it('a retry writes no second row and sends nothing again', async () => {
    const h = harness();
    const first = await acceptPartnerTerms(h.deps, input(), { ipHash: null });
    const second = await acceptPartnerTerms(h.deps, input({ signerName: 'Someone Else' }), { ipHash: null });
    assert.equal(h.rows.length, 1);
    assert.equal(second.acceptance.id, first.acceptance.id);
    assert.equal(curaleaf(h.emails).length, 1);
    assert.equal(h.emails.length, 2);
  });

  it('a retry after the outbox failed queues the Curaleaf email it missed', async () => {
    const h = harness('PENDING', { failQueueOnce: true });
    await assert.rejects(acceptPartnerTerms(h.deps, input(), { ipHash: null }), /outbox unavailable/);
    assert.equal(h.rows.length, 1);
    await acceptPartnerTerms(h.deps, input(), { ipHash: null });
    assert.equal(h.rows.length, 1);
    assert.equal(curaleaf(h.emails).length, 1);
  });

  it('refuses an unknown request and a request already decided, sending nothing', async () => {
    const missing = harness();
    await assert.rejects(
      acceptPartnerTerms(missing.deps, input({ onboardingRequestId: '7c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11' }), { ipHash: null }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404,
    );
    for (const status of ['ON_HOLD', 'ACTIVATED'] as const) {
      const h = harness(status);
      await assert.rejects(
        acceptPartnerTerms(h.deps, input(), { ipHash: null }),
        (error: unknown) => error instanceof HttpError && error.code === 'ONBOARDING_REQUEST_DECIDED',
      );
      assert.equal(h.rows.length, 0);
      assert.equal(h.emails.length, 0);
    }
  });

  it('flags the signer against the PharmSmart superintendent and manager, never blocking', async () => {
    const ticket = issuePharmsmartNamesTicket({
      gphcNumber: '123 4567',
      people: [{ firstName: 'Asha', lastName: 'Shah' }, { firstName: 'Ravi', lastName: 'Patel' }],
    }, SECRET);
    const matched = harness();
    await acceptPartnerTerms(matched.deps, input({ signerName: 'ravi  PATEL', signerRole: 'PHARMACY_MANAGER', pharmsmartTicket: ticket }), { ipHash: null });
    assert.equal(matched.rows[0]!.nameMatchesPharmsmart, true);

    const mismatched = harness();
    await acceptPartnerTerms(mismatched.deps, input({ signerName: 'Jo Bloggs', pharmsmartTicket: ticket }), { ipHash: null });
    assert.equal(mismatched.rows[0]!.nameMatchesPharmsmart, false);
    assert.equal(curaleaf(mismatched.emails).length, 1);
  });

  it('does not trust a forged ticket or one for another GPhC', async () => {
    const forged = issuePharmsmartNamesTicket({ gphcNumber: '1234567', people: [{ firstName: 'Jo', lastName: 'Bloggs' }] }, 'wrong-secret');
    const h = harness();
    await acceptPartnerTerms(h.deps, input({ signerName: 'Jo Bloggs', pharmsmartTicket: forged }), { ipHash: null });
    assert.equal(h.rows[0]!.nameMatchesPharmsmart, null);

    const otherBranch = issuePharmsmartNamesTicket({ gphcNumber: '7654321', people: [{ firstName: 'Jo', lastName: 'Bloggs' }] }, SECRET);
    const other = harness();
    await acceptPartnerTerms(other.deps, input({ signerName: 'Jo Bloggs', pharmsmartTicket: otherBranch }), { ipHash: null });
    assert.equal(other.rows[0]!.nameMatchesPharmsmart, null);
  });
});
