import type { ApiFieldIssue } from '../shared/api';

export const PHARMACY_FORM_FIELDS = [
  'name',
  'tradingName',
  'gphcNumber',
  'superintendent',
  'companyNumber',
  'addressLine1',
  'addressLine2',
  'locality',
  'postcode',
  'pharmacyPhone',
  'pharmacyEmail',
  'mainContactName',
  'mainContactPhone',
  'mainContactEmail',
  'websiteDomains',
  'status',
  'primaryColour',
] as const;

export type PharmacyFormField = (typeof PHARMACY_FORM_FIELDS)[number];
export type PharmacyFieldErrors = Partial<Record<PharmacyFormField, string>>;

const FIELD_LABELS: Record<PharmacyFormField, string> = {
  name: 'Registered pharmacy name',
  tradingName: 'Trading name',
  gphcNumber: 'GPhC number',
  superintendent: 'Superintendent pharmacist',
  companyNumber: 'Company registration number',
  addressLine1: 'Address line 1',
  addressLine2: 'Address line 2',
  locality: 'Town or city',
  postcode: 'Postcode',
  pharmacyPhone: 'Pharmacy landline',
  pharmacyEmail: 'Pharmacy email',
  mainContactName: 'Superintendent contact name',
  mainContactPhone: 'Superintendent contact number',
  mainContactEmail: 'Superintendent contact email',
  websiteDomains: 'Approved website domains',
  status: 'Account status',
  primaryColour: 'Primary brand colour',
};

const FIELD_MESSAGES: Record<PharmacyFormField, string> = {
  name: 'Enter the registered pharmacy name, 2 to 160 characters, starting with a letter or number.',
  tradingName: 'Enter the trading name, 2 to 160 characters.',
  gphcNumber: 'Enter the GPhC number, 3 to 40 characters.',
  superintendent: 'Enter the superintendent pharmacist, 2 to 160 characters.',
  companyNumber: 'Use 40 characters or fewer.',
  addressLine1: 'Enter the first line of the address.',
  addressLine2: 'Use 250 characters or fewer.',
  locality: 'Enter the town or city.',
  postcode: 'Enter the postcode.',
  pharmacyPhone: 'Use 40 characters or fewer.',
  pharmacyEmail: 'Enter a valid email address, or leave it blank.',
  mainContactName: 'Use 160 characters or fewer.',
  mainContactPhone: 'Use 40 characters or fewer.',
  mainContactEmail: 'Enter a valid email address.',
  websiteDomains: 'Enter up to 10 domains, one per line.',
  status: 'Choose an account status.',
  primaryColour: 'Choose a colour.',
};

/** Server fields with no box of their own, shown against the box they are built from. */
const DERIVED_FROM: Record<string, PharmacyFormField> = {
  address: 'addressLine1',
  county: 'locality',
  logoText: 'name',
  portalName: 'name',
};

function formFieldFor(path: string): PharmacyFormField | null {
  const root = path.split('.')[0] ?? '';
  if (root in DERIVED_FROM) return DERIVED_FROM[root] ?? null;
  return (PHARMACY_FORM_FIELDS as readonly string[]).includes(root) ? root as PharmacyFormField : null;
}

/**
 * Turns the server's validation issues into a message under each box. Issues
 * that cannot be placed on a box are returned separately for the banner.
 */
export function pharmacyFieldErrors(issues: ApiFieldIssue[]) {
  const fields: PharmacyFieldErrors = {};
  const unplaced: string[] = [];
  for (const issue of issues) {
    const field = formFieldFor(issue.path);
    if (!field) {
      unplaced.push(issue.message);
      continue;
    }
    fields[field] ??= FIELD_MESSAGES[field];
  }
  return { fields, unplaced };
}

export function pharmacyFieldSummary(fields: PharmacyFieldErrors) {
  const labels = PHARMACY_FORM_FIELDS.filter(field => fields[field]).map(field => FIELD_LABELS[field]);
  return labels.length ? `Check the highlighted ${labels.length === 1 ? 'field' : 'fields'}: ${labels.join(', ')}.` : '';
}

/** Two-letter workspace mark. Letters and digits only, which is all the server accepts. */
export function pharmacyLogoText(name: string, fallback = 'RX') {
  const initials = name.split(/\s+/).map(part => part.replace(/[^A-Za-z0-9]/g, '').charAt(0)).filter(Boolean).join('');
  return (initials || name.replace(/[^A-Za-z0-9]/g, '') || fallback).slice(0, 2).toUpperCase();
}
