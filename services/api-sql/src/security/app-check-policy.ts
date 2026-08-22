import { config } from '../bootstrap/config.js';

export function appCheckIsRequired(requirement = config.REQUIRE_APP_CHECK): boolean {
  // Opt-in only. Production-on takes down eligibility when reCAPTCHA
  // Enterprise loads but does not mint a token Firebase will exchange.
  return requirement === 'true';
}

export function isAppCheckExempt(method: string, path: string): boolean {
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && (path === '/health' || path.endsWith('/health'))) return true;
  if (method === 'POST' && path.includes('/public/payments/worldpay/webhook')) return true;
  return false;
}
