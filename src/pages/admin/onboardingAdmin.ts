import {
  HOLD_REASON_LABEL,
  ONBOARDING_EMAIL_KINDS,
  type OnboardingEmailKind,
  type OnboardingHoldReason,
} from '../../../services/api-sql/src/domain/pharmacy-onboarding/content.ts';
import type { OnboardingEmailLogEntry } from '../../../services/api-sql/src/application/pharmacy-onboarding/onboarding-emails.ts';

/**
 * Pure helpers for the partner onboarding admin: the send log on a request or
 * branch record, and whether HHH can put it on hold (Shay's build pack, 19 Nov 2026).
 */

export const ONBOARDING_EMAIL_LABEL: Record<OnboardingEmailKind, string> = {
  sent: 'Sent (to pharmacy)',
  curaleafApplication: 'Application to Curaleaf',
  activation: 'Ready to try (activation)',
  hold: 'On hold',
  live: 'Live',
};

export type EmailLogTone = 'ok' | 'wait' | 'stop' | 'off';

export function emailStatusLabel(status: OnboardingEmailLogEntry['status'] | null) {
  if (status === 'SENT') return 'Sent';
  if (status === 'PENDING') return 'Pending';
  if (status === 'FAILED') return 'Failed';
  return 'Not sent';
}

export function emailStatusTone(status: OnboardingEmailLogEntry['status'] | null): EmailLogTone {
  if (status === 'SENT') return 'ok';
  if (status === 'PENDING') return 'wait';
  if (status === 'FAILED') return 'stop';
  return 'off';
}

/** When the entry last changed: sent, failed, or queued. */
export function emailEntryTime(entry: OnboardingEmailLogEntry) {
  return entry.sentAt ?? entry.failedAt ?? entry.queuedAt;
}

export type EmailLogRow = {
  kind: OnboardingEmailKind;
  label: string;
  /** The newest send of this kind, or null if it was never sent. */
  latest: OnboardingEmailLogEntry | null;
  /** Every send of this kind, newest first. */
  history: OnboardingEmailLogEntry[];
  /** The newest send failed: show it in red with Resend. */
  failed: boolean;
};

/** One row per email kind, in the order a pharmacy meets them, newest send first. */
export function summariseEmailLog(entries: OnboardingEmailLogEntry[]): EmailLogRow[] {
  return ONBOARDING_EMAIL_KINDS.map(kind => {
    const history = entries
      .filter(entry => entry.kind === kind)
      .sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : a.queuedAt > b.queuedAt ? -1 : 0));
    const latest = history[0] ?? null;
    return { kind, label: ONBOARDING_EMAIL_LABEL[kind], latest, history, failed: latest?.status === 'FAILED' };
  });
}

/** Kinds whose newest send failed. */
export function failedEmailKinds(rows: EmailLogRow[]) {
  return rows.filter(row => row.failed).map(row => row.kind);
}

export function holdReasonLabel(reason: OnboardingHoldReason | null | undefined) {
  return reason ? HOLD_REASON_LABEL[reason] : 'No reason recorded';
}

/**
 * A hold can be set on a new request, or on an activated branch that is not live
 * yet. A live branch is suspended instead.
 */
export function holdAvailability(input: {
  requestStatus: 'pending' | 'on_hold' | 'activated';
  /** The branch's status, when the request has been activated. */
  organisationStatus?: string | null;
}): { allowed: true } | { allowed: false; why: string } {
  if (input.requestStatus === 'on_hold') return { allowed: false, why: 'Already on hold. Change the reason or lift the hold.' };
  if (input.requestStatus === 'pending') return { allowed: true };
  if (input.organisationStatus === 'live') return { allowed: false, why: 'A live branch cannot be put on hold: use Suspend.' };
  if (input.organisationStatus === 'paused') return { allowed: false, why: 'Lift the suspension before putting this branch on hold.' };
  return { allowed: true };
}

/** An organisation status that means the branch is on hold. */
export function isHeldOrganisationStatus(status: string | null | undefined) {
  return status === 'on_hold';
}

/**
 * The emails that apply to a request now, so admin can send one whose first send never
 * got queued (a failed queue write leaves no row to resend). The server refuses the rest.
 */
export function sendableEmailKinds(input: {
  termsAccepted: boolean;
  /** Whether HHH has the Partner Terms switched on. Off (or omitted): Sent and the Curaleaf application need no acceptance. */
  termsRequired?: boolean;
  requestStatus: 'pending' | 'on_hold' | 'activated';
  activated: boolean;
  live: boolean;
}): OnboardingEmailKind[] {
  const kinds: OnboardingEmailKind[] = [];
  if (input.termsAccepted || !input.termsRequired) kinds.push('sent', 'curaleafApplication');
  if (input.activated) kinds.push('activation');
  if (input.requestStatus === 'on_hold') kinds.push('hold');
  if (input.live) kinds.push('live');
  return kinds;
}

// One read per admin page load: whether the Partner Terms are switched on.
let termsOnCache: Promise<boolean> | null = null;

/** Whether the Partner Terms are switched on (cached for the page). Local preview: off. */
export function partnerTermsOn(load: () => Promise<{ settings: { enabled: boolean }; currentDocumentId: string | null }>): Promise<boolean> {
  termsOnCache ??= load().then(view => view.settings.enabled && Boolean(view.currentDocumentId)).catch(() => false);
  return termsOnCache;
}
