import { normaliseEligibilitySearch, parseEligibilityReferralRoute } from '../../eligibility/src/referralRoute.ts';

export type PublicView = 'site' | 'eligibility' | 'payment-complete' | 'payment-cancelled';

export const CANONICAL_ELIGIBILITY_ORIGIN = 'https://holistichealthhub.cc';
export const LEGACY_PUBLIC_HOST = 'holistichealthhub.live';
/** Printed pharmacy QR host. Live traffic is a Cloudflare 301 onto `.cc`; keep this so a missed DNS change still canonicalises. Never include staging.thinktimeless.co.uk. */
const LEGACY_ELIGIBILITY_HOSTS = new Set([
  LEGACY_PUBLIC_HOST,
  'hhh.thinktimeless.co.uk',
  'www.hhh.thinktimeless.co.uk',
]);
const ALLOWED_ATTRIBUTION_PARAMETERS = new Set(['source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);

export function resolvePublicView(pathname: string, search: string): PublicView {
  const path = pathname.replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(normaliseEligibilitySearch(search));

  // Pharmacy QR packs issued before the standalone eligibility path used the
  // public root with ?mode=eligibility. Keep that URL working indefinitely so
  // printed codes do not need to be recalled or replaced.
  if (path === '/' && query.get('mode') === 'eligibility') return 'eligibility';
  if (path === '/eligibility') return 'eligibility';
  if (
    path === '/payment/success' ||
    path === '/payments/complete' ||
    path === '/payment/complete' ||
    path === '/payment-success' ||
    path === '/payment/status' ||
    path === '/order/confirmed'
  ) return 'payment-complete';
  if (
    path === '/payment/cancelled' ||
    path === '/payments/cancelled' ||
    path === '/payment-cancelled' ||
    path === '/payment/declined' ||
    path === '/payment-declined' ||
    path === '/payment/failed'
  ) return 'payment-cancelled';
  return 'site';
}

export type PublicHeaderVariant = 'site' | 'eligibility' | 'token';

export function publicHeaderVariant(pathname: string, search: string): PublicHeaderVariant {
  const view = resolvePublicView(pathname, search);
  if (view !== 'eligibility') return 'site';
  return parseEligibilityReferralRoute(search).kind === 'token' ? 'token' : 'eligibility';
}

export function canonicalEligibilityRedirect(hostname: string, pathname: string, search: string) {
  const host = hostname.toLowerCase();
  if (!LEGACY_ELIGIBILITY_HOSTS.has(host)) return null;
  if (resolvePublicView(pathname, search) !== 'eligibility') return null;
  const query = new URLSearchParams(normaliseEligibilitySearch(search));
  if (!query.get('token')) return null;
  for (const key of [...query.keys()]) {
    if (key !== 'token' && !ALLOWED_ATTRIBUTION_PARAMETERS.has(key)) query.delete(key);
  }
  const destination = new URL('/eligibility', CANONICAL_ELIGIBILITY_ORIGIN);
  destination.search = query.toString();
  return destination.toString();
}
