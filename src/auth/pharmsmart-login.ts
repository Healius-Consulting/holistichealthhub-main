import type { OnboardingHoldMessage, PharmsmartLoginResult } from '../shared/api';
import { awaitingMessageFrom, holdMessageFromDetails } from '../onboarding/branchOnboarding';
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
  lede: 'Holistic Health Hub is a private medical cannabis service that runs through your pharmacy.',
  facts: [
    'No cost to join',
    'No monthly fees or lock-in',
    'You keep the full margin',
  ],
  steps: [
    { title: 'Intake', body: 'A patient fills in a short eligibility form through your pharmacy\'s own link or QR code.' },
    { title: 'Remote onboarding', body: 'Our team checks eligibility and refers the patient to Curaleaf Clinic.' },
    { title: 'Clinical review', body: 'A specialist consults remotely and sends the prescription to your pharmacy.' },
    { title: 'Payment and ordering', body: 'You send the patient a payment link. Stock is ordered once they pay.' },
    { title: 'Dispense and collect', body: 'You dispense, and the patient collects from your pharmacy each month.' },
  ],
} as const;

/** Pharmsmart pharmacies launch Holistic Health Hub from inside Pharmsmart (19 Nov 2026 brief, section 2). */
export const PHARMSMART_LOGIN_URL = 'https://pharmsmart.co.uk/login.php';

/**
 * The "In partnership with" logos under the hero (brief section 5; FB-01, FB-02).
 * Curaleaf: the official vector wordmark, recoloured to the teal of Curaleaf's supplied
 * reference file. Pharmsmart: HHH's supplied pharmsmart-logo.png, unaltered.
 * Sizes differ on purpose: Curaleaf's thin lowercase wordmark is set larger than Pharmsmart's
 * bold one so the two carry the same visual weight. Width and height stop the row shifting on load.
 */
export const PARTNERSHIP_LOGOS = [
  { src: '/partners/curaleaf.svg', alt: 'Curaleaf', width: 86, height: 30 },
  { src: '/partners/pharmsmart.png', alt: 'Pharmsmart', width: 121, height: 22 },
] as const;

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
        // On hold (a request, or an activated branch): the message for the reason, merged for the branch.
        hold: holdMessageFromDetails<OnboardingHoldMessage>(result),
        // Waiting for activation: the admin-edited wording, or the page's default when missing.
        awaiting: awaitingMessageFrom(result.awaiting),
        termsRequired: Boolean(result.termsRequired),
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
