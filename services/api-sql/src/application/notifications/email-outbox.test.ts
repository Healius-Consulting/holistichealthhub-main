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
  it('uses an assigned owner instead of invite order', () => {
    assert.deepEqual(pharmacyOwnerRecipients([staffMember, owner], {
      ...organisation,
      primaryContactUid: staffMember.uid,
    }), [
      { email: 'staff@example.test', displayName: 'Sam Staff' },
    ]);
  });

  it('falls back to the pharmacy contact when there is no owner account', () => {
    assert.deepEqual(pharmacyOwnerRecipients([], organisation), [
      { email: 'desk@example.test', displayName: 'Pharmacy desk' },
    ]);
  });

  it('skips a removed owner instead of emailing other staff', () => {
    assert.deepEqual(pharmacyOwnerRecipients([
      { ...owner, status: 'REMOVED', disabled: true },
      staffMember,
    ], organisation), [
      { email: 'desk@example.test', displayName: 'Pharmacy desk' },
    ]);
  });
});
