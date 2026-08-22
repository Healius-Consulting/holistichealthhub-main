import { dataConnect } from '../../bootstrap/firebase.js';
import { isPubliclyListedPharmacy } from '../../domain/directory/public-listing.js';
import { parseLegacyAddressBlob } from '../../domain/geography/address.js';
import { geocodePostcodes, normaliseUkPostcode } from '../../domain/geography/postcode.js';
import { uuidKey } from '../../domain/common/uuid.js';
import {
  directoryWebsiteLabel,
  type DirectoryProfileRecord,
  type DirectoryRepositoryPort,
  type UpsertDirectoryProfileInput,
} from '../ports/directory.port.js';

type DirectoryOrganisationRow = {
  id: string;
  name: string;
  tradingName: string;
  gphcNumber: string;
  address: string;
  addressLine1: string | null;
  addressLine2: string | null;
  locality: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  mainContactEmail: string | null;
  mainContactPhone: string | null;
  websiteDomains?: string[] | null;
  status: 'ONBOARDING' | 'INTAKE_LIVE' | 'LIVE' | 'PAUSED';
  classification: 'STANDARD' | 'TRAINING' | 'ALLOCATION_HOLDING';
  archivedAt: string | null;
};

const DIRECTORY_PROFILE_FIELDS = `
  organisationId
  tradingName
  gphcNumber
  addressLine1
  addressLine2
  locality
  postcode
  publicEmail
  publicPhone
  deliveryCapability
  collectionAvailable
  deliverySummary
  intakeState
  latitude
  longitude
  lifecycle
  acceptingNewPatients
`;

const GET_DIRECTORY_PROFILE_GQL = `
  query GetDirectoryProfile($organisationId: UUID!) {
    pharmacyDirectoryProfile(key: { organisationId: $organisationId }) {
      ${DIRECTORY_PROFILE_FIELDS}
    }
  }
`;

const LIST_DIRECTORY_PROFILES_GQL = `
  query ListDirectoryProfiles {
    pharmacyDirectoryProfiles(limit: 500) {
      ${DIRECTORY_PROFILE_FIELDS}
    }
  }
`;

const LIST_DIRECTORY_ORGANISATIONS_GQL = `
  query ListDirectoryOrganisations {
    organisations(
      where: { archivedAt: { isNull: true } }
    ) {
      id
      name
      tradingName
      gphcNumber
      address
      addressLine1
      addressLine2
      locality
      postcode
      latitude
      longitude
      mainContactEmail
      mainContactPhone
      websiteDomains
      status
      classification
      archivedAt
    }
  }
`;

const UPSERT_DIRECTORY_PROFILE_GQL = `
  mutation UpsertDirectoryProfile(
    $organisationId: UUID!
    $tradingName: String!
    $gphcNumber: String!
    $addressLine1: String!
    $addressLine2: String
    $locality: String!
    $postcode: String!
    $publicEmail: String!
    $publicPhone: String
    $latitude: Float
    $longitude: Float
    $lifecycle: DirectoryLifecycle!
    $deliveryCapability: DeliveryCapability!
    $collectionAvailable: Boolean!
    $intakeState: IntakeState!
    $acceptingNewPatients: Boolean!
  ) {
    pharmacyDirectoryProfile_upsert(data: {
      organisationId: $organisationId
      tradingName: $tradingName
      gphcNumber: $gphcNumber
      addressLine1: $addressLine1
      addressLine2: $addressLine2
      locality: $locality
      postcode: $postcode
      publicEmail: $publicEmail
      publicPhone: $publicPhone
      latitude: $latitude
      longitude: $longitude
      lifecycle: $lifecycle
      deliveryCapability: $deliveryCapability
      collectionAvailable: $collectionAvailable
      intakeState: $intakeState
      acceptingNewPatients: $acceptingNewPatients
    })
  }
`;

function structuredAddress(organisation: DirectoryOrganisationRow, profile: DirectoryProfileRecord | null) {
  const parsed = parseLegacyAddressBlob(organisation.address);
  return {
    addressLine1: profile?.addressLine1 || organisation.addressLine1 || parsed.addressLine1 || organisation.address,
    addressLine2: profile?.addressLine2 ?? organisation.addressLine2 ?? parsed.addressLine2 ?? null,
    locality: profile?.locality || organisation.locality || parsed.locality || '',
    postcode: profile?.postcode || organisation.postcode || parsed.postcode || '',
  };
}

function toListedProfile(
  organisation: DirectoryOrganisationRow,
  profile: DirectoryProfileRecord | null,
  coords: { latitude: number; longitude: number },
): DirectoryProfileRecord {
  const address = structuredAddress(organisation, profile);
  return {
    organisationId: organisation.id,
    tradingName: profile?.tradingName || organisation.tradingName,
    gphcNumber: profile?.gphcNumber || organisation.gphcNumber,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    locality: address.locality,
    postcode: address.postcode,
    publicEmail: profile?.publicEmail || organisation.mainContactEmail || '',
    publicPhone: profile?.publicPhone ?? organisation.mainContactPhone,
    website: directoryWebsiteLabel(organisation.websiteDomains),
    deliveryCapability: profile?.deliveryCapability ?? 'NONE',
    collectionAvailable: profile?.collectionAvailable ?? true,
    deliverySummary: profile?.deliverySummary ?? null,
    intakeState: profile?.intakeState ?? 'AVAILABLE',
    latitude: coords.latitude,
    longitude: coords.longitude,
    lifecycle: profile?.lifecycle ?? 'DRAFT',
    acceptingNewPatients: profile?.acceptingNewPatients ?? true,
  };
}

function lookupGeocode(
  postcode: string,
  geocoded: Map<string, { latitude: number; longitude: number }>,
) {
  try {
    return geocoded.get(normaliseUkPostcode(postcode)) ?? null;
  } catch {
    return null;
  }
}

export class SqlDirectoryRepository implements DirectoryRepositoryPort {
  async findProfileByOrganisationId(organisationId: string): Promise<DirectoryProfileRecord | null> {
    const result = await dataConnect.executeGraphql<{ pharmacyDirectoryProfile: DirectoryProfileRecord | null }, any>(
      GET_DIRECTORY_PROFILE_GQL,
      { variables: { organisationId } },
    );
    return result.data.pharmacyDirectoryProfile ?? null;
  }

  async listEligibleProfiles(): Promise<DirectoryProfileRecord[]> {
    const [profileResult, organisationResult] = await Promise.all([
      dataConnect.executeGraphql<{ pharmacyDirectoryProfiles: DirectoryProfileRecord[] }, any>(LIST_DIRECTORY_PROFILES_GQL),
      dataConnect.executeGraphql<{ organisations: DirectoryOrganisationRow[] }, any>(LIST_DIRECTORY_ORGANISATIONS_GQL),
    ]);
    const profilesByOrganisation = new Map(
      (profileResult.data.pharmacyDirectoryProfiles ?? []).map(profile => [uuidKey(profile.organisationId), profile]),
    );
    const candidates = (organisationResult.data.organisations ?? [])
      .filter(isPubliclyListedPharmacy)
      .map(organisation => {
        const profile = profilesByOrganisation.get(uuidKey(organisation.id)) ?? null;
        if (profile?.lifecycle === 'PAUSED' || profile?.intakeState === 'FULL') return null;
        return { organisation, profile, address: structuredAddress(organisation, profile) };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

    const missingPostcodes = candidates
      .filter(candidate => typeof (candidate.profile?.latitude ?? candidate.organisation.latitude) !== 'number'
        || typeof (candidate.profile?.longitude ?? candidate.organisation.longitude) !== 'number')
      .map(candidate => candidate.address.postcode)
      .filter(Boolean);
    const geocoded = missingPostcodes.length ? await geocodePostcodes(missingPostcodes) : new Map();

    const listed: DirectoryProfileRecord[] = [];
    for (const candidate of candidates) {
      const coords = (
        typeof (candidate.profile?.latitude ?? candidate.organisation.latitude) === 'number'
        && typeof (candidate.profile?.longitude ?? candidate.organisation.longitude) === 'number'
      )
        ? {
          latitude: (candidate.profile?.latitude ?? candidate.organisation.latitude) as number,
          longitude: (candidate.profile?.longitude ?? candidate.organisation.longitude) as number,
        }
        : lookupGeocode(candidate.address.postcode, geocoded);
      if (!coords) continue;
      const record = toListedProfile(candidate.organisation, candidate.profile, coords);
      listed.push(record);
      const alreadyPersisted = typeof candidate.profile?.latitude === 'number' && typeof candidate.profile?.longitude === 'number';
      if (!alreadyPersisted && record.publicEmail && record.addressLine1 && record.locality && record.postcode) {
        void this.upsertProfile({
          organisationId: record.organisationId,
          tradingName: record.tradingName,
          gphcNumber: record.gphcNumber,
          addressLine1: record.addressLine1,
          addressLine2: record.addressLine2,
          locality: record.locality,
          postcode: record.postcode,
          publicEmail: record.publicEmail,
          publicPhone: record.publicPhone,
          latitude: record.latitude,
          longitude: record.longitude,
        }).catch(() => undefined);
      }
    }
    return listed;
  }

  async upsertProfile(input: UpsertDirectoryProfileInput): Promise<void> {
    const existing = await this.findProfileByOrganisationId(input.organisationId);
    await dataConnect.executeGraphql<any, any>(UPSERT_DIRECTORY_PROFILE_GQL, {
      variables: {
        organisationId: input.organisationId,
        tradingName: input.tradingName,
        gphcNumber: input.gphcNumber,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        locality: input.locality,
        postcode: input.postcode,
        publicEmail: input.publicEmail,
        publicPhone: input.publicPhone ?? null,
        latitude: input.latitude ?? existing?.latitude ?? null,
        longitude: input.longitude ?? existing?.longitude ?? null,
        lifecycle: existing?.lifecycle ?? 'DRAFT',
        deliveryCapability: existing?.deliveryCapability ?? 'NONE',
        collectionAvailable: existing?.collectionAvailable ?? true,
        intakeState: existing?.intakeState ?? 'AVAILABLE',
        acceptingNewPatients: existing?.acceptingNewPatients ?? true,
      },
    });
  }
}
