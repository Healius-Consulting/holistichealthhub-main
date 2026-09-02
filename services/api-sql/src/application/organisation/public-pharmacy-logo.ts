import { resolveOrganisationLogo } from './brand-logo.js';
import type { StorageProvider } from '../../providers/storage/storage.provider.js';

export const PUBLIC_PHARMACY_LOGO_TTL_SECONDS = 6 * 60 * 60;

export async function attachPublicPharmacyLogo<T extends { id: string }>(
  storage: Pick<StorageProvider, 'listPaths' | 'generateDownloadUrl'>,
  pharmacy: T,
): Promise<T & { logoUrl: string | null }> {
  try {
    const logo = await resolveOrganisationLogo(storage, pharmacy.id, PUBLIC_PHARMACY_LOGO_TTL_SECONDS);
    return { ...pharmacy, logoUrl: logo.emailLogoUrl };
  } catch {
    return { ...pharmacy, logoUrl: null };
  }
}
