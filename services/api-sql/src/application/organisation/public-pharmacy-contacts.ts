import type { DirectoryRepositoryPort } from '../../repositories/ports/directory.port.js';
import type { PublicPharmacy } from '../../repositories/ports/organisation.port.js';

/**
 * The controller's identity and data-protection contacts live on the public directory
 * profile, while a referral token resolves against the organisation. Privacy 1.1 and
 * 1.5 promise the patient sees those contacts on the form they are applying through,
 * so the two are merged here rather than leaving the token form without them.
 *
 * A pharmacy with no profile row still resolves — the form works, the contacts are
 * simply absent, which the page renders as nothing rather than as an empty label.
 */
export async function attachPublicPharmacyContacts(
  directoryRepo: Pick<DirectoryRepositoryPort, 'findProfileByOrganisationId'>,
  pharmacy: PublicPharmacy,
): Promise<PublicPharmacy> {
  try {
    const profile = await directoryRepo.findProfileByOrganisationId(pharmacy.id);
    if (!profile) return pharmacy;
    return {
      ...pharmacy,
      icoRegistrationNumber: profile.icoRegistrationNumber,
      privacyContactEmail: profile.privacyContactEmail,
      dataProtectionOfficer: profile.dataProtectionOfficer,
      complaintsContactEmail: profile.complaintsContactEmail,
      complaintsContactPhone: profile.complaintsContactPhone,
    };
  } catch {
    // Never fail a patient's form because a profile lookup did.
    return pharmacy;
  }
}
