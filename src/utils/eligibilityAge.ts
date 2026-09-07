export const MINIMUM_ELIGIBILITY_AGE_YEARS = 18;

/**
 * Latest date of birth that is 18 or over today, used as the `max` on the form's
 * date input so the browser refuses an under-18 date before submission. The API
 * enforces the same rule in services/api-sql/src/domain/eligibility/age.ts — this
 * is the courtesy, that is the guarantee.
 */
export function latestEligibleDateOfBirth(on: Date = new Date()): string {
  const date = new Date(Date.UTC(
    on.getUTCFullYear() - MINIMUM_ELIGIBILITY_AGE_YEARS,
    on.getUTCMonth(),
    on.getUTCDate(),
  ));
  return date.toISOString().slice(0, 10);
}
