import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { pharmacyIntakeDirectoryAccess } from '../organisation/access.js';

/** Website picker destination. Missing or sandbox pharmacies fail closed instead of creating an unassigned case. */
export function resolveWebsiteAssignedPharmacy(organisation: OrganisationRecord | null | undefined) {
  if (!organisation || !pharmacyIntakeDirectoryAccess(organisation)) return null;
  return organisation;
}
