import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IdentityRepositoryPort, StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRecord, OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import { dispatchEmailEvent } from './email-dispatch.js';

const eastwoodId = '6d0176bb-89a0-4e32-9bce-c934c9557c42';

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

const admin: StaffUserRecord = {
  uid: 'admin-uid',
  organisationId: null,
  email: 'admin@hhh.test',
  displayName: 'Jordan Lee',
  role: 'HHH_ADMIN',
  status: 'ACTIVE',
  disabled: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  version: 1,
};

function notificationRepo(enqueued: Array<Record<string, unknown>>) {
  return {
    enqueue: async (data: Record<string, unknown>) => {
      enqueued.push(data);
      return { created: true, id: `outbox-${enqueued.length}` };
    },
  } as Pick<NotificationRepositoryPort, 'enqueue'> as NotificationRepositoryPort;
}

function organisationRepo(organisation: OrganisationRecord | null) {
  return {
    findOrganisationById: async () => organisation,
  } as Pick<OrganisationRepositoryPort, 'findOrganisationById'> as OrganisationRepositoryPort;
}

function identityRepo(staff: StaffUserRecord[], admins: StaffUserRecord[] = []) {
  return {
    listPharmacyStaffByOrganisationId: async () => staff,
    listPlatformAdmins: async () => admins,
  } as Pick<IdentityRepositoryPort, 'listPharmacyStaffByOrganisationId' | 'listPlatformAdmins'> as IdentityRepositoryPort;
}

describe('dispatchEmailEvent', () => {
  it('queues admin and owner mail for an assigned enquiry', async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const result = await dispatchEmailEvent('enquiry.submitted', {
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([owner], [admin]),
      organisationRepo: organisationRepo(eastwood),
      organisationId: eastwoodId,
      mails: {
        admin_new_enquiry_received: {
          payload: { firstName: 'Avery', email: 'avery@example.com', caseReference: 'HHH-1' },
          keyParts: ['admin-enquiry', 'case-1'],
        },
        pharmacy_new_enquiry_assigned: {
          payload: { caseReference: 'HHH-1', pharmacyName: 'Eastwood Health Ltd' },
          keyParts: ['pharmacy-enquiry-assigned', 'case-1', eastwoodId, 1],
        },
      },
    });
    assert.equal(result.queued, 2);
    assert.equal(enqueued.length, 2);
    assert.equal(enqueued[0]?.templateCode, 'admin_new_enquiry_received');
    assert.equal(enqueued[0]?.encryptedRecipient, 'admin@hhh.test');
    assert.equal(enqueued[1]?.templateCode, 'pharmacy_new_enquiry_assigned');
    assert.equal(enqueued[1]?.encryptedRecipient, 'owner@eastwood.test');
    assert.equal((enqueued[1]?.payload as { email?: string }).email, undefined);
  });

  it('queues only admin mail when no pharmacy is assigned', async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const result = await dispatchEmailEvent('enquiry.submitted', {
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([], [admin]),
      organisationRepo: organisationRepo(null),
      mails: {
        admin_new_enquiry_received: {
          payload: { firstName: 'Avery', caseReference: 'HHH-1' },
          keyParts: ['admin-enquiry', 'case-1'],
        },
      },
    });
    assert.equal(result.queued, 1);
    assert.equal(enqueued[0]?.templateCode, 'admin_new_enquiry_received');
  });

  it('queues patient and owner mail when a referral is activated', async () => {
    const enqueued: Array<Record<string, unknown>> = [];
    const result = await dispatchEmailEvent('referral.activated', {
      notificationRepo: notificationRepo(enqueued),
      identityRepo: identityRepo([owner], [admin]),
      organisationRepo: organisationRepo(eastwood),
      organisationId: eastwoodId,
      patientId: 'patient-1',
      mails: {
        pharmacy_new_patient_referred: {
          payload: { caseReference: 'case-1', pharmacyName: 'Eastwood Health Ltd' },
          keyParts: ['pharmacy-referred', 'case-1', eastwoodId],
        },
        patient_referred: {
          to: { email: 'avery@example.com', displayName: 'Avery' },
          payload: { firstName: 'Avery', pharmacyName: 'Eastwood Health Ltd' },
          keyParts: ['patient-referred', 'case-1', eastwoodId],
        },
      },
    });
    assert.equal(result.queued, 2);
    const codes = enqueued.map(row => row.templateCode).sort();
    assert.deepEqual(codes, ['patient_referred', 'pharmacy_new_patient_referred']);
  });

  it('holds collection mail after 15:00 Europe/London', async () => {
    const enqueued: Array<{ nextAttemptAt?: string | null }> = [];
    const afterCutoff = new Date('2026-09-03T15:05:00.000Z');
    await dispatchEmailEvent('collection.ready', {
      notificationRepo: notificationRepo(enqueued),
      organisationId: eastwoodId,
      patientId: 'patient-1',
      orderId: 'order-1',
      now: afterCutoff,
      to: { email: 'avery@example.com', displayName: 'Avery' },
      payload: { firstName: 'Avery', orderNumber: 'ORD-1' },
      keyParts: ['patient-ready-for-collection', 'order-1', 'shipment:abc'],
    });
    assert.equal(enqueued.length, 1);
    assert.ok(enqueued[0]?.nextAttemptAt);
    assert.ok(new Date(String(enqueued[0]?.nextAttemptAt)).getTime() > afterCutoff.getTime());
  });
});
