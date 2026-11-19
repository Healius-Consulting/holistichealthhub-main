import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { normaliseGphcNumber } from '../../domain/identity/pharmsmart-sso.js';
import { compactGphcNumber, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import {
  signerRoleIsPharmacist,
  type BranchPartnerTermsAcceptanceInput,
  type PartnerTermsAcceptanceRecord,
} from '../../domain/pharmacy-onboarding/terms.js';
import type { WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';

/**
 * The pharmacy portal's Onboarding page, for a branch HHH has activated. It looks the
 * branch's onboarding request, Partner Terms and Worldpay note up by the branch id
 * first, then by its GPhC, because older branches and public-page pharmacies may have
 * any of these missing.
 */
export type BranchOnboardingRepo = {
  findByOrganisationId(organisationId: string): Promise<PharmacyOnboardingRequestRecord | null>;
  findTermsAcceptances(onboardingRequestId: string): Promise<PartnerTermsAcceptanceRecord[]>;
  findTermsAcceptancesForOrganisation(organisationId: string): Promise<PartnerTermsAcceptanceRecord[]>;
  hasAcceptedTermsForGphc(gphcNumber: string): Promise<boolean>;
  findWorldpaySubmissionForBranch(organisationId: string, gphcNumber: string): Promise<WorldpaySubmissionNote | null>;
  insertTermsAcceptance(record: Omit<PartnerTermsAcceptanceRecord, 'organisationId'> & { organisationId?: string | null }): Promise<void>;
};

type Branch = Pick<OrganisationRecord, 'id' | 'status' | 'gphcNumber' | 'name' | 'tradingName'>;

export type BranchOnboardingView = {
  /** Awaiting Curaleaf until the branch goes live; only admin moves it on. */
  live: boolean;
  /** When the onboarding forms were submitted. Null for a branch HHH added by hand. */
  submittedAt: string | null;
  /** Whether the Partner Terms are in; the portal offers them before Worldpay when not. */
  termsAccepted: boolean;
  termsAcceptedAt: string | null;
  worldpaySubmittedAt: string | null;
  /** For the Terms declaration: "on behalf of [registered company name]". */
  registeredCompanyName: string;
};

function branchGphc(branch: Branch) {
  return compactGphcNumber(branch.gphcNumber) ?? branch.gphcNumber.trim();
}

function registeredCompany(branch: Branch, request: PharmacyOnboardingRequestRecord | null) {
  return request?.registeredCompanyName || branch.tradingName || branch.name;
}

/** Newest acceptance for the branch, whether it was linked at Activate or accepted from the portal. */
async function latestAcceptance(repo: BranchOnboardingRepo, branch: Branch, request: PharmacyOnboardingRequestRecord | null) {
  const rows = [
    ...(await repo.findTermsAcceptancesForOrganisation(branch.id)),
    ...(request ? await repo.findTermsAcceptances(request.id) : []),
  ].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  return rows[0] ?? null;
}

export async function branchOnboardingView(repo: BranchOnboardingRepo, branch: Branch): Promise<BranchOnboardingView> {
  const request = await repo.findByOrganisationId(branch.id);
  const [acceptance, worldpay] = await Promise.all([
    latestAcceptance(repo, branch, request),
    repo.findWorldpaySubmissionForBranch(branch.id, branchGphc(branch)),
  ]);
  // An acceptance on another request for the same GPhC also opens Worldpay (as the server checks it).
  const termsAccepted = Boolean(acceptance) || await repo.hasAcceptedTermsForGphc(branchGphc(branch));
  return {
    live: branch.status === 'LIVE',
    submittedAt: request?.createdAt ?? null,
    termsAccepted,
    termsAcceptedAt: acceptance?.acceptedAt ?? null,
    worldpaySubmittedAt: worldpay?.submittedAt ?? null,
    registeredCompanyName: registeredCompany(branch, request),
  };
}

/**
 * An activated branch that never accepted the Partner Terms (an older branch, or a
 * public-page pharmacy that left before them) accepts them here, so its Worldpay form
 * is no longer refused. The row carries the branch id, and its onboarding request when
 * there is one. A repeat returns the acceptance already there. Nothing is emailed: the
 * branch is already activated, so HHH sends Curaleaf anything still needed by hand.
 */
export async function acceptBranchPartnerTerms(
  deps: { repo: BranchOnboardingRepo; termsVersion: string },
  branch: Branch,
  input: BranchPartnerTermsAcceptanceInput,
  context: { ipHash: string | null; now?: Date },
): Promise<{ acceptance: PartnerTermsAcceptanceRecord; created: boolean }> {
  if (branch.status !== 'ONBOARDING' && branch.status !== 'INTAKE_LIVE' && branch.status !== 'LIVE') {
    throw new HttpError(409, 'The Partner Terms cannot be accepted for this pharmacy right now.', 'TERMS_NOT_ALLOWED');
  }
  const request = await deps.repo.findByOrganisationId(branch.id);
  const earlier = await latestAcceptance(deps.repo, branch, request);
  if (earlier) return { acceptance: earlier, created: false };

  const acceptance: PartnerTermsAcceptanceRecord = {
    id: randomUUID(),
    onboardingRequestId: request?.id ?? null,
    organisationId: branch.id,
    termsVersion: deps.termsVersion,
    signerName: input.signerName.trim(),
    signerRole: input.signerRole,
    signerRoleOther: input.signerRole === 'OTHER' ? input.signerRoleOther?.trim() || null : null,
    signerEmail: input.signerEmail.trim().toLowerCase(),
    signerGphcNumber: signerRoleIsPharmacist(input.signerRole)
      ? normaliseGphcNumber(input.signerGphcNumber ?? '') || null
      : null,
    registeredCompanyName: registeredCompany(branch, request),
    acceptedAt: (context.now ?? new Date()).toISOString(),
    ipAddress: context.ipHash,
    source: 'signup',
    // No PharmSmart ticket in the portal, so the soft name check is "not checked".
    nameMatchesPharmsmart: null,
  };
  await deps.repo.insertTermsAcceptance(acceptance);
  return { acceptance, created: true };
}
