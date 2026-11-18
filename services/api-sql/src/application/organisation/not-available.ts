import { HttpError } from '../../domain/common/errors.js';
import { isPlatformTestOrganisation } from '../../domain/organisation/training-directory.js';
import type { OrganisationRecord, OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { ClickupHooks } from '../clickup/clickup-hooks.js';

type Subject = Pick<OrganisationRecord, 'id' | 'status' | 'archivedAt' | 'gphcNumber' | 'classification'>;

/**
 * Not available is for a pharmacy that turns out to be an existing Curaleaf customer
 * (Curaleaf tell HHH by replying to the application email). Its staff get no access,
 * its eligibility link is off, and it shows "may be available to you in the near
 * future". Only a pharmacy still awaiting Curaleaf can be marked; returns null when
 * nothing changes.
 */
export function notAvailableStatus(organisation: Subject): 'NOT_AVAILABLE' | null {
  if (organisation.status === 'NOT_AVAILABLE') return null;
  if (organisation.archivedAt) {
    throw new HttpError(409, 'A rejected pharmacy cannot be marked Not available.', 'NOT_AVAILABLE_NOT_ALLOWED');
  }
  if (isPlatformTestOrganisation(organisation)) {
    throw new HttpError(409, 'Test pharmacies stay on and cannot be marked Not available.', 'NOT_AVAILABLE_NOT_ALLOWED');
  }
  if (organisation.status !== 'ONBOARDING' && organisation.status !== 'INTAKE_LIVE') {
    throw new HttpError(
      409,
      'Only a pharmacy awaiting Curaleaf can be marked Not available. Suspend a live pharmacy instead.',
      'NOT_AVAILABLE_NOT_ALLOWED',
    );
  }
  return 'NOT_AVAILABLE';
}

/**
 * Clearing puts the pharmacy back where its Curaleaf connection says: live on
 * production credentials, otherwise awaiting Curaleaf. Returns null when the
 * pharmacy is not marked Not available.
 */
export function clearNotAvailableStatus(
  organisation: Pick<OrganisationRecord, 'status'>,
  curaleafEnvironment: 'TEST' | 'PRODUCTION' | string | null,
): 'LIVE' | 'ONBOARDING' | null {
  if (organisation.status !== 'NOT_AVAILABLE') return null;
  return curaleafEnvironment === 'PRODUCTION' ? 'LIVE' : 'ONBOARDING';
}

export type NotAvailableDeps = {
  organisations: Pick<OrganisationRepositoryPort, 'updateOrganisationStatus' | 'updateOrganisationIntakeEnabled'>;
  clickup: Pick<ClickupHooks, 'notAvailable'>;
  /** The onboarding request this branch came from, for the ClickUp card. */
  findRequestIdByOrganisation: (organisationId: string) => Promise<string | null>;
  audit: (input: { event: string; organisationId: string; details?: Record<string, unknown> }) => Promise<void>;
};

/** Marks the pharmacy Not available, turns its intake off and tells ClickUp. */
export async function markPharmacyNotAvailable(
  deps: NotAvailableDeps,
  organisation: OrganisationRecord,
  reason?: string,
): Promise<{ status: 'not_available'; changed: boolean }> {
  const next = notAvailableStatus(organisation);
  if (!next) return { status: 'not_available', changed: false };
  await deps.organisations.updateOrganisationStatus(organisation.id, next);
  if (organisation.intakeEnabled) await deps.organisations.updateOrganisationIntakeEnabled(organisation.id, false);
  await deps.audit({
    event: 'organisation.not_available',
    organisationId: organisation.id,
    details: reason ? { reason } : undefined,
  });
  const onboardingRequestId = await deps.findRequestIdByOrganisation(organisation.id).catch(() => null);
  await deps.clickup.notAvailable({ gphcNumber: organisation.gphcNumber, organisationId: organisation.id, onboardingRequestId });
  return { status: 'not_available', changed: true };
}

/** Clears Not available: access back, and the eligibility link open again (Step 1). */
export async function clearPharmacyNotAvailable(
  deps: Pick<NotAvailableDeps, 'organisations' | 'audit'>,
  organisation: OrganisationRecord,
  curaleafEnvironment: string | null,
): Promise<{ status: string; changed: boolean }> {
  const next = clearNotAvailableStatus(organisation, curaleafEnvironment);
  if (!next) return { status: organisation.status === 'INTAKE_LIVE' ? 'onboarding' : organisation.status.toLowerCase(), changed: false };
  await deps.organisations.updateOrganisationStatus(organisation.id, next);
  if (!organisation.intakeEnabled) await deps.organisations.updateOrganisationIntakeEnabled(organisation.id, true);
  await deps.audit({ event: 'organisation.not_available_cleared', organisationId: organisation.id, details: { status: next } });
  return { status: next === 'LIVE' ? 'live' : 'onboarding', changed: true };
}
