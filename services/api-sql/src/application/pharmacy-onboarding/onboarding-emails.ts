import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { OnboardingEmailKind, OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';

/**
 * The partner onboarding emails (Shay's build pack, 19 Nov 2026), as one port the
 * lifecycle code calls. Every method:
 * - reads the wording from admin content (domain/pharmacy-onboarding/content.ts);
 * - sends to the Partner Terms signer and the request's pharmacy email (one email when
 *   they are the same address), except the application to Curaleaf;
 * - tags each outbox row with onboardingRequestId so it shows in the branch's send log;
 * - never throws (except `resend`): a failed send is recorded for admin to resend and
 *   never blocks the state change that triggered it.
 * Never put patient data or the Curaleaf API key in an email.
 */
export interface OnboardingEmails {
  /**
   * At Partner Terms acceptance: "Sent" to the pharmacy, and the application to
   * Curaleaf (To Curaleaf, CC config; a demo GPhC goes to the CC list only, marked DEMO).
   * Once per request.
   */
  applicationReceived(input: { request: PharmacyOnboardingRequestRecord; demo: boolean }): Promise<void>;
  /** At manual Activate: the "ready to try" email. Once per request. */
  activated(input: { request: PharmacyOnboardingRequestRecord; organisationId: string }): Promise<void>;
  /** Each time admin sets a hold or changes its reason. */
  held(input: { request: PharmacyOnboardingRequestRecord; reason: OnboardingHoldReason; heldAt: string }): Promise<void>;
  /** The first time the branch goes live (Curaleaf PHAR code and API key saved). Once per branch. */
  wentLive(input: { organisationId: string }): Promise<void>;
  /**
   * Admin's Resend from the send log: the same email again, as it would be sent now.
   * Unlike the others it throws (404 no request, 409 the email does not apply yet), since
   * it is an admin action that blocks nothing.
   */
  resend(input: { requestId: string; kind: OnboardingEmailKind; actorUid: string }): Promise<void>;
}

/** One row of a request's send log, for the admin record. */
export type OnboardingEmailLogEntry = {
  id: string;
  kind: OnboardingEmailKind;
  /** Addresses as sent (To, then CC). */
  recipients: string[];
  status: 'PENDING' | 'SENT' | 'FAILED';
  queuedAt: string;
  sentAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
};
