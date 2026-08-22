import { formatOrganisationAddress } from '../../domain/geography/address.js';

export interface DirectoryProfileRecord {
  organisationId: string;
  tradingName: string;
  gphcNumber: string;
  addressLine1: string;
  addressLine2: string | null;
  locality: string;
  postcode: string;
  publicEmail: string;
  publicPhone: string | null;
  website?: string | null;
  deliveryCapability: 'NONE' | 'NATIONWIDE' | 'POSTCODE_AREAS' | 'RADIUS_MILES';
  collectionAvailable: boolean;
  deliverySummary: string | null;
  intakeState: 'AVAILABLE' | 'LIMITED' | 'FULL';
  latitude: number | null;
  longitude: number | null;
  lifecycle: 'DRAFT' | 'READY_FOR_REVIEW' | 'PUBLISHED' | 'PAUSED' | 'UNPUBLISHED';
  acceptingNewPatients: boolean;
}

export interface UpsertDirectoryProfileInput {
  organisationId: string;
  tradingName: string;
  gphcNumber: string;
  addressLine1: string;
  addressLine2?: string | null;
  locality: string;
  postcode: string;
  publicEmail: string;
  publicPhone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface DirectoryRepositoryPort {
  findProfileByOrganisationId(organisationId: string): Promise<DirectoryProfileRecord | null>;
  listEligibleProfiles(): Promise<DirectoryProfileRecord[]>;
  upsertProfile(input: UpsertDirectoryProfileInput): Promise<void>;
}

export function directoryAddressSummary(profile: Pick<DirectoryProfileRecord, 'addressLine1' | 'locality' | 'postcode'>) {
  return [profile.addressLine1, profile.locality, profile.postcode].filter(Boolean).join(', ');
}

export function directoryWebsiteLabel(domains: string[] | null | undefined) {
  const raw = domains?.find(domain => domain.trim())?.trim();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function organisationAddressSummary(organisation: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  locality?: string | null;
  county?: string | null;
  postcode?: string | null;
  address: string;
}) {
  const structured = formatOrganisationAddress(organisation);
  return structured || organisation.address;
}
