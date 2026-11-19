import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { PharmacyOnboardingFields, PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { submitPharmacyOnboardingRequest } from './submit-request.js';

const fields: PharmacyOnboardingFields = {
  pharmacistName: 'Amina Khan',
  pharmacyName: 'Eastwood Health',
  registeredCompanyName: 'Eastwood Health Ltd',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
  deliveryAddress: '2 High Street, Leeds, LS1 1AB',
  gphcNumber: '207 8912',
  pharmacyEmail: 'pharmacy@eastwood.test',
  accountsEmail: 'accounts@eastwood.test',
  pharmacyPhone: '0113 000 0000',
  accountsPhone: '0113 000 0001',
  faxNumber: '',
  signatureName: 'Amina Khan',
  idempotencyKey: 'idempotency-key-1',
};

const licence = Buffer.from('%PDF-1.7\nlicence');

function repo(overrides: {
  organisations?: Array<{ id: string; gphcNumber: string; status?: string }>;
  open?: { id: string; status: 'PENDING' | 'ON_HOLD'; idempotencyKey: string } | null;
  existing?: PharmacyOnboardingRequestRecord | null;
} = {}) {
  const saved: unknown[] = [];
  return {
    saved,
    listOrganisationGphcNumbers: async () => overrides.organisations ?? [],
    findByIdempotencyKey: async () => overrides.existing ?? null,
    findOpenByGphc: async () => overrides.open ?? null,
    insert: async (input: unknown) => { saved.push(input); },
  };
}

describe('submitPharmacyOnboardingRequest', () => {
  it('tells a pharmacy waiting on Curaleaf that its form has already arrived', async () => {
    await assert.rejects(
      () => submitPharmacyOnboardingRequest(repo({ organisations: [{ id: 'org-1', gphcNumber: '2078912', status: 'ONBOARDING' }] }), {
        saveObject: async () => {},
        deleteFile: async () => {},
      }, { fields, licence: null }),
      (error: unknown) => error instanceof HttpError && error.code === 'ONBOARDING_ALREADY_RECEIVED' && /already have/.test(error.message),
    );
  });

  it('refuses a GPhC that already belongs to a live pharmacy', async () => {
    await assert.rejects(
      () => submitPharmacyOnboardingRequest(repo({ organisations: [{ id: 'org-1', gphcNumber: '2078912', status: 'LIVE' }] }), {
        saveObject: async () => {},
        deleteFile: async () => {},
      }, { fields, licence: { filename: 'licence.pdf', declaredType: 'application/pdf', bytes: licence } }),
      (error: unknown) => error instanceof HttpError && error.code === 'GPHC_ALREADY_ON_PLATFORM',
    );
  });

  it('refuses a second request while one is waiting', async () => {
    await assert.rejects(
      () => submitPharmacyOnboardingRequest(repo({ open: { id: 'req-1', status: 'PENDING', idempotencyKey: 'other-key' } }), {
        saveObject: async () => {},
        deleteFile: async () => {},
      }, { fields, licence: { filename: 'licence.pdf', declaredType: 'application/pdf', bytes: licence } }),
      (error: unknown) => error instanceof HttpError && error.code === 'ONBOARDING_ALREADY_RECEIVED',
    );
  });

  it('refuses a GPhC whose request is on hold, without giving the reason', async () => {
    const saved: string[] = [];
    await assert.rejects(
      () => submitPharmacyOnboardingRequest(repo({ open: { id: 'req-1', status: 'ON_HOLD', idempotencyKey: 'other-key' } }), {
        saveObject: async path => { saved.push(path); },
        deleteFile: async () => {},
      }, { fields, licence: null }),
      (error: unknown) => error instanceof HttpError
        && error.code === 'ONBOARDING_ON_HOLD'
        && error.statusCode === 409
        && /^Your application is on hold\./.test(error.message)
        && !/Curaleaf/.test(error.message)
        && /onboarding@holistichealthhub\.live/.test(error.message),
    );
    assert.deepEqual(saved, []);
  });

  it('refuses a GPhC whose activated branch is on hold', async () => {
    await assert.rejects(
      () => submitPharmacyOnboardingRequest(repo({ organisations: [{ id: 'org-1', gphcNumber: '2078912', status: 'ON_HOLD' }] }), {
        saveObject: async () => {},
        deleteFile: async () => {},
      }, { fields, licence: null }),
      (error: unknown) => error instanceof HttpError && error.code === 'ONBOARDING_ON_HOLD' && error.statusCode === 409,
    );
  });

  it('lets a group apply for a second branch (another GPhC) with the same pharmacy email', async () => {
    const store = repo();
    await submitPharmacyOnboardingRequest(store, { saveObject: async () => {}, deleteFile: async () => {} }, { fields });
    const second = await submitPharmacyOnboardingRequest(
      store,
      { saveObject: async () => {}, deleteFile: async () => {} },
      { fields: { ...fields, gphcNumber: '207 8913', pharmacyEmail: 'PHARMACY@eastwood.test', idempotencyKey: 'idempotency-key-2' } },
    );
    assert.equal(second.status, 'PENDING');
    assert.equal(second.gphcNumber, '2078913');
    assert.equal(store.saved.length, 2);
  });

  it('stores a compact GPhC and both files', async () => {
    const paths: string[] = [];
    const store = repo();
    const record = await submitPharmacyOnboardingRequest(store, {
      saveObject: async path => { paths.push(path); },
      deleteFile: async () => {},
    }, {
      fields,
      now: new Date('2026-11-13T12:00:00.000Z'),
    });
    assert.equal(record.gphcNumber, '2078912');
    assert.equal(record.status, 'PENDING');
    assert.equal(record.organisationId, null);
    assert.equal(record.signedOn, '2026-11-13');
    assert.equal(record.licenceStoragePath, '');
    assert.deepEqual(paths, [
      `pharmacy-onboarding/${record.id}/curaleaf-account.pdf`,
    ]);
    assert.equal(store.saved.length, 1);
  });
});
