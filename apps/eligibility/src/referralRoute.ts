import { normaliseReferralToken } from '../../../services/api-sql/src/domain/referrals/referral-token.ts';

export type EligibilityReferralRoute =
  | { kind: 'general' }
  | { kind: 'token'; token: string }
  | { kind: 'invalid-token' };

/** Printed pharmacy QR/links used a second `?` instead of `&`: `/?mode=eligibility?token=…`. */
export function normaliseEligibilitySearch(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const stone = raw.match(/^mode=eligibility\?token=([^&]*)(.*)$/i);
  if (!stone) return search.startsWith('?') || search === '' ? search : `?${search}`;
  const token = stone[1];
  const rest = stone[2] ? (stone[2].startsWith('&') ? stone[2] : `&${stone[2]}`) : '';
  return `?mode=eligibility&token=${token}${rest}`;
}

export function parseEligibilityReferralRoute(search: string): EligibilityReferralRoute {
  const parameters = new URLSearchParams(normaliseEligibilitySearch(search));
  if (!parameters.has('token')) return { kind: 'general' };
  const tokens = parameters.getAll('token');
  if (tokens.length !== 1) return { kind: 'invalid-token' };
  const token = normaliseReferralToken(tokens[0] ?? '');
  return token ? { kind: 'token', token } : { kind: 'invalid-token' };
}
