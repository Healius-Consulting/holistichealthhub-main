/**
 * What Display settings shows about the running build.
 *
 * Deliberately just an identifier. An earlier design compared the loaded bundle
 * against the latest deployed one and warned when they differed, which fired on
 * every deploy and taught staff to ignore it. Support only ever needs the id, so
 * the id is all that is shown.
 */

/** Only the two portal bundles carry a build id; public and eligibility do not. */
export function isPortalSurface(surface: string | undefined): boolean {
  return surface === 'pharmacy' || surface === 'admin';
}

/**
 * The build id to display, or null when there is nothing trustworthy to show.
 * A missing or placeholder id is omitted rather than shown as "unknown", which
 * would look like a fault rather than an absence.
 */
export function portalBuildLabel(buildId: string | undefined, surface: string | undefined): string | null {
  if (!isPortalSurface(surface)) return null;
  const trimmed = buildId?.trim();
  if (!trimmed || trimmed === 'undefined') return null;
  return trimmed;
}
