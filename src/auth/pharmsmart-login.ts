import type { PharmsmartLoginResult } from '../shared/api';
import type { PharmsmartWelcome } from './types';

/**
 * A PharmSmart login is only the opaque `?token=` value.
 * Email and name in the query string are not credentials. The token is removed
 * from the address bar as soon as it has been read for the server redemption.
 */

export const PHARMSMART_ONBOARDING_CALENDLY = 'https://calendly.com/spatel-72k/30min';

export const PHARMSMART_ONBOARDING_PACKETS = [
  { href: '/onboarding/holistic-health-hub-brochure.pdf', title: 'Platform brochure', detail: 'PDF' },
  { href: '/onboarding/worldpay-contract-information.xlsx', title: 'Worldpay contract information', detail: 'Spreadsheet' },
  { href: '/onboarding/curaleaf-healius-new-account-form.pdf', title: 'New account form', detail: 'PDF' },
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
