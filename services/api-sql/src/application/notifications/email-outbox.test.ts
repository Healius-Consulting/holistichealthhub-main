import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { pharmacyOwnerRecipients } from './email-outbox.js';

const organisationId = '70913a30-71c3-4a41-952e-d532927af58c';

const owner: StaffUserRecord = {
  uid: 'owner-uid',
  organisationId,
  email: 'owner@example.test',
  displayName: 'Alex Owner',
  role: 'PHARMACY_STAFF',
  status: 'ACTIVE',
  disabled: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  version: 1,
};

const staffMember: StaffUserRecord = {
  uid: 'staff-uid',
  organisationId,
  email: 'staff@example.test',
  displayName: 'Sam Staff',
  role: 'PHARMACY_STAFF',
  status: 'ACTIVE',
  disabled: false,
  createdAt: '2026-01-02T10:00:00.000Z',
  version: 1,
};

const organisation = {
  mainContactEmail: 'desk@example.test',
  mainContactName: 'Pharmacy desk',
} as OrganisationRecord;

describe('pharmacy operational email recipients', () => {
  it('uses the pharmacy inbox ahead of any staff login', () => {
    assert.deepEqual(pharmacyOwnerRecipients([staffMember, owner], {
      ...organisation,
      pharmacyEmail: 'pharmacy@eastwood.test',
      primaryContactUid: staffMember.uid,
    }), [
      { email: 'pharmacy@eastwood.test', displayName: null },
    ]);
  });

  it('uses the superintendent when the pharmacy inbox is blank', () => {
    assert.deepEqual(pharmacyOwnerRecipients([owner], organisation), [
      { email: 'desk@example.test', displayName: 'Pharmacy desk' },
    ]);
  });
});
