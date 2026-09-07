import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../bootstrap/config.js';

function secret(): string {
  return config.IP_HASH_SECRET ?? `${config.FIREBASE_PROJECT_ID}:default-ip-secret`;
}

/**
 * Signs the hashed contact so an unsubscribe link cannot be forged to opt someone
 * else out, and carries no readable address in the URL. Deliberately not expiring:
 * PECR gives no deadline, and an old message must still be able to opt you out.
 */
export function signUnsubscribe(contactHash: string): string {
  return createHmac('sha256', secret()).update(`unsubscribe:${contactHash}`).digest('hex');
}

export function verifyUnsubscribe(contactHash: string, signature: string): boolean {
  if (typeof contactHash !== 'string' || typeof signature !== 'string') return false;
  const expected = Buffer.from(signUnsubscribe(contactHash));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function unsubscribeUrl(origin: string, contactHash: string): string {
  const url = new URL('/unsubscribe', origin);
  url.searchParams.set('c', contactHash);
  url.searchParams.set('s', signUnsubscribe(contactHash));
  return url.toString();
}
