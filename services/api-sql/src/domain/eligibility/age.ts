export const MINIMUM_ELIGIBILITY_AGE_YEARS = 18;

/**
 * Terms 3.1 and Privacy 10 promise that the service is adults-only and that an
 * under-18 application is deleted. Deleting one we should never have accepted is
 * worse than refusing it, so the age is checked before the record is written.
 *
 * `dob` is an ISO date (YYYY-MM-DD); `on` defaults to today.
 */
export function ageInYearsOn(dob: string, on: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!match) return null;
  const [, year, month, day] = match.map(Number) as unknown as [string, number, number, number];
  const birth = Date.UTC(year, month - 1, day);
  if (Number.isNaN(birth)) return null;
  const birthDate = new Date(birth);
  // Reject a date that rolled over — 2026-02-30 parses, but is not a real birthday.
  if (birthDate.getUTCMonth() !== month - 1 || birthDate.getUTCDate() !== day) return null;

  const today = Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate());
  if (birth > today) return null;

  let age = on.getUTCFullYear() - year;
  const hadBirthday = on.getUTCMonth() > month - 1
    || (on.getUTCMonth() === month - 1 && on.getUTCDate() >= day);
  if (!hadBirthday) age -= 1;
  return age;
}

export function isEligibleAge(dob: string, on?: Date): boolean {
  const age = ageInYearsOn(dob, on);
  return age !== null && age >= MINIMUM_ELIGIBILITY_AGE_YEARS;
}

/** Latest date of birth that is 18 or over today — the `max` on the form's date input. */
export function latestEligibleDateOfBirth(on: Date = new Date()): string {
  const date = new Date(Date.UTC(
    on.getUTCFullYear() - MINIMUM_ELIGIBILITY_AGE_YEARS,
    on.getUTCMonth(),
    on.getUTCDate(),
  ));
  return date.toISOString().slice(0, 10);
}
