import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { normaliseGphcNumber } from '../../domain/identity/pharmsmart-sso.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import {
  readPharmsmartNamesTicket,
  signerMatchesPharmsmart,
  signerRoleIsPharmacist,
  type PartnerTermsAcceptanceInput,
  type PartnerTermsAcceptanceRecord,
} from '../../domain/pharmacy-onboarding/terms.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { queuePharmacyApplicationEmails } from './emails.js';

export type AcceptPartnerTermsDeps = {
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'findTermsAcceptances' | 'insertTermsAcceptance'>;
  notificationRepo: NotificationRepositoryPort;
  termsVersion: string;
  /** Verifies the PharmSmart names ticket the welcome page carried. */
  ticketSecret: string;
};

/**
 * The pharmacy accepts the Partner Terms against its onboarding request (no branch
 * exists yet; Activate links the row later). The same step queues the Curaleaf
 * application email. A retry finds the row already there and queues again under the
 * same idempotency keys, so nothing is sent twice and a failed queue is recovered.
 */
export async function acceptPartnerTerms(
  deps: AcceptPartnerTermsDeps,
  input: PartnerTermsAcceptanceInput,
  context: { ipHash: string | null; now?: Date },
): Promise<{ acceptance: PartnerTermsAcceptanceRecord; request: PharmacyOnboardingRequestRecord }> {
  const request = await deps.repo.findById(input.onboardingRequestId);
  if (!request) throw new HttpError(404, 'We could not find this application. Fill in the Curaleaf account form again.', 'NOT_FOUND');

  const earlier = (await deps.repo.findTermsAcceptances(request.id)).find(row => row.source === 'signup');
  if (earlier) {
    await queuePharmacyApplicationEmails(deps.notificationRepo, request, earlier.acceptedAt);
    return { acceptance: earlier, request };
  }
  if (request.status !== 'PENDING') {
    throw new HttpError(409, 'This application has already been decided, so the terms cannot be accepted here.', 'ONBOARDING_REQUEST_DECIDED');
  }

  const claims = input.pharmsmartTicket ? readPharmsmartNamesTicket(input.pharmsmartTicket, deps.ticketSecret) : null;
  const sameBranch = claims && normaliseGphcNumber(claims.gphcNumber) === normaliseGphcNumber(request.gphcNumber);
  const acceptedAt = (context.now ?? new Date()).toISOString();
  const acceptance: PartnerTermsAcceptanceRecord = {
    id: randomUUID(),
    onboardingRequestId: request.id,
    organisationId: null,
    termsVersion: deps.termsVersion,
    signerName: input.signerName.trim(),
    signerRole: input.signerRole,
    signerEmail: input.signerEmail.trim().toLowerCase(),
    signerGphcNumber: signerRoleIsPharmacist(input.signerRole)
      ? normaliseGphcNumber(input.signerGphcNumber ?? '') || null
      : null,
    registeredCompanyName: request.registeredCompanyName,
    acceptedAt,
    ipAddress: context.ipHash,
    source: 'signup',
    nameMatchesPharmsmart: sameBranch ? signerMatchesPharmsmart(input.signerName, claims.people) : null,
  };
  const { organisationId: _organisationId, ...row } = acceptance;
  await deps.repo.insertTermsAcceptance(row);
  await queuePharmacyApplicationEmails(deps.notificationRepo, request, acceptedAt);
  return { acceptance, request };
}
