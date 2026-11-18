import type { ClickupCardFields, ClickupStage } from '../../domain/clickup/clickup-events.js';

/**
 * Where on HHH's ClickUp board the cards go. All of it is environment config on
 * the hhh-api functions, so HHH can point it at their board without a code change:
 *
 * - `CLICKUP_LIST_ID` (required): the list the cards live in.
 * - `CLICKUP_STATUS_*`: the list's status names; the defaults are the brief's.
 * - `CLICKUP_FIELD_*`: custom field ids. Any left unset is simply not written.
 *   Text fields for the references, a Number field for the checklist %, Date for
 *   the Terms date, and Checkbox for the three Curaleaf setup flags.
 *
 * The API token is not here: it is in Secret Manager behind the CLICKUP
 * IntegrationConnection (clickup-token.ts).
 */
export type ClickupConfig = {
  listId: string;
  statuses: Record<ClickupStage, string>;
  fields: Partial<Record<ClickupFieldName, string>>;
};

export type ClickupFieldName =
  | Exclude<keyof ClickupCardFields, 'tradingName'>
  | 'pharCodeEntered'
  | 'apiKeyEntered'
  | 'setupComplete';

const STATUS_ENV: Record<ClickupStage, [string, string]> = {
  interest: ['CLICKUP_STATUS_INTEREST', 'Interest'],
  awaiting_activation: ['CLICKUP_STATUS_AWAITING_ACTIVATION', 'Awaiting activation'],
  on_hold: ['CLICKUP_STATUS_ON_HOLD', 'On hold'],
  awaiting_curaleaf: ['CLICKUP_STATUS_AWAITING_CURALEAF', 'Awaiting Curaleaf'],
  setup: ['CLICKUP_STATUS_SETUP', 'Setup'],
  live: ['CLICKUP_STATUS_LIVE', 'Live'],
  existing_curaleaf_hold: ['CLICKUP_STATUS_EXISTING_CURALEAF_HOLD', 'Existing Curaleaf — hold'],
};

export const CLICKUP_FIELD_ENV: Record<ClickupFieldName, string> = {
  gphcNumber: 'CLICKUP_FIELD_GPHC',
  pharmsmartPharmacyId: 'CLICKUP_FIELD_PHARMSMART_ID',
  onboardingRequestId: 'CLICKUP_FIELD_REQUEST_ID',
  branchId: 'CLICKUP_FIELD_BRANCH_ID',
  legalEntity: 'CLICKUP_FIELD_LEGAL_ENTITY',
  postcode: 'CLICKUP_FIELD_POSTCODE',
  paymentRoute: 'CLICKUP_FIELD_PAYMENT_ROUTE',
  leadSource: 'CLICKUP_FIELD_LEAD_SOURCE',
  termsAcceptedAt: 'CLICKUP_FIELD_TERMS_ACCEPTED_AT',
  termsVersion: 'CLICKUP_FIELD_TERMS_VERSION',
  termsSigner: 'CLICKUP_FIELD_TERMS_SIGNER',
  checklistPercent: 'CLICKUP_FIELD_CHECKLIST_PERCENT',
  pharCodeEntered: 'CLICKUP_FIELD_PHAR_CODE_ENTERED',
  apiKeyEntered: 'CLICKUP_FIELD_API_KEY_ENTERED',
  setupComplete: 'CLICKUP_FIELD_SETUP_COMPLETE',
};

/** Null until HHH sets the list id: the worker then leaves every event queued. */
export function clickupConfig(env: NodeJS.ProcessEnv = process.env): ClickupConfig | null {
  const listId = env.CLICKUP_LIST_ID?.trim();
  if (!listId) return null;
  const statuses = Object.fromEntries(
    Object.entries(STATUS_ENV).map(([stage, [name, fallback]]) => [stage, env[name]?.trim() || fallback]),
  ) as Record<ClickupStage, string>;
  const fields: ClickupConfig['fields'] = {};
  for (const [field, name] of Object.entries(CLICKUP_FIELD_ENV) as Array<[ClickupFieldName, string]>) {
    const id = env[name]?.trim();
    if (id) fields[field] = id;
  }
  return { listId, statuses, fields };
}
