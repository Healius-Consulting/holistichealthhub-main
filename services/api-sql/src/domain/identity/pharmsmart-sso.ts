/**
 * Pharmsmart's auto-login token is not redeemable here.
 * Their own login page posts the opaque query token to CannabisSmart `/auto-login`.
 * It is not a JWT, and this platform has no algorithm, shared secret, expiry, or claim names.
 * Their pharmacy-details sample is an unauthenticated form post, so this server must not call it.
 * Staff access stays on the existing invitation until that contract exists.
 */

export const PHARMSMART_SSO_MISSING = [
  'token_algorithm',
  'shared_secret',
  'token_expiry',
  'claim_names',
  'pharmacy_details_schema',
  'server_credential',
] as const;

export type PharmsmartSsoGap = (typeof PHARMSMART_SSO_MISSING)[number];

export type PharmsmartSsoContract = {
  redeemable: false;
  pharmacyDetailsAuthenticated: false;
  missing: readonly PharmsmartSsoGap[];
};

export function pharmsmartSsoContract(): PharmsmartSsoContract {
  return {
    redeemable: false,
    pharmacyDetailsAuthenticated: false,
    missing: PHARMSMART_SSO_MISSING,
  };
}

export type ExistingPharmacyLink = {
  id: string;
  gphcNumber: string;
  pharmsmartPharmacyId?: string | null;
};

export type PharmacyLinkIdentity = {
  gphcNumber?: string | null;
  pharmsmartPharmacyId?: string | null;
};

export type ExistingPharmacyMatch =
  | { status: 'matched'; organisationId: string }
  | { status: 'unmatched'; reason: 'IDENTITY_REQUIRED' | 'NOT_FOUND' | 'AMBIGUOUS' };

function identityValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function uniqueMatch(pharmacies: readonly ExistingPharmacyLink[], predicate: (pharmacy: ExistingPharmacyLink) => boolean) {
  const matches = pharmacies.filter(predicate);
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous' as const;
  return matches[0] ?? null;
}

/**
 * Attach a Pharmsmart login to a pharmacy that already exists.
 * GPhC or a stored Pharmsmart pharmacy id are the only keys. A trading name is not an input,
 * and this never returns a new organisation to insert.
 */
export function matchExistingPharmacyForPharmsmart(
  pharmacies: readonly ExistingPharmacyLink[],
  identity: PharmacyLinkIdentity,
): ExistingPharmacyMatch {
  const gphcNumber = identityValue(identity.gphcNumber);
  const pharmsmartPharmacyId = identityValue(identity.pharmsmartPharmacyId);
  if (!gphcNumber && !pharmsmartPharmacyId) {
    return { status: 'unmatched', reason: 'IDENTITY_REQUIRED' };
  }

  const byGphc = gphcNumber
    ? uniqueMatch(pharmacies, pharmacy => identityValue(pharmacy.gphcNumber) === gphcNumber)
    : null;
  const byPharmsmartId = pharmsmartPharmacyId
    ? uniqueMatch(pharmacies, pharmacy => identityValue(pharmacy.pharmsmartPharmacyId) === pharmsmartPharmacyId)
    : null;

  if (byGphc === 'ambiguous' || byPharmsmartId === 'ambiguous') {
    return { status: 'unmatched', reason: 'AMBIGUOUS' };
  }
  if (byGphc && byPharmsmartId && byGphc.id !== byPharmsmartId.id) {
    return { status: 'unmatched', reason: 'AMBIGUOUS' };
  }
  const match = byGphc ?? byPharmsmartId;
  if (!match) return { status: 'unmatched', reason: 'NOT_FOUND' };
  return { status: 'matched', organisationId: match.id };
}

/**
 * Invitation emails stay the access list while Pharmsmart redemption is unavailable.
 * When redemption is allowed, the SSO email joins that same pharmacy list and is not a second pharmacy.
 */
export function pharmacyStaffEmails(input: {
  invitedEmails: readonly string[];
  ssoEmail?: string | null;
  ssoRedeemable: boolean;
}) {
  const invited = input.invitedEmails
    .map(email => email.trim().toLowerCase())
    .filter(email => email.length > 0);
  if (!input.ssoRedeemable) return invited;
  const ssoEmail = input.ssoEmail?.trim().toLowerCase();
  if (!ssoEmail || invited.includes(ssoEmail)) return invited;
  return [...invited, ssoEmail];
}
