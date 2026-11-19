/**
 * The partner-onboarding events the platform tells HHH's ClickUp board about
 * (Step 6, Option A). One-way: ClickUp never writes back. One card per pharmacy.
 */
export const CLICKUP_EVENTS = [
  'interest',
  'submitted',
  'held',
  'held_existing_curaleaf',
  'unheld',
  'unheld_activated',
  'activated',
  'phar_code_entered',
  'api_key_entered',
  'live',
  'checklist_progress',
  'terms_accepted',
  'worldpay_submitted',
  'worldpay_validated',
  'terms_skipped',
  'terms_overdue',
  'terms_version_published',
] as const;

export type ClickupEvent = typeof CLICKUP_EVENTS[number];

export function isClickupEvent(value: unknown): value is ClickupEvent {
  return typeof value === 'string' && (CLICKUP_EVENTS as readonly string[]).includes(value);
}

/** The board's columns. Their ClickUp names are config (clickup-config.ts). */
export type ClickupStage =
  | 'interest'
  | 'awaiting_activation'
  | 'on_hold'
  | 'awaiting_curaleaf'
  | 'setup'
  | 'live'
  | 'existing_curaleaf_hold';

/**
 * The only fields that may leave the platform for ClickUp: references and business
 * details of the pharmacy. Nothing about patients, and no person except the Terms
 * signer the brief asks for.
 */
export type ClickupCardFields = {
  gphcNumber: string;
  tradingName?: string | null;
  pharmsmartPharmacyId?: string | null;
  onboardingRequestId?: string | null;
  branchId?: string | null;
  legalEntity?: string | null;
  postcode?: string | null;
  paymentRoute?: string | null;
  leadSource?: string | null;
  termsAcceptedAt?: string | null;
  termsVersion?: string | null;
  termsSigner?: string | null;
  checklistPercent?: number | null;
  /** Not a custom field: posted as a comment on the card (Worldpay submission, hold reason). No personal or bank data. */
  comment?: string | null;
};

export const CLICKUP_FIELD_KEYS = [
  'gphcNumber',
  'tradingName',
  'pharmsmartPharmacyId',
  'onboardingRequestId',
  'branchId',
  'legalEntity',
  'postcode',
  'paymentRoute',
  'leadSource',
  'termsAcceptedAt',
  'termsVersion',
  'termsSigner',
  'checklistPercent',
] as const satisfies ReadonlyArray<keyof ClickupCardFields>;

export const LEAD_SOURCE_PHARMSMART = 'PharmSmart';
export const LEAD_SOURCE_ONBOARDING_PAGE = 'Onboarding page';

/**
 * Copy only the allowed keys, trimmed and length-capped, so a caller passing a
 * whole record (with emails, phones, names) can't leak anything else.
 */
export function clickupCardFields(input: Partial<Record<string, unknown>> & { gphcNumber: string }): ClickupCardFields {
  const fields: ClickupCardFields = { gphcNumber: input.gphcNumber.trim().slice(0, 40) };
  for (const key of CLICKUP_FIELD_KEYS) {
    if (key === 'gphcNumber') continue;
    const value = input[key];
    if (value == null) continue;
    if (key === 'checklistPercent') {
      const percent = Number(value);
      if (Number.isFinite(percent)) fields.checklistPercent = Math.max(0, Math.min(100, Math.round(percent)));
      continue;
    }
    const text = String(value).trim();
    if (text) fields[key] = text.slice(0, 200);
  }
  if (typeof input.comment === 'string' && input.comment.trim()) fields.comment = input.comment.trim().slice(0, 300);
  return fields;
}

/** A UK postcode found in a free-text address, upper-cased with one space. */
export function postcodeFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const matches = [...address.toUpperCase().matchAll(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/g)];
  const last = matches.at(-1);
  return last ? `${last[1]} ${last[2]}` : null;
}

/**
 * Where an event moves the card. `null` leaves the column alone. Interest only
 * applies to a new card, so a late visit can never pull a card backwards, and the
 * Curaleaf setup steps only move it to Setup once both are in and it isn't live.
 */
export function clickupStageFor(
  event: ClickupEvent,
  card: { exists: boolean; stage: ClickupStage | null; pharCodeEntered: boolean; apiKeyEntered: boolean },
): ClickupStage | null {
  switch (event) {
    case 'interest':
      return card.exists ? null : 'interest';
    case 'submitted':
    case 'unheld':
      return 'awaiting_activation';
    case 'held':
      return 'on_hold';
    case 'held_existing_curaleaf':
      return 'existing_curaleaf_hold';
    case 'unheld_activated':
      // Back to where an activated branch sits: Setup once both Curaleaf details are in.
      return card.pharCodeEntered && card.apiKeyEntered ? 'setup' : 'awaiting_curaleaf';
    case 'activated':
      return 'awaiting_curaleaf';
    case 'phar_code_entered':
    case 'api_key_entered':
      if (card.pharCodeEntered && card.apiKeyEntered && card.stage !== 'live') return 'setup';
      return card.exists ? null : 'awaiting_curaleaf';
    case 'live':
      return 'live';
    case 'checklist_progress':
    case 'terms_accepted':
    case 'worldpay_submitted':
    case 'worldpay_validated':
      return card.exists ? null : 'awaiting_curaleaf';
    case 'terms_skipped':
    case 'terms_overdue':
    case 'terms_version_published':
      // A comment on the card; the column never moves for the Terms.
      return card.exists ? null : 'awaiting_curaleaf';
  }
}
