import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { buildOrganisationProfileUpdate, publicPharmacyContacts } from './profile-sync.js';

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
  pharmacyDeliveryEnabled: false,
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

describe('publicPharmacyContacts', () => {
  it('gives patients the pharmacy landline and inbox, not the superintendent’s line', async () => {
    const update = await buildOrganisationProfileUpdate(current, { pharmacyPhone: '0115 111 2222', pharmacyEmail: 'hello@eligible.test' });
    assert.equal(update.pharmacyPhone, '0115 111 2222');
    assert.equal(update.mainContactPhone, '0115 000 0000', 'the superintendent contact is untouched');
    assert.deepEqual(publicPharmacyContacts(update), { publicPhone: '0115 111 2222', publicEmail: 'hello@eligible.test' });
  });

  it('falls back to the superintendent contact for records that predate the pharmacy fields', async () => {
    const update = await buildOrganisationProfileUpdate(current, {});
    assert.equal(update.pharmacyPhone, null);
    assert.deepEqual(publicPharmacyContacts(update), { publicPhone: '0115 000 0000', publicEmail: 'pharmacy@example.test' });
  });

  it('clears a pharmacy contact when the form submits it empty', async () => {
    const update = await buildOrganisationProfileUpdate({ ...current, pharmacyEmail: 'old@eligible.test' }, { pharmacyEmail: '' });
    assert.equal(update.pharmacyEmail, null);
  });
});
