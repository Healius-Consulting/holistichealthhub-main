import type { PharmacyTenant } from '../../context/AppContext';

/** Address lines for a pharmacy, from its saved lines or, for older records, its one-line address. */
export function splitPharmacyAddress(organisation: Pick<PharmacyTenant, 'address' | 'addressLine1' | 'addressLine2' | 'locality' | 'postcode'>) {
  if (organisation.addressLine1 && organisation.locality && organisation.postcode) {
    return {
      addressLine1: organisation.addressLine1,
      addressLine2: organisation.addressLine2 ?? '',
      locality: organisation.locality,
      postcode: organisation.postcode,
    };
  }
  const raw = organisation.address?.trim() || '';
  const postcodeMatch = raw.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  const postcode = (organisation.postcode || postcodeMatch?.[1] || '').toUpperCase();
  const withoutPostcode = postcode
    ? raw.replace(new RegExp(postcode.replace(/\s+/g, '\\s*'), 'i'), '').replace(/[,\s]+$/, '')
    : raw;
  const parts = withoutPostcode.split(',').map(part => part.trim()).filter(Boolean);
  return {
    addressLine1: organisation.addressLine1 || parts[0] || raw,
    addressLine2: organisation.addressLine2 || (parts.length > 3 ? parts.slice(1, -2).join(', ') : ''),
    locality: organisation.locality || (parts.length >= 2 ? parts.at(parts.length >= 3 ? -2 : -1) ?? '' : ''),
    postcode,
  };
}
