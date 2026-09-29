const ISSUED_TOKEN = /^[A-Za-z0-9_-]{12,160}$/;
const LEGACY_BASE64_TOKEN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Tokens we issue are url-safe. PharmSmart eligibility links are standard base64,
 * and a query string often turns `+` into a space before we see the value.
 * Returns the token to hash, or null when it matches neither form.
 */
export function normaliseReferralToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (ISSUED_TOKEN.test(trimmed)) return trimmed;
  const restored = trimmed.replaceAll(' ', '+');
  if (restored.length < 12 || restored.length > 160 || restored.length % 4 !== 0) return null;
  if (!LEGACY_BASE64_TOKEN.test(restored)) return null;
  return restored;
}
