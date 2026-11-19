import type { OnboardingContent, OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { holdMessageFor, readOnboardingContent, type OnboardingHoldMessage } from './onboarding-content.js';

/**
 * A held branch whose request carries no reason (no request, or a hold half-written
 * when an update failed) shows reason A's wording rather than nothing.
 */
export const LEGACY_HOLD_REASON: OnboardingHoldReason = 'EXISTING_CURALEAF_CUSTOMER';

export type BranchHoldMessageDeps = {
  findRequestByOrganisation(organisationId: string): Promise<Pick<PharmacyOnboardingRequestRecord, 'holdReason' | 'pharmacyName'> | null>;
  readContent(): Promise<OnboardingContent>;
};

/** The hold message an activated branch on hold sees, merged with its name. */
export async function branchHoldMessage(
  deps: BranchHoldMessageDeps,
  branch: { id: string; name?: string | null },
): Promise<OnboardingHoldMessage> {
  const [request, content] = await Promise.all([
    deps.findRequestByOrganisation(branch.id).catch(() => null),
    deps.readContent(),
  ]);
  const branchName = request?.pharmacyName || branch.name || 'your pharmacy';
  return holdMessageFor(content, request?.holdReason ?? LEGACY_HOLD_REASON, branchName);
}

/** The SQL wiring: content from PlatformContent, the reason from the branch's request. */
export function sqlHoldMessages() {
  const repo = new SqlPharmacyOnboardingRepository();
  const contentRepo = new SqlPlatformContentRepository();
  const readContent = () => readOnboardingContent(contentRepo);
  return {
    forBranch: (branch: { id: string; name?: string | null }) => branchHoldMessage({
      findRequestByOrganisation: id => repo.findByOrganisationId(id),
      readContent,
    }, branch),
    forReason: async (reason: OnboardingHoldReason | null, branchName: string) =>
      holdMessageFor(await readContent(), reason ?? LEGACY_HOLD_REASON, branchName),
  };
}
