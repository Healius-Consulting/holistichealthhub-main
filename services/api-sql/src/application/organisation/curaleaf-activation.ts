import { isPlatformTestOrganisation } from '../../domain/organisation/training-directory.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { OnboardingEmails } from '../pharmacy-onboarding/onboarding-emails.js';

type Environment = 'TEST' | 'PRODUCTION' | string;

export type CuraleafActivationChange = 'went_live' | 'left_live' | null;

/**
 * A pharmacy is live exactly when its Curaleaf connection is production
 * (decided 16 Nov 2026). Saving live credentials takes it live with its
 * eligibility link on; test credentials, or none, keep it in onboarding.
 * Rejected (archived) pharmacies and the always-on Test pharmacies are left
 * as they are.
 */
export function curaleafActivationChange(
  organisation: Pick<OrganisationRecord, 'id' | 'status' | 'archivedAt' | 'gphcNumber' | 'classification'>,
  environment: Environment | null,
): CuraleafActivationChange {
  // Rejected pharmacies are archived. A suspended (PAUSED) pharmacy stays suspended
  // whatever credentials are saved: only HHH lifting the suspension brings it back.
  // Likewise a branch on hold stays so until HHH lifts the hold on its request.
  if (organisation.archivedAt || organisation.status === 'PAUSED' || organisation.status === 'ON_HOLD') return null;
  if (isPlatformTestOrganisation(organisation) || /^TRAINING-/i.test(organisation.gphcNumber ?? '')) return null;
  if (environment === 'PRODUCTION') return organisation.status === 'LIVE' ? null : 'went_live';
  return organisation.status === 'LIVE' ? 'left_live' : null;
}

export async function applyCuraleafActivation(
  repo: {
    updateOrganisationStatus(id: string, status: OrganisationRecord['status']): Promise<void>;
    updateOrganisationIntakeEnabled(id: string, enabled: boolean): Promise<void>;
  },
  organisation: OrganisationRecord,
  environment: Environment | null,
): Promise<CuraleafActivationChange> {
  const change = curaleafActivationChange(organisation, environment);
  if (change === 'went_live') {
    await repo.updateOrganisationStatus(organisation.id, 'LIVE');
    if (!organisation.intakeEnabled) await repo.updateOrganisationIntakeEnabled(organisation.id, true);
  }
  if (change === 'left_live') await repo.updateOrganisationStatus(organisation.id, 'ONBOARDING');
  return change;
}

/**
 * HHH's manual "Go live" (setup router): the same transition as live credentials, so it
 * sends the same once-only Live email. Null when the branch is already live, or is a
 * test or training pharmacy that never gets partner onboarding emails.
 */
export function manualGoLiveChange(
  organisation: Pick<OrganisationRecord, 'id' | 'status' | 'gphcNumber' | 'classification'>,
): CuraleafActivationChange {
  if (organisation.status === 'LIVE') return null;
  if (isPlatformTestOrganisation(organisation) || /^TRAINING-/i.test(organisation.gphcNumber ?? '')) return null;
  return 'went_live';
}

/**
 * The Live email goes on the transition to live only: a branch already live when its
 * credentials are saved again (or before this email existed) is never sent one.
 */
export async function sendGoLiveEmail(
  emails: Pick<OnboardingEmails, 'wentLive'>,
  organisationId: string,
  activation: CuraleafActivationChange,
) {
  if (activation !== 'went_live') return;
  try {
    await emails.wentLive({ organisationId });
  } catch (error) {
    console.error('Pharmacy go-live email failed', error instanceof Error ? error.message : 'unknown');
  }
}
