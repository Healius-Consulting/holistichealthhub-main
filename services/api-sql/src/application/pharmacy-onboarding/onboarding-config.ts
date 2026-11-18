import { config } from '../../bootstrap/config.js';

/**
 * Partner onboarding settings that change without a code change. Read on each use,
 * so an environment override applies without a restart in tests.
 */

function addresses(name: string, fallback: string[]) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const list = raw.split(',').map(address => address.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** Curaleaf Laboratories, who open the pharmacy's account from the application email. */
export function curaleafApplicationTo() {
  return addresses('CURALEAF_APPLICATION_TO', [
    'robbie.allison@curaleaflaboratories.co.uk',
    'ellis.walters@curaleaflaboratories.co.uk',
  ]);
}

/** Copied on the Curaleaf application email: this is how HHH sees each new application. */
export function curaleafApplicationCc() {
  return addresses('CURALEAF_APPLICATION_CC', ['spatel@healiusconsulting.com']);
}

/** The Worldpay form goes here only, never to Worldpay. */
export function worldpayFormRecipients() {
  return addresses('WORLDPAY_FORM_TO', ['admin@healiusconsulting.com']);
}

/**
 * The Partner Terms version a pharmacy accepts at sign-up. Change it when the Terms
 * text changes; each acceptance row records the version it was given.
 */
export function partnerTermsVersion() {
  return process.env.PARTNER_TERMS_VERSION?.trim() || 'placeholder-2026-11-18';
}

/** Signs the PharmSmart tickets: the same secret the PharmSmart sign-in uses. */
export function pharmsmartTicketSecret() {
  return config.IP_HASH_SECRET ?? `${config.FIREBASE_PROJECT_ID}:pharmsmart-sso`;
}
