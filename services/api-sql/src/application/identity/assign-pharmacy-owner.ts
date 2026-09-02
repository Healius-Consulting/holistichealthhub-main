import { HttpError } from '../../domain/common/errors.js';
import type { StaffUserRecord } from '../../repositories/ports/identity.port.js';

export function assertStaffCanBePharmacyOwner(
  profile: StaffUserRecord | null,
): asserts profile is StaffUserRecord & { organisationId: string } {
  if (!profile || profile.role !== 'PHARMACY_STAFF' || !profile.organisationId) {
    throw new HttpError(404, 'Staff account not found.', 'STAFF_NOT_FOUND');
  }
  if (profile.status === 'REMOVED' || profile.disabled) {
    throw new HttpError(409, 'Choose an invited or active staff account.', 'STAFF_NOT_ASSIGNABLE');
  }
}
