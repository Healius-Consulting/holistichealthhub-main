import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { canReceiveReferral, queueQuerySchema } from './intake-v2.router.js';

const eligibleOrganisation: OrganisationRecord = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', companyId: null, name: 'Eligible Pharmacy',
  tradingName: 'Eligible Pharmacy', gphcNumber: '9012345', superintendentName: 'Test Pharmacist',
  mainContactName: null, mainContactPhone: null, mainContactEmail: null, address: 'Test address',
  addressLine1: null, addressLine2: null, locality: null, county: null, postcode: null, latitude: null, longitude: null,
  primaryColour: '#12372d', logoText: 'EP', status: 'LIVE', classification: 'STANDARD',
  portalName: 'Eligible Pharmacy', intakeEnabled: true, prescriptionEnabled: true, paymentsEnabled: true,
  supplierOrdersEnabled: true, patientsEnabled: true, resourcesEnabled: true, worldpayEnabled: false,
  defaultPaymentRoute: 'MANUAL', pharmacyDeliveryEnabled: false, autoPlacementEnabled: false, gdprComplianceFlag: true,
  pausedReason: null, pausedAt: null, version: 1, archivedAt: null,
};

describe('admin intake queue query', () => {
  it('accepts the trusted admin surface marker added by the portal rewrite', () => {
    assert.deepEqual(queueQuerySchema.parse({ __hhh_surface: 'admin' }), {
      __hhh_surface: 'admin',
      limit: 50,
    });
  });

  it('still rejects arbitrary query fields and non-admin surface markers', () => {
    assert.throws(() => queueQuerySchema.parse({ unexpected: 'value' }));
    assert.throws(() => queueQuerySchema.parse({ __hhh_surface: 'pharmacy' }));
  });

  it('offers onboarding, intake-live and live workspaces as destinations, except training sandboxes', () => {
    assert.equal(canReceiveReferral(eligibleOrganisation), true);
    assert.equal(canReceiveReferral({ ...eligibleOrganisation, classification: 'TRAINING' }), false);
    assert.equal(canReceiveReferral({ ...eligibleOrganisation, classification: 'ALLOCATION_HOLDING' }), true);
    assert.equal(canReceiveReferral({ ...eligibleOrganisation, gdprComplianceFlag: false }), true);
    assert.equal(canReceiveReferral({ ...eligibleOrganisation, status: 'PAUSED' }), false);
    assert.equal(canReceiveReferral({ ...eligibleOrganisation, status: 'ONBOARDING' }), true);
    assert.equal(canReceiveReferral({ ...eligibleOrganisation, status: 'INTAKE_LIVE' }), true);
  });
});
