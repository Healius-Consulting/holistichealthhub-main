import { ELIGIBILITY_CONDITION_IDS } from './conditions.js';
import type { FormConditionRecord } from './form-conditions.js';

/**
 * Validating a staff edit to a patient's recorded conditions.
 *
 * Deliberately different from the public eligibility form, which caps a patient
 * at three conditions to keep an unsupervised intake form short and answerable.
 * Staff are working from a clinic letter in front of them: capping what they can
 * record would mean the pharmacy's own record could not match the prescription
 * it is dispensing against. So there is no maximum here — only that every code
 * is real, that there is at least one, and that exactly one of them is primary.
 */

export const CONDITION_CODES: ReadonlySet<string> = new Set<string>(ELIGIBILITY_CONDITION_IDS);

export type ConditionEditFailure =
  | { reason: 'empty' }
  | { reason: 'unknown-codes'; codes: string[] }
  | { reason: 'primary-not-selected' };

export type ConditionEditResult =
  | { ok: true; records: FormConditionRecord[]; conditionCodes: string[]; primaryConditionCode: string }
  | { ok: false; failure: ConditionEditFailure };

/**
 * Duplicates are collapsed rather than rejected: picking the same condition
 * twice is a slip with an obvious intended meaning, not a decision to overturn.
 * Unknown codes are rejected, because silently dropping one would leave staff
 * believing they had recorded something the record does not hold.
 */
export function validateConditionEdit(input: {
  conditionCodes: unknown;
  primaryConditionCode: unknown;
}): ConditionEditResult {
  const raw = Array.isArray(input.conditionCodes) ? input.conditionCodes : [];
  const codes = [...new Set(raw.flatMap(value => (typeof value === 'string' && value.trim() ? [value.trim()] : [])))];

  if (!codes.length) return { ok: false, failure: { reason: 'empty' } };

  const unknown = codes.filter(code => !CONDITION_CODES.has(code));
  if (unknown.length) return { ok: false, failure: { reason: 'unknown-codes', codes: unknown } };

  const primary = typeof input.primaryConditionCode === 'string' ? input.primaryConditionCode.trim() : '';
  if (!primary || !codes.includes(primary)) return { ok: false, failure: { reason: 'primary-not-selected' } };

  return {
    ok: true,
    conditionCodes: codes,
    primaryConditionCode: primary,
    records: codes.map(conditionCode => ({ conditionCode, primary: conditionCode === primary })),
  };
}

/** Wording staff can act on, rather than a schema path. */
export function conditionEditFailureMessage(failure: ConditionEditFailure): string {
  if (failure.reason === 'empty') return 'A patient record must list at least one condition.';
  if (failure.reason === 'primary-not-selected') return 'The primary condition must be one of the selected conditions.';
  return `These conditions are not in the catalogue: ${failure.codes.join(', ')}.`;
}

/**
 * What actually changed, for the audit trail. Recording the before and after
 * sets is the point: a condition list is clinical context, and "someone edited
 * it" without saying how is not an audit trail.
 */
export function conditionEditDiff(before: FormConditionRecord[], after: FormConditionRecord[]) {
  const beforeCodes = new Set(before.map(record => record.conditionCode));
  const afterCodes = new Set(after.map(record => record.conditionCode));
  const primaryBefore = before.find(record => record.primary)?.conditionCode ?? null;
  const primaryAfter = after.find(record => record.primary)?.conditionCode ?? null;
  return {
    added: [...afterCodes].filter(code => !beforeCodes.has(code)),
    removed: [...beforeCodes].filter(code => !afterCodes.has(code)),
    primaryBefore,
    primaryAfter,
    primaryChanged: primaryBefore !== primaryAfter,
  };
}
