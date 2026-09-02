import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { isPlatformTestOrganisation } from './training-directory.js';

export type PharmacyWorkspaceMode = 'training' | 'test' | 'live' | 'paused';

function isTrainingGphc(organisation: Pick<OrganisationRecord, 'gphcNumber'>): boolean {
  return /^TRAINING-[A-Z0-9_-]+$/i.test(organisation.gphcNumber ?? '');
}

/** Public eligibility token and HHH intake queue — independent of pharmacy operational access. */
export function canAcceptPublicIntake(organisation: OrganisationRecord | null | undefined): boolean {
  if (!organisation || organisation.archivedAt) return false;
  if (!organisation.intakeEnabled) return false;
  if (organisation.status === 'PAUSED') return false;
  if (isPlatformTestOrganisation(organisation)) return true;
  if (isTrainingGphc(organisation)) return organisation.status === 'LIVE';
  return organisation.status === 'ONBOARDING' || organisation.status === 'INTAKE_LIVE' || organisation.status === 'LIVE';
}

/** HHH may attribute and review enquiries for any pharmacy whose public token is live. */
export function canReceiveReferral(organisation: OrganisationRecord | null | undefined): boolean {
  return canAcceptPublicIntake(organisation);
}

/** Pharmacy CRM, orders, and writes. Platform Test pharmacies are live under Test without a go-live flip. Paused keeps existing records. */
export function pharmacyOperationalAccess(organisation: OrganisationRecord | null | undefined): boolean {
  if (!organisation || organisation.archivedAt) return false;
  if (isPlatformTestOrganisation(organisation)) return true;
  return organisation.status === 'LIVE' || organisation.status === 'PAUSED';
}

/** Pending enquiries and referred patient records — not orders. */
export function pharmacyIntakeDirectoryAccess(organisation: OrganisationRecord | null | undefined): boolean {
  return canReceiveReferral(organisation);
}

/** Which pharmacy portal collections this tenant may load. */
export function pharmacyPortalRecordAccess(organisation: OrganisationRecord | null | undefined) {
  const operational = pharmacyOperationalAccess(organisation);
  const intakeDirectory = pharmacyIntakeDirectoryAccess(organisation);
  return {
    patients: operational || intakeDirectory,
    orders: operational,
    pendingEnquiries: intakeDirectory,
  };
}

/** HHH may activate a referred patient on any intake-eligible destination, including onboarding. */
export function canActivateReferredPatient(organisation: OrganisationRecord | null | undefined): boolean {
  return pharmacyIntakeDirectoryAccess(organisation);
}

export function pharmacyWorkspaceMode(
  organisation: OrganisationRecord | null | undefined,
  extras?: { curaleafProduction?: boolean },
): PharmacyWorkspaceMode {
  if (!organisation || organisation.archivedAt || organisation.status === 'PAUSED') return 'paused';
  if (isPlatformTestOrganisation(organisation)) {
    return extras?.curaleafProduction === true ? 'live' : 'test';
  }
  const flipped = organisation.status === 'LIVE' || organisation.classification === 'ALLOCATION_HOLDING';
  if (!flipped) return 'training';
  if (extras?.curaleafProduction === true) return 'live';
  return 'test';
}
