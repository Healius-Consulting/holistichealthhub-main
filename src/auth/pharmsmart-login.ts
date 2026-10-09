import type { PharmsmartLoginResult } from '../shared/api';
import type { PharmsmartWelcome } from './types';

/**
 * A PharmSmart login is only the opaque `?token=` value.
 * Email and name in the query string are not credentials. The token is removed
 * from the address bar as soon as it has been read for the server redemption.
 */

export const PHARMSMART_ONBOARDING_CALENDLY = 'https://calendly.com/spatel-72k/30min';

export const PHARMSMART_ONBOARDING_STEPS = [
  'Book a 30-minute demo with Shaylen Patel MPharm, Pharmacy Consultant at Healius Pharmacy Consulting.',
  'Complete the Curaleaf account onboarding checklist and attach a valid copy of the controlled drug licence.',
  'Finish the blank lines on the Worldpay card processing questionnaire. The answers for this service are already on the sheet.',
  'Send both forms to Shaylen. Healius opens the Curaleaf Clinic, Curaleaf Laboratories and Holistic Health Hub accounts. The same PharmSmart button then opens the workspace.',
] as const;

export const PHARMSMART_ONBOARDING_PACKETS = [
  {
    href: '/onboarding/holistic-health-hub-brochure.pdf',
    title: 'Holistic Health Hub brochure',
    detail: 'Brochure',
    summary: 'The July 2026 community pharmacy brochure. Holistic Health Hub is the private medical cannabis service patients see, and the platform the pharmacy team uses. Curaleaf Clinic prescribes. The pharmacy dispenses and keeps the margin. Healius handles referral admin and support in between. There is no monthly fee, no setup fee and no lock-in. Optional Worldpay payments are 1.3% plus 20p per transaction, with no monthly or minimum fee. Patients pay before stock is ordered.',
  },
  {
    href: '/onboarding/curaleaf-healius-new-account-form.pdf',
    title: 'Curaleaf account onboarding checklist',
    detail: 'Form',
    summary: 'Curaleaf document ROK0001, revision 5, issued and effective 7 April 2025, related to SOP004. It is blank. Complete every line and supply a valid copy of the controlled drug licence.',
    still: [
      'Pharmacist or contact name',
      'Pharmacy name and registered company name',
      'Invoice address and delivery address',
      'GPhC number and WDA number',
      'Licence details',
      'Controlled drug licence, with a valid copy attached',
      'Pharmacy and accounts email addresses',
      'Pharmacy and accounts telephone numbers',
      'Fax number',
      'Signature and date',
    ],
  },
  {
    href: '/onboarding/worldpay-contract-information.xlsx',
    title: 'Worldpay card processing questionnaire',
    detail: 'Form',
    summary: 'The card-processing questionnaire Worldpay uses to open the pharmacy merchant account. These answers are already entered for this service. The percentage rows must each total 100%.',
    entered: [
      { label: 'Nature of business', value: '47730 — Dispensing chemist in specialised stores' },
      { label: 'Card terminal', value: 'Not required' },
      { label: 'Face to face with customers', value: 'Blank' },
      { label: 'Over the phone with customers', value: 'Blank' },
      { label: 'Via the internet (e-commerce)', value: '1' },
      { label: 'Customer pays and receives the medicine immediately', value: 'Blank' },
      { label: 'Customer pays and receives the medicine in 1–3 days', value: '1' },
      { label: 'Customer pays and receives the medicine in 3–5 days', value: 'Blank' },
      { label: 'Customer pays and receives the medicine in 5 or more days', value: 'Blank' },
      { label: 'Annual card processing turnover', value: '£250,000' },
      { label: 'Average transaction value', value: '£187' },
      { label: 'American Express', value: 'No' },
      { label: 'Where cards are accepted', value: 'Sales are limited to the UK only. No sales to the United States.' },
      { label: 'Licensing and supply', value: 'Licensed where the pharmacy operates. Controls limit dispensing and shipping to where it is legally permitted. Prescription medicines are not exported where that is not allowed.' },
      { label: 'Card scheme registration', value: 'Mastercard is not used. Visa’s $950 USD card-not-present fee is waived with GPhC accreditation. The fee is once per legal entity, not once per outlet.' },
      { label: 'Online consultations', value: 'No online consultations are provided by the pharmacy.' },
    ],
    still: [
      'Legal name, trading name, contact name, position and phone',
      'Business type, registration number and registered address',
      'Pharmacy GPhC number',
      'Trading address, landline, mobile, business email, website, VAT number and the date trading started',
      'Each principal: name, date of birth, nationality, home address, years at that address, mobile, email and shareholding',
      'Annual business turnover',
      'Bank name, name on the account, account number and sort code',
    ],
  },
] as const;

export function pharmsmartRedeemNext(result: PharmsmartLoginResult):
  | { action: 'welcome'; welcome: PharmsmartWelcome }
  | { action: 'setup' }
  | { action: 'session'; customToken: string } {
  if (result.status === 'welcome') {
    return {
      action: 'welcome',
      welcome: {
        email: result.email,
        firstName: result.firstName,
        lastName: result.lastName,
      },
    };
  }
  if (result.status === 'setup') return { action: 'setup' };
  return { action: 'session', customToken: result.customToken };
}

export function pharmsmartOnboardingBookingUrl(
  person: PharmsmartWelcome,
  options?: { embed?: boolean; hostname?: string },
) {
  const url = new URL(PHARMSMART_ONBOARDING_CALENDLY);
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  if (name) url.searchParams.set('name', name);
  if (person.email) url.searchParams.set('email', person.email);
  if (options?.embed) {
    url.searchParams.set('embed_type', 'Inline');
    if (options.hostname) url.searchParams.set('embed_domain', options.hostname);
  }
  return url.toString();
}
let pharmsmartSignInLink = false;

export function pharmsmartLoginQuery(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const token = params.get('token')?.trim() ?? '';
  params.delete('token');
  const rest = params.toString();
  return {
    token,
    hasToken: token.length > 0,
    searchWithoutToken: rest ? `?${rest}` : '',
  };
}

export function rememberPharmsmartLogin(search: string) {
  if (pharmsmartLoginQuery(search).hasToken) pharmsmartSignInLink = true;
  return pharmsmartSignInLink;
}

export function resetPharmsmartLoginNotice() {
  pharmsmartSignInLink = false;
}
