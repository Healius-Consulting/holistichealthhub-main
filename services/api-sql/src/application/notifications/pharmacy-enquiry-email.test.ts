import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IdentityRepositoryPort, StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRecord, OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import { queuePharmacyEnquiryEmail } from './pharmacy-enquiry-email.js';

const eastwoodId = '6d0176bb-89a0-4e32-9bce-c934c9557c42';
const primaryId = '70913a30-71c3-4a41-952e-d532927af58c';

const eastwood: OrganisationRecord = {
  id: eastwoodId, companyId: null, name: 'Eastwood Health Pharmacy',
  tradingName: 'Eastwood Health Ltd', gphcNumber: '9012726', superintendentName: 'Test Pharmacist',
  mainContactName: 'Alex Owner', mainContactPhone: null, mainContactEmail: 'desk@eastwood.test',
  address: 'Test address', addressLine1: null, addressLine2: null, locality: null, county: null, postcode: null,
  latitude: null, longitude: null, primaryColour: '#1e40af', logoText: 'EH', status: 'ONBOARDING',
  classification: 'STANDARD', portalName: 'Eastwood Health Pharmacy', intakeEnabled: true, prescriptionEnabled: true,
  paymentsEnabled: true, supplierOrdersEnabled: true, patientsEnabled: true, resourcesEnabled: true,
  worldpayEnabled: false, defaultPaymentRoute: 'MANUAL', pharmacyDeliveryEnabled: false, autoPlacementEnabled: false,
  gdprComplianceFlag: true, pausedReason: null, pausedAt: null, version: 1, archivedAt: null,
};

const owner: StaffUserRecord = {
  uid: 'owner-uid',
  organisationId: eastwoodId,
  email: 'owner@eastwood.test',
  displayName: 'Alex Owner',
  role: 'PHARMACY_STAFF',
  status: 'ACTIVE',
  disabled: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  version: 1,
};

function notificationRepo(enqueued: unknown[]) {
  return {
    enqueue: async (data: unknown) => {
      enqueued.push(data);
      return { created: true, id: 'outbox-1' };
    },
  } as Pick<NotificationRepositoryPort, 'enqueue'> as NotificationRepositoryPort;
}

function organisationRepo(organisation: OrganisationRecord | null) {
  return {
    findOrganisationById: async () => organisation,
  } as Pick<OrganisationRepositoryPort, 'findOrganisationById'> as OrganisationRepositoryPort;
}

function identityRepo(staff: StaffUserRecord[]) {
  return {
    listPharmacyStaffByOrganisationId: async () => staff,
  } as Pick<IdentityRepositoryPort, 'listPharmacyStaffByOrganisationId'> as IdentityRepositoryPort;
}

describe('pharmacy enquiry email', () => {
  it('skips a missing destination', async () => {
    const enqueued: unknown[] = [];
    const result = await queuePharmacyEnquiryEmail({
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([]),
      organisationRepo: organisationRepo(null),
      organisationId: null,
      submissionId: 'case-1',
      caseReference: 'HHH-20260902-ABCDEF12',
      event: 'assigned',
    });
    assert.equal(result.queued, 0);
    assert.equal(enqueued.length, 0);
  });

  it('skips training directory pharmacies', async () => {
    const enqueued: unknown[] = [];
    const result = await queuePharmacyEnquiryEmail({
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([owner]),
      organisationRepo: organisationRepo({
        ...eastwood,
        id: primaryId,
        name: 'Primary Branch',
        tradingName: 'Primary Pharmacy',
        status: 'LIVE',
      }),
      organisationId: primaryId,
      submissionId: 'case-1',
      caseReference: 'HHH-20260902-ABCDEF12',
      event: 'assigned',
    });
    assert.equal(result.queued, 0);
    assert.equal(enqueued.length, 0);
  });

  it('queues an assigned enquiry to the pharmacy owner without patient contact details', async () => {
    const enqueued: Array<{ templateCode: string; payload: Record<string, unknown>; idempotencyKey: string }> = [];
    const result = await queuePharmacyEnquiryEmail({
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([owner]),
      organisationRepo: organisationRepo(eastwood),
      organisationId: eastwoodId,
      submissionId: 'case-1',
      caseReference: 'HHH-20260902-ABCDEF12',
      assignmentVersion: 2,
      event: 'assigned',
    });
    assert.equal(result.queued, 1);
    assert.equal(enqueued[0]?.templateCode, 'pharmacy_new_enquiry_assigned');
    assert.equal(enqueued[0]?.payload.caseReference, 'HHH-20260902-ABCDEF12');
    assert.equal(enqueued[0]?.payload.firstName, undefined);
    assert.equal(enqueued[0]?.payload.email, undefined);
    assert.match(enqueued[0]?.idempotencyKey ?? '', /pharmacy-enquiry-assigned:case-1/);
  });

  it('queues a decline notice to the assigned pharmacy', async () => {
    const enqueued: Array<{ templateCode: string }> = [];
    const result = await queuePharmacyEnquiryEmail({
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([owner]),
      organisationRepo: organisationRepo(eastwood),
      organisationId: eastwoodId,
      submissionId: 'case-1',
      caseReference: 'HHH-20260902-ABCDEF12',
      event: 'declined',
    });
    assert.equal(result.queued, 1);
    assert.equal(enqueued[0]?.templateCode, 'pharmacy_enquiry_declined');
  });
});
