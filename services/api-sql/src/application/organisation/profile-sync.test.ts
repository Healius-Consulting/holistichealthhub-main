import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { buildOrganisationProfileUpdate } from './profile-sync.js';

const current: OrganisationRecord = {
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

describe('buildOrganisationProfileUpdate', () => {
  it('uses the admin address blob and keeps structured address fields', async () => {
    const update = await buildOrganisationProfileUpdate(current, {
      name: 'Eligible Pharmacy Ltd',
      address: '2 Market Street, Nottingham, NG1 1AA',
    });
    assert.equal(update.address, '2 Market Street, Nottingham, NG1 1AA');
    assert.equal(update.addressLine1, '2 Market Street');
    assert.equal(update.locality, 'Nottingham');
    assert.equal(update.postcode, 'NG1 1AA');
    assert.equal(update.latitude, 52.95);
  });
});
