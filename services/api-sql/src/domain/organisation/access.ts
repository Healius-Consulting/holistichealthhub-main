import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { isTrainingDirectoryOrganisation } from './training-directory.js';

export type PharmacyWorkspaceMode = 'training' | 'test' | 'live' | 'paused';

function isTrainingGphc(organisation: Pick<OrganisationRecord, 'gphcNumber'>): boolean {
  return /^TRAINING-[A-Z0-9_-]+$/i.test(organisation.gphcNumber ?? '');
}

/** Public eligibility token and HHH intake queue — independent of pharmacy operational access. */
export function canAcceptPublicIntake(organisation: OrganisationRecord | null | undefined): boolean {
  if (!organisation || organisation.archivedAt) return false;
  if (isTrainingDirectoryOrganisation(organisation)) return false;
  if (!organisation.intakeEnabled) return false;
  if (organisation.status === 'PAUSED') return false;
  if (isTrainingGphc(organisation)) return organisation.status === 'LIVE';
  return organisation.status === 'ONBOARDING' || organisation.status === 'INTAKE_LIVE' || organisation.status === 'LIVE';
}

/** HHH may attribute and review enquiries for any pharmacy whose public token is live. */
export function canReceiveReferral(organisation: OrganisationRecord | null | undefined): boolean {
  return canAcceptPublicIntake(organisation);
}

/** Pharmacy CRM, orders, and writes. Dummy directory pharmacies stay false. Test and Live both qualify once flipped. Paused keeps existing records. */
export function pharmacyOperationalAccess(organisation: OrganisationRecord | null | undefined): boolean {
  return Boolean(
    organisation
    && !organisation.archivedAt
    && !isTrainingDirectoryOrganisation(organisation)
    && (organisation.status === 'LIVE' || organisation.status === 'PAUSED'),
  );
}

/** Pending enquiries and referred patient records — not orders. Training sandboxes never qualify. */
export function pharmacyIntakeDirectoryAccess(organisation: OrganisationRecord | null | undefined): boolean {
  return Boolean(organisation) && canReceiveReferral(organisation) && !isTrainingDirectoryOrganisation(organisation);
}

/** Which pharmacy portal collections this tenant may load. Orders stay live-only. */
export function pharmacyPortalRecordAccess(organisation: OrganisationRecord | null | undefined) {
  const operational = pharmacyOperationalAccess(organisation);
  const intakeDirectory = pharmacyIntakeDirectoryAccess(organisation);
  return {
    patients: !isTrainingDirectoryOrganisation(organisation) && (operational || intakeDirectory),
    orders: operational,
    pendingEnquiries: intakeDirectory,
  };
}

/** HHH may activate a referred patient on any intake-eligible destination, including onboarding. Orders stay live-only. */
export function canActivateReferredPatient(organisation: OrganisationRecord | null | undefined): boolean {
  return pharmacyIntakeDirectoryAccess(organisation);
}

export function pharmacyWorkspaceMode(
  organisation: OrganisationRecord | null | undefined,
  extras?: { curaleafProduction?: boolean },
): PharmacyWorkspaceMode {
  if (!organisation || organisation.archivedAt || organisation.status === 'PAUSED') return 'paused';
  if (isTrainingDirectoryOrganisation(organisation)) return 'training';
  const flipped = organisation.status === 'LIVE' || organisation.classification === 'ALLOCATION_HOLDING';
  if (!flipped) return 'training';
  if (extras?.curaleafProduction === true) return 'live';
  return 'test';
}
