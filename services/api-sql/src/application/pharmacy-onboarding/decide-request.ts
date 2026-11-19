import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { normaliseGphcNumber } from '../../domain/identity/pharmsmart-sso.js';
import { isOnboardingHoldReason, onboardingLogoText, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import type { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import type { OrganisationRecord, OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';

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
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'listOrganisationGphcNumbers' | 'activate' | 'linkTermsAcceptances'> & { linkWorldpayApplications?: (requestId: string, organisationId: string) => Promise<void> },
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
    // Eligibility opens at Activate, while the pharmacy awaits Curaleaf. Patients
    // are accepted and wait in its list; ordering and payment stay shut until Live.
    intakeEnabled: true,
  });
  const referral = await referralLinks.ensureEligibilityLink({ organisationId: id, createdByUid: input.actorUid });
  await repo.activate(request.id, id, now.toISOString(), input.actorUid);
  // The Partner Terms were accepted against the request; they now belong to the branch too.
  await repo.linkTermsAcceptances(request.id, id);
  // So does a Worldpay application started on the onboarding page.
  await repo.linkWorldpayApplications?.(request.id, id);
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

export type HoldDeps = {
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'hold'>;
  organisations: Pick<OrganisationRepositoryPort, 'findOrganisationById' | 'updateOrganisationStatus' | 'updateOrganisationIntakeEnabled'>;
  /** Signs the branch's staff out. They see the hold message when they come back. */
  revokeSessions: (organisationId: string, revokedAt: string) => Promise<void>;
};

export type HoldResult = {
  request: PharmacyOnboardingRequestRecord;
  /** The reason before this change, when the request was already on hold. */
  previousReason: OnboardingHoldReason | null;
  /** The branch closed by this hold, when the request was activated. */
  organisationId: string | null;
};

/** A branch can be held only before it goes live; a live or suspended one is not. */
const HOLDABLE_BRANCH = new Set<OrganisationRecord['status']>(['ONBOARDING', 'INTAKE_LIVE', 'ON_HOLD']);

/**
 * Puts a request on hold with one of the fixed reasons, or changes the reason of a
 * hold already in place. A pending request just changes status. An activated branch
 * that is not live yet is closed too: status ON_HOLD, intake off, its staff signed out.
 * The pharmacy is told the reason (the caller sends the Hold email).
 */
export async function holdPharmacyOnboardingRequest(
  deps: HoldDeps,
  input: { id: string; reason: OnboardingHoldReason; actorUid: string; now?: Date },
): Promise<HoldResult> {
  if (!isOnboardingHoldReason(input.reason)) {
    throw new HttpError(400, 'Choose a reason for the hold.', 'INVALID_INPUT');
  }
  const request = await deps.repo.findById(input.id);
  if (!request) throw new HttpError(404, 'Pharmacy request not found.', 'NOT_FOUND');
  if (request.status === 'ON_HOLD' && request.holdReason === input.reason) {
    throw new HttpError(409, 'This pharmacy request is already on hold for that reason.', 'ONBOARDING_REQUEST_ALREADY_ON_HOLD');
  }

  const heldAt = (input.now ?? new Date()).toISOString();
  let organisationId: string | null = null;
  if (request.organisationId) {
    const organisation = await deps.organisations.findOrganisationById(request.organisationId);
    if (!organisation || organisation.archivedAt) {
      throw new HttpError(409, 'This pharmacy request\'s branch could not be found.', 'ONBOARDING_BRANCH_MISSING');
    }
    if (!HOLDABLE_BRANCH.has(organisation.status)) {
      throw new HttpError(
        409,
        'This pharmacy is already live. Only a pharmacy that is not live yet can be put on hold; suspend a live pharmacy instead.',
        'ONBOARDING_BRANCH_LIVE',
      );
    }
    // The branch first: if the request update then fails, a retry still finds it holdable.
    if (organisation.status !== 'ON_HOLD') await deps.organisations.updateOrganisationStatus(organisation.id, 'ON_HOLD');
    if (organisation.intakeEnabled) await deps.organisations.updateOrganisationIntakeEnabled(organisation.id, false);
    await deps.revokeSessions(organisation.id, heldAt);
    organisationId = organisation.id;
  } else if (request.status !== 'PENDING' && request.status !== 'ON_HOLD') {
    throw new HttpError(409, 'This pharmacy request cannot be put on hold.', 'ONBOARDING_REQUEST_DECIDED');
  }

  await deps.repo.hold(request.id, input.reason, heldAt, input.actorUid);
  return {
    request: { ...request, status: 'ON_HOLD', holdReason: input.reason, heldAt, decidedAt: heldAt, decidedByUid: input.actorUid },
    previousReason: request.status === 'ON_HOLD' ? request.holdReason : null,
    organisationId,
  };
}

export type UnholdDeps = {
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'unhold'>;
  organisations: Pick<OrganisationRepositoryPort, 'findOrganisationById' | 'updateOrganisationStatus' | 'updateOrganisationIntakeEnabled'>;
};

/**
 * Lifts a hold: back to PENDING, or to ACTIVATED when the request already has a branch,
 * whose status goes back to ONBOARDING (awaiting Curaleaf, demo) with intake on.
 * No email; the reason is kept as history. Signed-out staff sign in again.
 */
export async function unholdPharmacyOnboardingRequest(
  deps: UnholdDeps,
  input: { id: string },
): Promise<PharmacyOnboardingRequestRecord> {
  const request = await deps.repo.findById(input.id);
  if (!request) throw new HttpError(404, 'Pharmacy request not found.', 'NOT_FOUND');
  const organisation = request.organisationId ? await deps.organisations.findOrganisationById(request.organisationId) : null;
  // A branch can be ON_HOLD with its request still ACTIVATED if a hold failed half-way (branch updated first).
  const branchHeld = organisation?.status === 'ON_HOLD';
  if (request.status !== 'ON_HOLD' && !branchHeld) {
    throw new HttpError(409, 'Only a request on hold can be unheld.', 'ONBOARDING_REQUEST_NOT_ON_HOLD');
  }
  // The branch first: if the request update then fails, a retry still finds the request on hold.
  if (organisation && branchHeld) {
    await deps.organisations.updateOrganisationStatus(organisation.id, 'ONBOARDING');
    if (!organisation.intakeEnabled) await deps.organisations.updateOrganisationIntakeEnabled(organisation.id, true);
  }
  const status = request.organisationId ? 'ACTIVATED' : 'PENDING';
  if (request.status !== status) await deps.repo.unhold(request.id, status);
  return { ...request, status };
}

async function requirePending(
  repo: { findById(id: string): Promise<PharmacyOnboardingRequestRecord | null> },
  id: string,
) {
  const request = await repo.findById(id);
  if (!request) throw new HttpError(404, 'Pharmacy request not found.', 'NOT_FOUND');
  if (request.status === 'ON_HOLD') {
    throw new HttpError(409, 'This pharmacy request is on hold. Unhold it first.', 'ONBOARDING_REQUEST_ON_HOLD');
  }
  if (request.status !== 'PENDING') {
    throw new HttpError(409, 'This pharmacy request has already been activated.', 'ONBOARDING_REQUEST_DECIDED');
  }
  return request;
}
