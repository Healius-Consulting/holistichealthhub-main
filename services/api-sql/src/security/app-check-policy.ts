import { config } from '../bootstrap/config.js';

export function appCheckIsRequired(
  requirement = config.REQUIRE_APP_CHECK,
  nodeEnv = config.NODE_ENV,
): boolean {
  if (requirement === 'false') return false;
  if (requirement === 'true') return true;
  return nodeEnv === 'production';
}

export function isAppCheckExempt(method: string, path: string): boolean {
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && (path === '/health' || path.endsWith('/health'))) return true;
  if (method === 'POST' && path.includes('/public/payments/worldpay/webhook')) return true;
  return false;
}
