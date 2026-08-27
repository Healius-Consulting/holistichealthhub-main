/**
 * How long a cached Curaleaf catalogue is trusted before it is revalidated.
 *
 * Fifteen minutes is the window the pharmacy agreed: long enough that moving
 * between Formulary, Create order and Settings does not re-fetch thousands of
 * packs on every navigation, short enough that a price or stock change made at
 * Curaleaf reaches the dispensing bench within one prescription's work.
 */
export const CATALOGUE_TTL_MS = 15 * 60 * 1000;

/**
 * Whether a cached catalogue should be revalidated.
 *
 * Never having fetched, and an unparseable or future-dated timestamp, all count
 * as stale: an unknown age is not evidence of freshness, and a clock that has
 * jumped should cost one extra fetch rather than pin stale prices in place.
 */
export function catalogueIsStale(updatedAt: string | null, now: number = Date.now()): boolean {
  if (!updatedAt) return true;
  const fetchedAt = Date.parse(updatedAt);
  if (!Number.isFinite(fetchedAt)) return true;
  const age = now - fetchedAt;
  if (age < 0) return true;
  return age >= CATALOGUE_TTL_MS;
}
