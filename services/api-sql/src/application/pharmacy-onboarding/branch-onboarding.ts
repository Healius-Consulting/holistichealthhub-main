import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { sameUuid, uuidKey } from '../../domain/common/uuid.js';
import { normaliseGphcNumber } from '../../domain/identity/pharmsmart-sso.js';
import { compactGphcNumber, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import {
  signerRoleIsPharmacist,
  type BranchPartnerTermsAcceptanceInput,
  type PartnerTermsAcceptanceRecord,
} from '../../domain/pharmacy-onboarding/terms.js';
import type { WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { owesSignature, type PartnerTermsState } from './partner-terms.service.js';

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
  /** Whether the Partner Terms are switched on (partner-terms.service). Off: no Terms step anywhere. */
  termsRequired: boolean;
  /** The version to sign while on. */
  currentTerms: { documentId: string; version: string } | null;
  /** Signed the current version (always true while the Terms are off, so nothing waits on them). */
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

/** Every acceptance the branch has: linked at Activate, signed from the portal, or on its request. Newest first. */
export async function branchAcceptances(repo: Pick<BranchOnboardingRepo, 'findByOrganisationId' | 'findTermsAcceptances' | 'findTermsAcceptancesForOrganisation'>, branch: Pick<Branch, 'id'>, request?: PharmacyOnboardingRequestRecord | null) {
  const forRequest = request === undefined ? await repo.findByOrganisationId(branch.id) : request;
  const rows = [
    ...(await repo.findTermsAcceptancesForOrganisation(branch.id)),
    ...(forRequest ? await repo.findTermsAcceptances(forRequest.id) : []),
  ];
  const unique = [...new Map(rows.map(row => [uuidKey(row.id), row])).values()];
  return unique.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}

export async function branchOnboardingView(repo: BranchOnboardingRepo, branch: Branch, terms: PartnerTermsState): Promise<BranchOnboardingView> {
  const request = await repo.findByOrganisationId(branch.id);
  const [acceptances, worldpay] = await Promise.all([
    branchAcceptances(repo, branch, request),
    repo.findWorldpaySubmissionForBranch(branch.id, branchGphc(branch)),
  ]);
  const current = terms.document ? acceptances.find(row => sameUuid(row.documentId, terms.document!.id)) ?? null : null;
  return {
    live: branch.status === 'LIVE',
    submittedAt: request?.createdAt ?? null,
    termsRequired: terms.on,
    currentTerms: terms.on && terms.document ? { documentId: terms.document.id, version: terms.document.version } : null,
    termsAccepted: !owesSignature(terms, branch, acceptances),
    termsAcceptedAt: current?.acceptedAt ?? acceptances[0]?.acceptedAt ?? null,
    worldpaySubmittedAt: worldpay?.submittedAt ?? null,
    registeredCompanyName: registeredCompany(branch, request),
  };
}

/**
 * An activated branch signs the current Partner Terms version from its portal: at the
 * login prompt, or from its Onboarding page. Once per branch and version; a repeat
 * returns the signature already there. The row carries the branch id, its onboarding
 * request when there is one, and the version's document id.
 */
export async function acceptBranchPartnerTerms(
  deps: { repo: BranchOnboardingRepo; terms: { version: string; documentId: string } | null },
  branch: Branch,
  input: BranchPartnerTermsAcceptanceInput,
  context: { ipHash: string | null; now?: Date },
): Promise<{ acceptance: PartnerTermsAcceptanceRecord; created: boolean }> {
  if (branch.status !== 'ONBOARDING' && branch.status !== 'INTAKE_LIVE' && branch.status !== 'LIVE') {
    throw new HttpError(409, 'The Partner Terms cannot be accepted for this pharmacy right now.', 'TERMS_NOT_ALLOWED');
  }
  if (!deps.terms) throw new HttpError(409, 'The Partner Terms are not being asked for at the moment.', 'PARTNER_TERMS_OFF');
  const request = await deps.repo.findByOrganisationId(branch.id);
  const earlier = (await branchAcceptances(deps.repo, branch, request)).find(row => sameUuid(row.documentId, deps.terms!.documentId));
  if (earlier) return { acceptance: earlier, created: false };

  const acceptance: PartnerTermsAcceptanceRecord = {
    id: randomUUID(),
    onboardingRequestId: request?.id ?? null,
    organisationId: branch.id,
    termsVersion: deps.terms.version,
    documentId: deps.terms.documentId,
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
    source: 'reacceptance',
    // No PharmSmart ticket in the portal, so the soft name check is "not checked".
    nameMatchesPharmsmart: null,
  };
  await deps.repo.insertTermsAcceptance(acceptance);
  return { acceptance, created: true };
}
