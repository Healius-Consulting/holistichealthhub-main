import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import type { OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import {
  activatePharmacyOnboardingRequest,
  holdPharmacyOnboardingRequest,
  unholdPharmacyOnboardingRequest,
} from './decide-request.js';
import type { OnboardingEmails } from './onboarding-emails.js';
import { sqlOnboardingEmails } from './onboarding-emails.service.js';
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
  organisations: Pick<OrganisationRepositoryPort, 'createOrganisation' | 'findOrganisationById' | 'updateOrganisationStatus' | 'updateOrganisationIntakeEnabled'>;
  referralLinks: { ensureEligibilityLink(params: { organisationId: string; createdByUid?: string | null }): Promise<{ token: string }> };
  /** Signs a held branch's staff out. */
  revokeSessions: (organisationId: string, revokedAt: string) => Promise<void>;
  audit: (input: RequestAudit) => Promise<void>;
  /** The partner onboarding emails. They never throw. */
  emails?: OnboardingEmails;
  /** ClickUp card updates (application/clickup). Best effort: never fails the action. */
  clickup?: Pick<ClickupHooks, 'activated' | 'held' | 'unheld'>;
};

/** The emails promise never to throw; this keeps a broken one from failing a state change already made. */
async function sendQuietly(label: string, send: () => Promise<void>) {
  try {
    await send();
  } catch (error) {
    console.error(`Pharmacy onboarding ${label} email failed`, error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * HHH admin's decisions on a pharmacy request. Activate (from pending) creates the
 * branch in demo mode and sends the Activation email. Hold (from pending, or an
 * activated branch not live yet) sets one of the fixed reasons and sends the Hold
 * email; holding again with another reason changes it and sends the email again.
 * Unhold returns it to where it came from and sends nothing.
 */
export function pharmacyRequestActions(deps: PharmacyRequestActionDeps) {
  const emails = deps.emails ?? sqlOnboardingEmails();
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
      if (request) await sendQuietly('activation', () => emails.activated({ request, organisationId: result.organisation.id }));
      await bestEffort('activation', () => deps.clickup?.activated(result));
      return { ...result, request };
    },

    async hold(input: { id: string; reason: OnboardingHoldReason; actorUid: string; now?: Date }) {
      const held = await holdPharmacyOnboardingRequest(deps, input);
      const { request } = held;
      await deps.audit({
        event: held.previousReason ? 'pharmacy_onboarding.hold_reason_changed' : 'pharmacy_onboarding.held',
        organisationId: held.organisationId,
        recordType: 'PharmacyOnboardingRequest',
        recordId: request.id,
        details: {
          gphcNumber: request.gphcNumber,
          reason: input.reason,
          ...(held.previousReason ? { previousReason: held.previousReason } : {}),
          ...(held.organisationId ? { branchClosed: true } : {}),
        },
      });
      await sendQuietly('hold', () => emails.held({ request, reason: input.reason, heldAt: request.heldAt! }));
      await bestEffort('hold', () => deps.clickup?.held({
        id: request.id,
        gphcNumber: request.gphcNumber,
        organisationId: request.organisationId,
        reason: input.reason,
        heldAt: request.heldAt!,
        previousReason: held.previousReason,
      }));
      return request;
    },

    async unhold(input: { id: string }) {
      const unheld = await unholdPharmacyOnboardingRequest(deps, input);
      await deps.audit({
        event: 'pharmacy_onboarding.unheld',
        organisationId: unheld.organisationId,
        recordType: 'PharmacyOnboardingRequest',
        recordId: unheld.id,
        details: { gphcNumber: unheld.gphcNumber, status: unheld.status, reason: unheld.holdReason },
      });
      await bestEffort('unhold', () => deps.clickup?.unheld({
        id: unheld.id,
        gphcNumber: unheld.gphcNumber,
        organisationId: unheld.organisationId,
      }));
      return unheld;
    },
  };
}
