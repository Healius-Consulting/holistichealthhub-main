import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import {
  activatePharmacyOnboardingRequest,
  holdPharmacyOnboardingRequest,
  unholdPharmacyOnboardingRequest,
} from './decide-request.js';
import { queuePharmacyOnboardingActivated, queuePharmacyOnboardingHeld } from './emails.js';
import { bestEffort, type ClickupHooks } from '../clickup/clickup-hooks.js';

type RequestAudit = {
  event: string;
  organisationId: string | null;
  recordType: string;
  recordId: string;
  details: Record<string, unknown>;
};

export type PharmacyRequestActionDeps = {
  repo: Pick<SqlPharmacyOnboardingRepository, 'findById' | 'listOrganisationGphcNumbers' | 'activate' | 'hold' | 'unhold' | 'linkTermsAcceptances'>;
  organisations: Pick<OrganisationRepositoryPort, 'createOrganisation'>;
  referralLinks: { ensureEligibilityLink(params: { organisationId: string; createdByUid?: string | null }): Promise<{ token: string }> };
  notificationRepo: NotificationRepositoryPort;
  audit: (input: RequestAudit) => Promise<void>;
  /** ClickUp card updates (application/clickup). Best effort: never fails the action. */
  clickup?: Pick<ClickupHooks, 'activated' | 'held' | 'unheld'>;
};

/** The state change has happened by now, so a failed email is logged rather than undoing it. */
async function queueQuietly(label: string, send: () => Promise<void>) {
  try {
    await send();
  } catch (error) {
    console.error(`Pharmacy onboarding ${label} email was not queued`, error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * HHH admin's three decisions on a pharmacy request. Activate (from pending) creates
 * the pharmacy and emails it; Hold (from pending) emails it without the reason;
 * Unhold (from on hold) sends nothing.
 */
export function pharmacyRequestActions(deps: PharmacyRequestActionDeps) {
  return {
    async activate(input: { id: string; actorUid: string; now?: Date }) {
      const result = await activatePharmacyOnboardingRequest(deps.repo, deps.organisations, deps.referralLinks, input);
      const request = await deps.repo.findById(result.requestId);
      await deps.audit({
        event: 'organisation.created',
        organisationId: result.organisation.id,
        recordType: 'Organisation',
        recordId: result.organisation.id,
        details: { source: 'pharmacy-onboarding-request', requestId: result.requestId },
      });
      await deps.audit({
        event: 'pharmacy_onboarding.activated',
        organisationId: result.organisation.id,
        recordType: 'PharmacyOnboardingRequest',
        recordId: result.requestId,
        details: { gphcNumber: result.organisation.gphcNumber },
      });
      await queueQuietly('activated', () => queuePharmacyOnboardingActivated(deps.notificationRepo, {
        id: result.requestId,
        pharmacyName: result.organisation.name,
        pharmacyEmail: result.organisation.pharmacyEmail,
      }));
      await bestEffort('activation', () => deps.clickup?.activated(result));
      return { ...result, request };
    },

    async hold(input: { id: string; reason: string; actorUid: string; now?: Date }) {
      const held = await holdPharmacyOnboardingRequest(deps.repo, input);
      await deps.audit({
        event: 'pharmacy_onboarding.held',
        organisationId: null,
        recordType: 'PharmacyOnboardingRequest',
        recordId: held.id,
        details: { gphcNumber: held.gphcNumber },
      });
      await queueQuietly('on-hold', () => queuePharmacyOnboardingHeld(deps.notificationRepo, held));
      await bestEffort('hold', () => deps.clickup?.held(held));
      return held;
    },

    async unhold(input: { id: string }) {
      const unheld = await unholdPharmacyOnboardingRequest(deps.repo, input);
      await deps.audit({
        event: 'pharmacy_onboarding.unheld',
        organisationId: null,
        recordType: 'PharmacyOnboardingRequest',
        recordId: unheld.id,
        details: { gphcNumber: unheld.gphcNumber },
      });
      await bestEffort('unhold', () => deps.clickup?.unheld(unheld));
      return unheld;
    },
  };
}
