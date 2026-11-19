import { queueSharedEmail } from '../notifications/email-outbox.js';
import type { ClickupHooks } from '../clickup/clickup-hooks.js';
import { branchAcceptances, type BranchOnboardingRepo } from '../pharmacy-onboarding/branch-onboarding.js';
import { owesSignature, partnerTermsState, type PartnerTermsStateDeps } from '../pharmacy-onboarding/partner-terms.service.js';
import { PARTNER_TERMS_REMINDER_DAYS } from '../../domain/pharmacy-onboarding/partner-terms.js';
import type { PartnerTermsRepository } from '../../repositories/ports/partner-terms.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';

/**
 * The 7-day Partner Terms reminder. Once per branch and version: when the login prompt
 * was first shown 7 or more days ago and the version is still unsigned, the pharmacy
 * email (and whoever first saw the prompt) gets one email, and HHH's ClickUp card a
 * comment. A branch that never logged in has no first view, so it is never emailed.
 */

const DAY = 24 * 60 * 60 * 1000;

export type PartnerTermsReminderDeps = PartnerTermsStateDeps & {
  repo: Pick<PartnerTermsRepository, 'findDocument' | 'listPrompts' | 'savePrompt'>;
  acceptances: Pick<BranchOnboardingRepo, 'findByOrganisationId' | 'findTermsAcceptances' | 'findTermsAcceptancesForOrganisation'>;
  findOrganisation(id: string): Promise<OrganisationRecord | null>;
  notifications: Pick<NotificationRepositoryPort, 'enqueue'>;
  clickup: Pick<ClickupHooks, 'termsOverdue'>;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

export async function remindUnsignedPartnerTerms(deps: PartnerTermsReminderDeps, now = new Date()) {
  const summary = { due: 0, sent: 0, errors: 0 };
  const state = await partnerTermsState(deps);
  if (!state.on || !state.document) return summary;
  const document = state.document;
  const cutoff = now.getTime() - PARTNER_TERMS_REMINDER_DAYS * DAY;
  const due = (await deps.repo.listPrompts(document.id))
    .filter(prompt => !prompt.signedAt && !prompt.reminderSentAt && prompt.firstViewedAt && Date.parse(prompt.firstViewedAt) <= cutoff);
  for (const prompt of due) {
    summary.due += 1;
    try {
      const organisation = await deps.findOrganisation(prompt.organisationId);
      if (!organisation) continue;
      // Signed since (or no longer asked): nothing to chase.
      if (!owesSignature(state, organisation, await branchAcceptances(deps.acceptances, organisation))) continue;
      const to = [organisation.pharmacyEmail || organisation.mainContactEmail].filter((address): address is string => Boolean(address?.trim()));
      if (!to.length) continue;
      await queueSharedEmail(deps.notifications, {
        to,
        cc: prompt.firstViewedByEmail ? [prompt.firstViewedByEmail] : [],
        templateCode: 'pharmacy_partner_terms_reminder',
        organisationId: organisation.id,
        keyParts: ['partner-terms-reminder', organisation.id, document.id],
        payload: { organisationId: organisation.id, pharmacyName: organisation.name, termsVersion: document.version },
      });
      await deps.clickup.termsOverdue({ organisation, version: document.version, firstViewedAt: prompt.firstViewedAt! });
      await deps.repo.savePrompt({ ...prompt, reminderSentAt: now.toISOString() });
      summary.sent += 1;
    } catch (error) {
      summary.errors += 1;
      (deps.warn ?? ((message, details) => console.warn(message, details)))('[Partner Terms reminder] Reminder failed.', {
        organisationId: prompt.organisationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return summary;
}
