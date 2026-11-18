/**
 * The Curaleaf account form's rules, matching the server's
 * (`services/api-sql/src/domain/pharmacy-onboarding/request.ts`) so a form the browser
 * accepts is never turned away as "invalid or missing fields" without saying which.
 * Values are checked trimmed, as the server trims them. Change both together.
 */

export type CuraleafFieldKey =
  | 'pharmacistName'
  | 'pharmacyName'
  | 'registeredCompanyName'
  | 'invoiceAddress'
  | 'deliveryAddress'
  | 'gphcNumber'
  | 'pharmacyEmail'
  | 'accountsEmail'
  | 'pharmacyPhone'
  | 'accountsPhone'
  | 'faxNumber';

export const CURALEAF_FIELD_LABELS: Record<CuraleafFieldKey, string> = {
  pharmacistName: 'Pharmacist / contact name',
  pharmacyName: 'Pharmacy name',
  registeredCompanyName: 'Registered company name',
  invoiceAddress: 'Invoice address',
  deliveryAddress: 'Delivery address',
  gphcNumber: 'GPhC premises number',
  pharmacyEmail: 'Pharmacy email',
  accountsEmail: 'Accounts email',
  pharmacyPhone: 'Pharmacy telephone',
  accountsPhone: 'Accounts telephone',
  faxNumber: 'Fax number',
};

type Rule = { min: number; max: number; email?: boolean; optional?: boolean };

export const CURALEAF_FIELD_RULES: Record<CuraleafFieldKey, Rule> = {
  pharmacistName: { min: 2, max: 160 },
  pharmacyName: { min: 2, max: 160 },
  registeredCompanyName: { min: 2, max: 160 },
  invoiceAddress: { min: 5, max: 500 },
  deliveryAddress: { min: 5, max: 500 },
  gphcNumber: { min: 3, max: 40 },
  pharmacyEmail: { min: 3, max: 254, email: true },
  accountsEmail: { min: 3, max: 254, email: true },
  pharmacyPhone: { min: 8, max: 40 },
  accountsPhone: { min: 8, max: 40 },
  faxNumber: { min: 0, max: 40, optional: true },
};

// The server's check (zod's email pattern): it wants a dot and a real ending, so
// "name@pharmacy" passes the browser but not the server.
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export type CuraleafFieldProblem = { field: CuraleafFieldKey; problem: string };

function problemFor(field: CuraleafFieldKey, raw: string): string | null {
  const rule = CURALEAF_FIELD_RULES[field];
  const value = raw.trim();
  if (!value) return rule.optional ? null : 'is missing';
  if (rule.email) return EMAIL.test(value) && value.length <= rule.max ? null : 'isn\'t a full email address (for example name@pharmacy.co.uk)';
  if (value.length < rule.min) return `needs at least ${rule.min} characters`;
  if (value.length > rule.max) return `must be ${rule.max} characters or fewer`;
  return null;
}

/** Every field the server would refuse, in form order. */
export function curaleafFormProblems(fields: Record<CuraleafFieldKey, string>): CuraleafFieldProblem[] {
  return (Object.keys(CURALEAF_FIELD_RULES) as CuraleafFieldKey[]).flatMap(field => {
    const problem = problemFor(field, fields[field] ?? '');
    return problem ? [{ field, problem }] : [];
  });
}

/**
 * The fields the server named in a 400, in words. The server's own messages are
 * written for developers, so each field gets this form's wording for its rule; a field
 * this form doesn't know keeps the server's message.
 */
export function curaleafProblemsFromServer(
  issues: readonly { path: string; message: string }[],
  fields: Record<CuraleafFieldKey, string>,
): CuraleafFieldProblem[] {
  const seen = new Set<string>();
  return issues.flatMap(issue => {
    const field = issue.path.split('.')[0] as CuraleafFieldKey;
    if (seen.has(field)) return [];
    seen.add(field);
    if (!(field in CURALEAF_FIELD_RULES)) return [{ field, problem: issue.message }];
    return [{ field, problem: problemFor(field, fields[field] ?? '') ?? 'wasn\'t accepted' }];
  });
}

export function describeCuraleafProblems(problems: readonly CuraleafFieldProblem[]): string {
  const parts = problems.map(({ field, problem }) => `${CURALEAF_FIELD_LABELS[field] ?? field} ${problem}`);
  return parts.length === 1 ? `Check this field: ${parts[0]}.` : `Check these fields: ${parts.join('; ')}.`;
}
