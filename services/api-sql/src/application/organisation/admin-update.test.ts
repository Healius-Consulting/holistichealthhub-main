import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZodError } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import {
  resolveOrganisationStatusChange,
  updateAdminOrganisationDetails,
  updateOrganisationInputSchema,
} from './admin-update.js';

const organisation: OrganisationRecord = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  companyId: null,
  name: 'Eligible Pharmacy Ltd',
  tradingName: 'Eligible Pharmacy',
  gphcNumber: '9012345',
  superintendentName: 'Test Pharmacist',
  mainContactName: 'Alex Admin',
  mainContactPhone: '0115 000 0000',
  mainContactEmail: 'pharmacy@example.test',
  address: '1 High Street, Nottingham, NG1 1AA',
  addressLine1: '1 High Street',
  addressLine2: null,
  locality: 'Nottingham',
  county: null,
  postcode: 'NG1 1AA',
  latitude: 52.95,
  longitude: -1.15,
  primaryColour: '#12372d',
  logoText: 'EP',
  status: 'ONBOARDING',
  classification: 'STANDARD',
  portalName: 'Eligible Pharmacy',
  intakeEnabled: true,
  prescriptionEnabled: true,
  paymentsEnabled: true,
  supplierOrdersEnabled: true,
  patientsEnabled: true,
  resourcesEnabled: true,
  worldpayEnabled: false,
  defaultPaymentRoute: 'MANUAL',
  autoPlacementEnabled: false,
  gdprComplianceFlag: true,
  pausedReason: null,
  pausedAt: null,
  version: 1,
  archivedAt: null,
};

function createRepos(current: OrganisationRecord | null = organisation) {
  let stored = current;
  const profileUpdates: unknown[] = [];
  const brandUpdates: unknown[] = [];
  const statusUpdates: unknown[] = [];
  const createdDomains: string[] = [];
  const deletedDomains: string[] = [];
  const directoryUpserts: unknown[] = [];

  return {
    profileUpdates,
    brandUpdates,
    statusUpdates,
    createdDomains,
    deletedDomains,
    directoryUpserts,
    organisationRepo: {
      async findOrganisationById() {
        return stored;
      },
      async updateOrganisationProfile(_id: string, input: Partial<OrganisationRecord> & { superintendentName?: string }) {
        if (!stored) return;
        stored = {
          ...stored,
          ...input,
          superintendentName: input.superintendentName ?? stored.superintendentName,
        };
        profileUpdates.push(input);
      },
      async updateOrganisationBrand(_id: string, input: { primaryColour: string; logoText: string; portalName: string }) {
        if (!stored) return;
        stored = { ...stored, ...input };
        brandUpdates.push(input);
      },
      async updateOrganisationStatus(_id: string, status: OrganisationRecord['status']) {
        if (!stored) return;
        stored = { ...stored, status };
        statusUpdates.push(status);
      },
      async listOrganisationDomains() {
        return [{ id: 'domain-1', hostname: 'old.example' }];
      },
      async deleteOrganisationDomain(id: string) {
        deletedDomains.push(id);
      },
      async createOrganisationDomain(_id: string, hostname: string) {
        createdDomains.push(hostname);
      },
    },
    directoryRepo: {
      async upsertProfile(input: unknown) {
        directoryUpserts.push(input);
      },
    },
    normaliseHostname: (value: string) => value.toLowerCase(),
  };
}

describe('updateOrganisationInputSchema', () => {
  it('accepts the admin edit form payload', () => {
    const parsed = updateOrganisationInputSchema.parse({
      name: 'Eligible Pharmacy Ltd',
      tradingName: 'Eligible Pharmacy',
      gphcNumber: '9012345',
      superintendent: 'Test Pharmacist',
      companyNumber: '12345678',
      mainContactName: 'Alex Admin',
      mainContactPhone: '0115 000 0000',
      mainContactEmail: 'pharmacy@example.test',
      address: '1 High Street, Nottingham, NG1 1AA',
      websiteDomains: ['eligible.example'],
      status: 'onboarding',
      logoText: 'EP',
      primaryColour: '#12372D',
      portalName: 'Eligible Pharmacy Ltd',
    });
    assert.equal(parsed.companyNumber, '12345678');
    assert.equal(parsed.status, 'onboarding');
  });

  it('rejects integration and credential fields', () => {
    assert.throws(() => updateOrganisationInputSchema.parse({
      name: 'Eligible Pharmacy Ltd',
      curaleafCustomerId: 'secret-customer',
    }), ZodError);
    assert.throws(() => updateOrganisationInputSchema.parse({
      name: 'Eligible Pharmacy Ltd',
      worldpayMerchantId: 'merchant',
    }), ZodError);
    assert.throws(() => updateOrganisationInputSchema.parse({
      defaultPaymentRoute: 'worldpay',
    }), ZodError);
  });
});

describe('resolveOrganisationStatusChange', () => {
  it('keeps live and intake_live when the form resubmits the current status', () => {
    assert.equal(resolveOrganisationStatusChange('LIVE', 'live'), null);
    assert.equal(resolveOrganisationStatusChange('INTAKE_LIVE', 'intake_live'), null);
    assert.equal(resolveOrganisationStatusChange('INTAKE_LIVE', 'onboarding'), null);
  });

  it('rejects flipping a pharmacy to live or intake_live', () => {
    assert.throws(
      () => resolveOrganisationStatusChange('ONBOARDING', 'live'),
      (error: unknown) => error instanceof HttpError && error.code === 'ACTIVATION_ACTION_REQUIRED' && error.statusCode === 409,
    );
    assert.throws(
      () => resolveOrganisationStatusChange('ONBOARDING', 'intake_live'),
      (error: unknown) => error instanceof HttpError && error.code === 'ACTIVATION_ACTION_REQUIRED',
    );
  });

  it('allows pause and explicit onboarding revert from live', () => {
    assert.equal(resolveOrganisationStatusChange('LIVE', 'paused'), 'PAUSED');
    assert.equal(resolveOrganisationStatusChange('LIVE', 'onboarding'), 'ONBOARDING');
    assert.equal(resolveOrganisationStatusChange('PAUSED', 'paused'), null);
  });
});

describe('updateAdminOrganisationDetails', () => {
  it('updates profile, brand and domains and returns the organisation', async () => {
    const deps = createRepos();
    const result = await updateAdminOrganisationDetails(organisation.id, {
      name: 'Renamed Pharmacy Ltd',
      tradingName: 'Renamed Pharmacy',
      gphcNumber: '9012345',
      superintendent: 'Test Pharmacist',
      companyNumber: 'ignored',
      mainContactName: 'Alex Admin',
      mainContactPhone: '0115 000 0000',
      mainContactEmail: 'pharmacy@example.test',
      address: '2 Market Street, Nottingham, NG1 1AA',
      websiteDomains: ['new.example'],
      status: 'onboarding',
      logoText: 'RP',
      primaryColour: '#0F766E',
      portalName: 'Renamed Pharmacy Ltd',
    }, deps);

    assert.equal(result.organisation.name, 'Renamed Pharmacy Ltd');
    assert.equal(result.organisation.logoText, 'RP');
    assert.equal(result.organisation.primaryColour, '#0f766e');
    assert.deepEqual(result.changedFields.includes('companyNumber'), false);
    assert.equal(deps.profileUpdates.length, 1);
    assert.equal((deps.profileUpdates[0] as { address: string }).address, '2 Market Street, Nottingham, NG1 1AA');
    assert.equal((deps.profileUpdates[0] as { addressLine1: string }).addressLine1, '2 Market Street');
    assert.equal(deps.brandUpdates.length, 1);
    assert.deepEqual(deps.deletedDomains, ['domain-1']);
    assert.deepEqual(deps.createdDomains, ['new.example']);
    assert.equal(deps.directoryUpserts.length, 1);
    assert.deepEqual(deps.statusUpdates, []);
  });

  it('rejects flipping status to live', async () => {
    const deps = createRepos();
    await assert.rejects(
      () => updateAdminOrganisationDetails(organisation.id, { status: 'live' }, deps),
      (error: unknown) => error instanceof HttpError && error.code === 'ACTIVATION_ACTION_REQUIRED',
    );
    assert.deepEqual(deps.statusUpdates, []);
  });

  it('returns NOT_FOUND for an unknown organisation', async () => {
    const deps = createRepos(null);
    await assert.rejects(
      () => updateAdminOrganisationDetails(organisation.id, { name: 'Missing Pharmacy Ltd' }, deps),
      (error: unknown) => error instanceof HttpError && error.code === 'NOT_FOUND' && error.statusCode === 404,
    );
  });
});
