import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { resolveWebsiteAssignedPharmacy } from './website-assignment.js';

const eastwood: OrganisationRecord = {
  id: '6d0176bb-89a0-4e32-9bce-c934c9557c42', companyId: null, name: 'Eastwood Health Pharmacy',
  tradingName: 'Eastwood Health Ltd', gphcNumber: '9012726', superintendentName: 'Test Pharmacist',
  mainContactName: null, mainContactPhone: null, mainContactEmail: null, address: 'Test address',
  addressLine1: null, addressLine2: null, locality: null, county: null, postcode: null, latitude: null, longitude: null,
  primaryColour: '#1e40af', logoText: 'EH', status: 'ONBOARDING', classification: 'STANDARD',
  portalName: 'Eastwood Health Pharmacy', intakeEnabled: true, prescriptionEnabled: true, paymentsEnabled: true,
  supplierOrdersEnabled: true, patientsEnabled: true, resourcesEnabled: true, worldpayEnabled: false,
  defaultPaymentRoute: 'MANUAL', pharmacyDeliveryEnabled: false, autoPlacementEnabled: false, gdprComplianceFlag: true,
  pausedReason: null, pausedAt: null, version: 1, archivedAt: null,
};

describe('website selected pharmacy assignment', () => {
  it('assigns the chosen onboarding pharmacy immediately', () => {
    const assigned = resolveWebsiteAssignedPharmacy(eastwood);
    assert.equal(assigned?.id, eastwood.id);
  });

  it('fails closed when the selected pharmacy cannot be loaded', () => {
    assert.equal(resolveWebsiteAssignedPharmacy(null), null);
  });

  it('fails closed for training directory pharmacies', () => {
    assert.equal(resolveWebsiteAssignedPharmacy({
      ...eastwood,
      id: '70913a30-71c3-4a41-952e-d532927af58c',
      name: 'Primary Branch',
      tradingName: 'Primary Pharmacy',
      status: 'LIVE',
    }), null);
  });
});
