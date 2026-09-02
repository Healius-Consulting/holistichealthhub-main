import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { isHiddenPublicPharmacy } from '../directory/public-listing.js';
import { pharmacyIntakeDirectoryAccess } from '../organisation/access.js';

/** Website picker destination. Hidden and unlisted pharmacies fail closed instead of creating an unassigned case. */
export function resolveWebsiteAssignedPharmacy(organisation: OrganisationRecord | null | undefined) {
  if (!organisation || !pharmacyIntakeDirectoryAccess(organisation)) return null;
  if (isHiddenPublicPharmacy(organisation)) return null;
  return organisation;
}
