import { HttpError } from '../../domain/common/errors.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';

export type DeclinePharmacyDeps = {
  findOrganisation(id: string): Promise<OrganisationRecord | null>;
  findRequestByOrganisation(organisationId: string): Promise<PharmacyOnboardingRequestRecord | null>;
  archiveOrganisation(id: string, reason: string, archivedAt: string): Promise<void>;
  declineRequest(id: string, reason: string, decidedAt: string, actorUid: string): Promise<void>;
  emailPharmacy(input: { email: string; pharmacyName: string; reason: string; key: string }): Promise<void>;
};

/**
 * Decline a pharmacy that joined from the onboarding page, for example when
 * Curaleaf rejects the account. It is archived, not deleted: it leaves the
 * overview, its staff lose access, and its records stay for audit. A live
 * pharmacy is never declined here; pause it instead.
 */
export async function declineNewPharmacy(
  deps: DeclinePharmacyDeps,
  input: { organisationId: string; reason: string; actorUid: string; now?: Date },
) {
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) {
    throw new HttpError(400, 'Enter a reason the pharmacy can read.', 'INVALID_INPUT');
  }
  const organisation = await deps.findOrganisation(input.organisationId);
  if (!organisation || organisation.archivedAt) throw new HttpError(404, 'Pharmacy not found.', 'NOT_FOUND');
  if (organisation.status === 'LIVE') {
    throw new HttpError(409, 'This pharmacy is live. Pause it instead of declining it.', 'PHARMACY_LIVE');
  }
  const now = (input.now ?? new Date()).toISOString();
  const request = await deps.findRequestByOrganisation(organisation.id);
  await deps.archiveOrganisation(organisation.id, reason, now);
  if (request) await deps.declineRequest(request.id, reason, now, input.actorUid);
  const email = request?.pharmacyEmail || organisation.pharmacyEmail || organisation.mainContactEmail;
  if (email) {
    await deps.emailPharmacy({
      email,
      pharmacyName: request?.pharmacyName || organisation.name,
      reason,
      key: request?.id ?? organisation.id,
    });
  }
  return { organisationId: organisation.id, requestId: request?.id ?? null, declinedAt: now };
}
