import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { canAcceptPublicIntake, canActivateReferredPatient, canReceiveReferral, pharmacyIntakeDirectoryAccess, pharmacyOperationalAccess, pharmacyPortalRecordAccess, pharmacyWorkspaceMode } from './access.js';

const organisation: OrganisationRecord = {
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

describe('pharmacy intake access', () => {
  it('lets public tokens and HHH assignment work from Day-0 onboarding', () => {
    assert.equal(canAcceptPublicIntake({ ...organisation, status: 'ONBOARDING' }), true);
    assert.equal(canReceiveReferral({ ...organisation, status: 'ONBOARDING' }), true);
    assert.equal(canAcceptPublicIntake(organisation), true);
    assert.equal(canReceiveReferral(organisation), true);
    assert.equal(canReceiveReferral({ ...organisation, status: 'INTAKE_LIVE' }), true);
    assert.equal(canReceiveReferral({ ...organisation, classification: 'ALLOCATION_HOLDING' }), true);
    assert.equal(canReceiveReferral({ ...organisation, classification: 'TRAINING' }), false);
    assert.equal(canReceiveReferral({ ...organisation, status: 'PAUSED' }), false);
    assert.equal(canAcceptPublicIntake({ ...organisation, status: 'ONBOARDING', intakeEnabled: false }), false);
    assert.equal(canAcceptPublicIntake({ ...organisation, gphcNumber: 'TRAINING-PHARM1', status: 'ONBOARDING' }), false);
    assert.equal(canAcceptPublicIntake({ ...organisation, gphcNumber: 'TRAINING-PHARM1', status: 'LIVE' }), true);
  });

  it('withholds pharmacy workspace data until go-live', () => {
    assert.equal(pharmacyOperationalAccess(organisation), true);
    assert.equal(pharmacyOperationalAccess({ ...organisation, classification: 'ALLOCATION_HOLDING' }), true);
    assert.equal(pharmacyOperationalAccess({ ...organisation, status: 'INTAKE_LIVE' }), false);
    assert.equal(pharmacyOperationalAccess({ ...organisation, status: 'ONBOARDING' }), false);
    assert.equal(pharmacyOperationalAccess({ ...organisation, classification: 'TRAINING' }), false);
    assert.equal(pharmacyOperationalAccess({ ...organisation, status: 'PAUSED' }), true);
    assert.equal(canActivateReferredPatient(organisation), true);
    assert.equal(canActivateReferredPatient({ ...organisation, status: 'PAUSED' }), false);
    assert.equal(canActivateReferredPatient({ ...organisation, status: 'ONBOARDING' }), true);
    assert.equal(canActivateReferredPatient({ ...organisation, status: 'INTAKE_LIVE' }), true);
    assert.equal(canActivateReferredPatient({ ...organisation, classification: 'TRAINING' }), false);
    assert.equal(canActivateReferredPatient({
      ...organisation,
      id: '70913a30-71c3-4a41-952e-d532927af58c',
      name: 'Primary Branch',
      tradingName: 'Primary Pharmacy',
    }), false);
    assert.equal(pharmacyWorkspaceMode({ ...organisation, status: 'ONBOARDING' }), 'training');
    assert.equal(pharmacyWorkspaceMode({ ...organisation, status: 'INTAKE_LIVE' }), 'training');
    assert.equal(pharmacyWorkspaceMode(organisation), 'live');
    assert.equal(pharmacyWorkspaceMode({ ...organisation, classification: 'ALLOCATION_HOLDING', status: 'ONBOARDING' }), 'live');
    assert.equal(pharmacyWorkspaceMode({ ...organisation, status: 'PAUSED' }), 'paused');
    assert.equal(pharmacyIntakeDirectoryAccess({ ...organisation, status: 'ONBOARDING' }), true);
    assert.equal(pharmacyIntakeDirectoryAccess({
      ...organisation,
      id: '70913a30-71c3-4a41-952e-d532927af58c',
      name: 'Primary Branch',
    }), false);
    const onboarding = pharmacyPortalRecordAccess({ ...organisation, status: 'ONBOARDING' });
    assert.deepEqual(onboarding, { patients: true, orders: false, pendingEnquiries: true });
    const sandbox = pharmacyPortalRecordAccess({
      ...organisation,
      id: '70913a30-71c3-4a41-952e-d532927af58c',
      name: 'Primary Branch',
    });
    assert.deepEqual(sandbox, { patients: false, orders: true, pendingEnquiries: false });
    const paused = pharmacyPortalRecordAccess({ ...organisation, status: 'PAUSED' });
    assert.deepEqual(paused, { patients: true, orders: true, pendingEnquiries: false });
  });
});
