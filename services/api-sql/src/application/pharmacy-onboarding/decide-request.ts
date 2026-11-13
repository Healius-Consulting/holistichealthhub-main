import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { normaliseGphcNumber } from '../../domain/identity/pharmsmart-sso.js';
import { onboardingLogoText, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';

const DEFAULT_PRIMARY = '#0f766e';

type ReferralLinks = {
  ensureEligibilityLink(params: { organisationId: string; createdByUid?: string | null }): Promise<{ token: string }>;
};

export type ActivatedPharmacy = {
  id: string;
  referralToken: string;
  name: string;
  tradingName: string;
  logoText: string;
  gphcNumber: string;
  superintendent: string;
  mainContactName: string;
  mainContactPhone: string;
  mainContactEmail: string;
  pharmacyPhone: string;
  pharmacyEmail: string;
  address: string;
  primaryColour: string;
};

export async function activatePharmacyOnboardingRequest(
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'listOrganisationGphcNumbers' | 'activate'>,
  organisations: Pick<OrganisationRepositoryPort, 'createOrganisation'>,
  referralLinks: ReferralLinks,
  input: { id: string; actorUid: string; now?: Date },
): Promise<{ requestId: string; organisation: ActivatedPharmacy }> {
  const request = await requirePending(repo, input.id);
  const gphcNumber = normaliseGphcNumber(request.gphcNumber) ?? request.gphcNumber;
  const taken = (await repo.listOrganisationGphcNumbers())
    .some(organisation => normaliseGphcNumber(organisation.gphcNumber) === gphcNumber);
  if (taken) {
    throw new HttpError(409, 'This GPhC number already belongs to a pharmacy.', 'GPHC_ALREADY_ON_PLATFORM');
  }

  const now = input.now ?? new Date();
  const id = randomUUID();
  const logoText = onboardingLogoText(request.pharmacyName);
  await organisations.createOrganisation({
    id,
    name: request.pharmacyName,
    tradingName: request.registeredCompanyName,
    gphcNumber: request.gphcNumber,
    superintendentName: request.pharmacistName,
    mainContactName: request.pharmacistName,
    mainContactPhone: request.pharmacyPhone,
    mainContactEmail: request.pharmacyEmail,
    pharmacyPhone: request.pharmacyPhone,
    pharmacyEmail: request.pharmacyEmail,
    address: request.invoiceAddress,
    primaryColour: DEFAULT_PRIMARY,
    logoText,
    portalName: request.pharmacyName,
  });
  const referral = await referralLinks.ensureEligibilityLink({ organisationId: id, createdByUid: input.actorUid });
  await repo.activate(request.id, id, now.toISOString(), input.actorUid);
  return {
    requestId: request.id,
    organisation: {
      id,
      referralToken: referral.token,
      name: request.pharmacyName,
      tradingName: request.registeredCompanyName,
      logoText,
      gphcNumber: request.gphcNumber,
      superintendent: request.pharmacistName,
      mainContactName: request.pharmacistName,
      mainContactPhone: request.pharmacyPhone,
      mainContactEmail: request.pharmacyEmail,
      pharmacyPhone: request.pharmacyPhone,
      pharmacyEmail: request.pharmacyEmail,
      address: request.invoiceAddress,
      primaryColour: DEFAULT_PRIMARY,
    },
  };
}

export async function declinePharmacyOnboardingRequest(
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'decline'>,
  input: { id: string; reason: string; actorUid: string; now?: Date },
): Promise<PharmacyOnboardingRequestRecord> {
  const request = await requirePending(repo, input.id);
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) {
    throw new HttpError(400, 'Enter a reason the pharmacy can read.', 'INVALID_INPUT');
  }
  const now = input.now ?? new Date();
  await repo.decline(request.id, reason, now.toISOString(), input.actorUid);
  return { ...request, status: 'DECLINED', declineReason: reason, decidedAt: now.toISOString(), decidedByUid: input.actorUid };
}

async function requirePending(
  repo: { findById(id: string): Promise<PharmacyOnboardingRequestRecord | null> },
  id: string,
) {
  const request = await repo.findById(id);
  if (!request) throw new HttpError(404, 'Pharmacy request not found.', 'NOT_FOUND');
  if (request.status !== 'PENDING') {
    throw new HttpError(409, 'This pharmacy request has already been decided.', 'ONBOARDING_REQUEST_DECIDED');
  }
  return request;
}
