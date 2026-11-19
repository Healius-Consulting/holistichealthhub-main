import type { PharmsmartLoginResult } from '../shared/api';
import type { PharmsmartWelcome } from './types';

/**
 * A PharmSmart login is only the opaque `?token=` value.
 * Email and name in the query string are not credentials. The token is removed
 * from the address bar as soon as it has been read for the server redemption.
 */

export const PHARMSMART_ONBOARDING_CALENDLY = 'https://calendly.com/spatel-72k/30min';

/**
 * DRAFT, 16 Nov 2026: taken from the client's brochure until they supply the page
 * pitch. Swap the wording here; the page reads nothing else.
 */
export const PHARMACY_ONBOARDING_PITCH = {
  eyebrow: 'For community pharmacies',
  title: 'The clinic prescribes. You dispense. We handle everything in between.',
  lede: 'Holistic Health Hub is a private medical cannabis service that runs through your pharmacy. Curaleaf Clinic assesses and prescribes, and you dispense on terms we have already negotiated with Curaleaf Laboratories.',
  facts: [
    'No cost to join',
    'No monthly fees or lock-in',
    'You keep the full margin',
  ],
  steps: [
    { title: 'Intake', body: 'A patient fills in a short eligibility form through your pharmacy\'s own link or QR code.' },
    { title: 'Remote onboarding', body: 'Our team checks eligibility and refers the patient to Curaleaf Clinic.' },
    { title: 'Clinical review', body: 'A specialist consults remotely and sends the prescription to your pharmacy.' },
    { title: 'Dispense and collect', body: 'You send a payment link, order on the platform, and the patient collects from you each month.' },
  ],
} as const;

export const PHARMACY_ONBOARDING_CHOICES = [
  { id: 'setup', label: 'Set up now' },
  { id: 'demo', label: 'Book a demo' },
  { id: 'later', label: 'Not yet' },
] as const;

export type PharmacyOnboardingChoice = typeof PHARMACY_ONBOARDING_CHOICES[number]['id'];

export const PHARMSMART_ONBOARDING_PACKETS = [
  {
    href: '/onboarding/holistic-health-hub-brochure.pdf',
    title: 'Brochure',
    detail: 'PDF',
    summary: 'Read about the service before you send the forms. It is for pharmacies that are not on the platform yet.',
    preview: 'pdf',
  },
  {
    href: '/onboarding/curaleaf-healius-new-account-form.pdf',
    title: 'Curaleaf account',
    detail: 'FORM',
    summary: 'Fill this in and submit it here.',
    action: 'submit',
    preview: 'pdf',
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
        gphcNumber: result.gphcNumber ?? null,
        pharmsmartPharmacyId: result.pharmsmartPharmacyId ?? null,
        prefill: result.prefill ?? {},
        onboardingRequest: result.onboardingRequest ?? null,
        termsRequest: result.termsRequest ?? null,
        pharmsmartTicket: result.pharmsmartTicket ?? null,
      },
    };
  }
  if (result.status === 'setup') return { action: 'setup' };
  return { action: 'session', customToken: result.customToken };
}

/** Tags a booking made from the portal's Onboarding queue; Calendly carries UTM values onto the booking. */
export const PORTAL_ONBOARDING_QUEUE_UTM = { source: 'hhh-portal', campaign: 'onboarding-queue' } as const;

export function pharmsmartOnboardingBookingUrl(
  person: Pick<PharmsmartWelcome, 'firstName' | 'lastName' | 'email'>,
  options?: { embed?: boolean; hostname?: string; utm?: { source: string; campaign: string } },
) {
  const url = new URL(PHARMSMART_ONBOARDING_CALENDLY);
  const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  if (name) url.searchParams.set('name', name);
  if (person.email) url.searchParams.set('email', person.email);
  if (options?.embed) {
    url.searchParams.set('embed_type', 'Inline');
    if (options.hostname) url.searchParams.set('embed_domain', options.hostname);
  }
  if (options?.utm) {
    url.searchParams.set('utm_source', options.utm.source);
    url.searchParams.set('utm_campaign', options.utm.campaign);
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
