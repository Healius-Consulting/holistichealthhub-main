import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { StaffUserRecord } from '../../repositories/ports/identity.port.js';
import { assertStaffCanBePharmacyOwner } from './assign-pharmacy-owner.js';

const staff: StaffUserRecord = {
  uid: 'staff-uid',
  organisationId: '70913a3071c34a41952ed532927af58c',
  email: 'owner@example.test',
  displayName: 'Alex Owner',
  role: 'PHARMACY_STAFF',
  status: 'INVITED',
  disabled: false,
  createdAt: '2026-01-02T10:00:00.000Z',
  version: 1,
};

describe('assertStaffCanBePharmacyOwner', () => {
  it('allows invited and active pharmacy staff', () => {
    assert.doesNotThrow(() => assertStaffCanBePharmacyOwner(staff));
    assert.doesNotThrow(() => assertStaffCanBePharmacyOwner({ ...staff, status: 'ACTIVE' }));
  });

  it('rejects missing, admin, removed, and disabled accounts', () => {
    for (const profile of [
      null,
      { ...staff, role: 'HHH_ADMIN' as const, organisationId: null },
      { ...staff, status: 'REMOVED' as const },
      { ...staff, disabled: true },
    ]) {
      assert.throws(() => assertStaffCanBePharmacyOwner(profile), HttpError);
    }
  });
});
