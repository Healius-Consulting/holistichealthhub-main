import type { CompanyLookup } from '../shared/api';

/** The Curaleaf form fields Companies House can fill. */
export type CuraleafCompanyFields = { registeredCompanyName: string; invoiceAddress: string };

/**
 * Companies House is the register for the company name, so its name replaces one that is
 * empty or still as PharmSmart sent it. A name the pharmacy typed is theirs and stays.
 * The invoice address only fills when empty: invoices may rightly go somewhere other
 * than the registered office (often an accountant's).
 */
export function curaleafFieldsFromCompany<T extends CuraleafCompanyFields>(
  current: T,
  pharmsmart: CuraleafCompanyFields,
  company: CompanyLookup,
): { fields: T; filled: Array<keyof CuraleafCompanyFields> } {
  const filled: Array<keyof CuraleafCompanyFields> = [];
  const next = { ...current };
  const name = company.companyName.trim();
  const nameUntouched = !current.registeredCompanyName.trim() || current.registeredCompanyName === pharmsmart.registeredCompanyName;
  if (name && nameUntouched && current.registeredCompanyName !== name) {
    next.registeredCompanyName = name;
    filled.push('registeredCompanyName');
  }
  const address = company.registeredAddress.trim();
  if (address && !current.invoiceAddress.trim()) {
    next.invoiceAddress = address;
    filled.push('invoiceAddress');
  }
  return { fields: next, filled };
}

/** "2015-03-02" → "March 2015", as the Worldpay form's "Trading since" hint asks. */
export function monthYear(isoDate: string | null): string | undefined {
  const match = isoDate?.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!match) return undefined;
  const month = new Date(Date.UTC(2000, Number(match[2]) - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `${month} ${match[1]}`;
}

/** The Worldpay business fields Companies House can fill. */
export type WorldpayCompanyFields = {
  legalName: string;
  businessType: string;
  registrationNumber: string;
  registeredAddress: string;
  tradingSince: string;
  accountName: string;
};

/** The parts of a Worldpay principal Companies House knows. */
export type WorldpayCompanyPerson = { firstNames: string; surname: string; nationality: string; countryOfResidence: string };

const WORLDPAY_LABELS: Record<Exclude<keyof WorldpayCompanyFields, 'accountName'>, string> = {
  legalName: 'Legal name',
  businessType: 'Business type',
  registrationNumber: 'Company registration number',
  registeredAddress: 'Registered address',
  tradingSince: 'Trading since',
};

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const firstOf = (names: string) => names.trim().split(/\s+/)[0] ?? '';
const samePerson = (a: { firstNames: string; surname: string }, b: { firstNames: string; surname: string }) =>
  sameText(a.surname, b.surname) && sameText(firstOf(a.firstNames), firstOf(b.firstNames));
const named = (person: { firstNames: string; surname: string }) => Boolean(person.firstNames.trim() || person.surname.trim());
const sameRow = <P extends object>(a: P, b: P) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Fills the Worldpay form from a Companies House record.
 *
 * Business fields: the register's value replaces one that is empty or still as the form
 * opened with it; anything the pharmacy changed in this form stays. The bank "Name on
 * account" follows the legal name while it still matches it.
 *
 * Principals are the company's current directors (up to `max`). A director already on
 * the form (same surname and first name) keeps what was typed and gains any missing
 * nationality or country; others fill an empty principal, then are added. A principal
 * the form opened with that is not a director (PharmSmart's superintendent, say) and
 * that nobody has changed is a guess the register replaces, so it goes.
 */
export function worldpayFromCompany<F extends WorldpayCompanyFields, P extends WorldpayCompanyPerson>(input: {
  fields: F;
  startFields: F;
  principals: P[];
  startPrincipals: P[];
  blankPrincipal: P;
  company: CompanyLookup;
  max: number;
}): { fields: F; principals: P[]; filled: string[] } {
  const { company, startFields, startPrincipals, blankPrincipal, max } = input;
  const fields = { ...input.fields };
  const filled: string[] = [];
  const register: Record<keyof typeof WORLDPAY_LABELS, string> = {
    legalName: company.companyName.trim(),
    businessType: company.businessType ?? '',
    registrationNumber: company.companyNumber.trim(),
    registeredAddress: company.registeredAddress.trim(),
    tradingSince: monthYear(company.incorporatedOn) ?? '',
  };
  const previousLegalName = fields.legalName;
  for (const key of Object.keys(register) as Array<keyof typeof register>) {
    const value = register[key];
    const current = fields[key];
    if (!value || current === value) continue;
    if (current.trim() && current !== startFields[key]) continue;
    fields[key] = value as F[typeof key];
    filled.push(WORLDPAY_LABELS[key]);
  }
  if (fields.legalName !== previousLegalName && (!fields.accountName.trim() || fields.accountName === previousLegalName)) {
    fields.accountName = fields.legalName as F['accountName'];
    filled.push('Name on account');
  }

  const directors = company.directors.slice(0, max);
  let principals = input.principals.map(person => ({ ...person }));
  if (directors.length) {
    principals = principals.filter(person => !(
      named(person)
      && startPrincipals.some(start => sameRow(start, person))
      && !directors.some(director => samePerson(person, director))
    ));
  }
  let added = 0;
  let updated = 0;
  for (const director of directors) {
    const at = principals.findIndex(person => samePerson(person, director));
    if (at >= 0) {
      const person = principals[at];
      const next = {
        ...person,
        nationality: person.nationality.trim() ? person.nationality : director.nationality,
        countryOfResidence: person.countryOfResidence.trim() ? person.countryOfResidence : director.countryOfResidence,
      };
      if (!sameRow(next, person)) updated += 1;
      principals[at] = next;
      continue;
    }
    const fromDirector = {
      firstNames: director.firstNames,
      surname: director.surname,
      nationality: director.nationality,
      countryOfResidence: director.countryOfResidence || blankPrincipal.countryOfResidence,
    };
    const empty = principals.findIndex(person => !named(person));
    if (empty >= 0) {
      const person = principals[empty];
      principals[empty] = {
        ...person,
        ...fromDirector,
        nationality: person.nationality.trim() || fromDirector.nationality,
      };
      added += 1;
    } else if (principals.length < max) {
      principals.push({ ...blankPrincipal, ...fromDirector });
      added += 1;
    }
  }
  if (!principals.length) principals = [{ ...blankPrincipal }];
  if (added) filled.push(added === 1 ? '1 director as a principal' : `${added} directors as principals`);
  if (updated) filled.push(updated === 1 ? 'Nationality and residence for 1 principal' : `Nationality and residence for ${updated} principals`);
  return { fields, principals, filled };
}
