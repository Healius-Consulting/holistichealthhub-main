const PLATFORM_TEST_PHARMACY_IDS = new Set([
  '70913a3071c34a41952ed532927af58c',
  'f486a221223644a5b072f06de399ab0e',
]);

function organisationIdKey(id: string) {
  return id.replaceAll('-', '').toLowerCase();
}

/** Primary and Alternate — always-on platform Test pharmacies, not dummy Training. */
export function isPlatformTestOrganisation(organisation: {
  id: string;
  name?: string | null;
  tradingName?: string | null;
  classification?: string | null;
} | null | undefined) {
  if (!organisation?.id) return false;
  return PLATFORM_TEST_PHARMACY_IDS.has(organisationIdKey(organisation.id));
}

/**
 * Same ID set as `isPlatformTestOrganisation`.
 * Use only to hide them from the public directory and HHH referral finance.
 */
export function isTrainingDirectoryOrganisation(organisation: {
  id: string;
  name?: string | null;
  tradingName?: string | null;
  classification?: string | null;
} | null | undefined) {
  return isPlatformTestOrganisation(organisation);
}
