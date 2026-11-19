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
