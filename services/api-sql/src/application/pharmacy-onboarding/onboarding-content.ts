import { mergeTemplate } from '../../domain/common/content-template.js';
import {
  ONBOARDING_CONTENT_KEYS,
  onboardingContentFrom,
  type OnboardingContent,
  type OnboardingHoldReason,
} from '../../domain/pharmacy-onboarding/content.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';

export async function readOnboardingContent(content: Pick<PlatformContentRepository, 'read'>): Promise<OnboardingContent> {
  return onboardingContentFrom(await content.read(Object.values(ONBOARDING_CONTENT_KEYS)));
}

/** The hold message a pharmacy sees (page and sign-in), merged for its branch. */
export function holdMessageFor(content: OnboardingContent, reason: OnboardingHoldReason, branchName: string) {
  const fields = { 'Branch name': branchName };
  return {
    reason,
    heading: content.holdPage.heading,
    paragraphs: mergeTemplate(content.holdPage[reason], fields, {}),
    footer: content.holdPage.footer,
  };
}
export type OnboardingHoldMessage = ReturnType<typeof holdMessageFor>;
