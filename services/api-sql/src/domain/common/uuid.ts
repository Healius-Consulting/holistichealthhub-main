import { createHash } from 'node:crypto';
import { z } from 'zod';

const COMPACT_UUID = /^[0-9a-f]{32}$/i;

export function asUuid(value: string): string {
  const compact = value.replaceAll('-', '').toLowerCase();
  if (!COMPACT_UUID.test(compact)) return value;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function uuidFromHex(hex: string): string {
  const compact = hex.replace(/[^0-9a-f]/gi, '').slice(0, 32).toLowerCase().padEnd(32, '0');
  return asUuid(compact);
}

export function uuidKey(value: string): string {
  return value.replaceAll('-', '').toLowerCase();
}

export function sameUuid(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return uuidKey(left) === uuidKey(right);
}

/**
 * A UUID made from a name, the same every time (version 5 style, SHA-1). For rows whose
 * upsert must name the table's generated `id` key but which are really identified by
 * other fields, such as a branch and an item code.
 */
export function nameBasedUuid(...parts: string[]): string {
  const hex = createHash('sha1').update(['hhh', ...parts].join('/')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return asUuid(hex.join(''));
}

/**
 * An id from a request (URL, body or query). Data Connect hands ids out without
 * hyphens and the browser sends them back as given, so accept either form and pass
 * the canonical hyphenated one on. Client-made keys (idempotency keys) stay z.uuid().
 */
export const uuidInput = z.string().trim().transform(asUuid).pipe(z.string().uuid());

/** Either form of a UUID, kept exactly as sent (for ids compared against stored ones with sameUuid). */
export const uuidLike = z.string().trim().refine(value => COMPACT_UUID.test(value.replaceAll('-', '')), 'Invalid UUID');
