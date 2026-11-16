import { isPlatformTestOrganisation } from '../../domain/organisation/training-directory.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';

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
  // Rejected pharmacies are archived. There is no suspended state any more, so an
  // old PAUSED pharmacy is treated like one awaiting Curaleaf.
  if (organisation.archivedAt) return null;
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
