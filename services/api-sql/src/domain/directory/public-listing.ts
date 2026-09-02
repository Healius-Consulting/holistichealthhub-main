import { isPlatformTestOrganisation } from '../organisation/training-directory.js';

export const HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL = 'Holistic Health Hub Allocation';

export type PublicListingOrganisation = {
  id: string;
  name: string;
  tradingName: string;
  classification: 'STANDARD' | 'TRAINING' | 'ALLOCATION_HOLDING';
  status: 'ONBOARDING' | 'INTAKE_LIVE' | 'LIVE' | 'PAUSED';
  archivedAt?: string | null;
};

export function isHiddenPublicPharmacy(organisation: PublicListingOrganisation): boolean {
  if (organisation.classification === 'ALLOCATION_HOLDING') return true;
  return isPlatformTestOrganisation(organisation);
}

export function isPubliclyListedPharmacy(organisation: PublicListingOrganisation): boolean {
  if (organisation.archivedAt) return false;
  if (organisation.status === 'PAUSED') return false;
  if (!['ONBOARDING', 'INTAKE_LIVE', 'LIVE'].includes(organisation.status)) return false;
  if (organisation.classification !== 'STANDARD') return false;
  return !isHiddenPublicPharmacy(organisation);
}
