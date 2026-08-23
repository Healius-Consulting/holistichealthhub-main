import { formatOrganisationAddress } from '../../domain/geography/address.js';
import { geocodePostcode, normaliseUkPostcode } from '../../domain/geography/postcode.js';
import type { DirectoryRepositoryPort } from '../../repositories/ports/directory.port.js';
import type { OrganisationRecord, UpdateOrganisationProfileInput } from '../../repositories/ports/organisation.port.js';

export async function buildOrganisationProfileUpdate(
  current: OrganisationRecord,
  input: {
    tradingName?: string;
    name?: string;
    gphcNumber?: string;
    superintendent?: string;
    address?: string;
    addressLine1?: string;
    addressLine2?: string;
    locality?: string;
    county?: string;
    postcode?: string;
    mainContactName?: string;
    mainContactPhone?: string;
    mainContactEmail?: string;
  },
): Promise<UpdateOrganisationProfileInput> {
  const addressLine1 = input.addressLine1?.trim() || current.addressLine1 || '';
  const addressLine2 = input.addressLine2?.trim() || current.addressLine2 || null;
  const locality = input.locality?.trim() || current.locality || '';
  const county = input.county?.trim() || current.county || null;
  const postcodeInput = input.postcode?.trim() || current.postcode || '';
  const postcode = postcodeInput ? normaliseUkPostcode(postcodeInput) : null;
  const shouldGeocode = Boolean(postcode) && postcode !== current.postcode;
  const geocode = shouldGeocode && postcode ? await geocodePostcode(postcode) : null;
  const formattedAddress = formatOrganisationAddress({ addressLine1, addressLine2, locality, county, postcode });

  return {
    tradingName: input.tradingName ?? current.tradingName,
    name: input.name ?? current.name,
    gphcNumber: input.gphcNumber ?? current.gphcNumber,
    superintendentName: input.superintendent ?? current.superintendentName,
    address: input.address?.trim() || formattedAddress || current.address,
    addressLine1: addressLine1 || null,
    addressLine2,
    locality: locality || null,
    county,
    postcode,
    latitude: geocode?.status === 'matched' ? geocode.latitude : current.latitude,
    longitude: geocode?.status === 'matched' ? geocode.longitude : current.longitude,
    mainContactName: input.mainContactName ?? current.mainContactName,
    mainContactPhone: input.mainContactPhone ?? current.mainContactPhone,
    mainContactEmail: input.mainContactEmail === '' ? null : (input.mainContactEmail ?? current.mainContactEmail),
  };
}

export async function syncDirectoryProfileFromOrganisation(
  directoryRepo: Pick<DirectoryRepositoryPort, 'upsertProfile'>,
  organisationId: string,
  profile: UpdateOrganisationProfileInput,
) {
  if (!profile.addressLine1 || !profile.locality || !profile.postcode || !profile.mainContactEmail) return;
  await directoryRepo.upsertProfile({
    organisationId,
    tradingName: profile.tradingName,
    gphcNumber: profile.gphcNumber,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    locality: profile.locality,
    postcode: profile.postcode,
    publicEmail: profile.mainContactEmail,
    publicPhone: profile.mainContactPhone,
    latitude: profile.latitude,
    longitude: profile.longitude,
  });
}
