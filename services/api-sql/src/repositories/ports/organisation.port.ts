export interface OrganisationRecord {
  id: string;
  companyId: string | null;
  name: string;
  tradingName: string;
  gphcNumber: string;
  superintendentName: string;
  mainContactName: string | null;
  mainContactPhone: string | null;
  mainContactEmail: string | null;
  address: string;
  addressLine1: string | null;
  addressLine2: string | null;
  locality: string | null;
  county: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  primaryColour: string;
  logoText: string;
  status: 'ONBOARDING' | 'INTAKE_LIVE' | 'LIVE' | 'PAUSED';
  classification: 'STANDARD' | 'TRAINING' | 'ALLOCATION_HOLDING';
  portalName: string;
  intakeEnabled: boolean;
  prescriptionEnabled: boolean;
  paymentsEnabled: boolean;
  supplierOrdersEnabled: boolean;
  patientsEnabled: boolean;
  resourcesEnabled: boolean;
  worldpayEnabled: boolean;
  defaultPaymentRoute: 'MANUAL' | 'WORLDPAY';
  pharmacyDeliveryEnabled: boolean;
  autoPlacementEnabled: boolean;
  gdprComplianceFlag: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  version: number;
  archivedAt?: string | null;
  companyNumber?: string | null;
}

export interface ReferralTokenRecord {
  id: string;
  organisationId: string;
  tokenHash: string;
  intakeVersion: string;
  createdByUid: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreateOrganisationRecordInput {
  id: string;
  name: string;
  tradingName: string;
  gphcNumber: string;
  superintendentName: string;
  mainContactName: string | null;
  mainContactPhone: string | null;
  mainContactEmail: string | null;
  address: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  locality?: string | null;
  county?: string | null;
  postcode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  primaryColour: string;
  logoText: string;
  portalName: string;
}

export interface PublicPharmacyResolution {
  type: 'future_pharmacy_qr' | 'legacy_pharmacy_qr';
  intakeVersion: 'v1' | 'v2';
  pharmacy: {
    id: string;
    name: string;
    tradingName: string;
    logoText: string;
    gphcNumber: string;
    superintendent: string;
    address: string;
    primaryColour: string;
  };
}

export interface SetupTaskRecord {
  id: string;
  organisationId: string;
  taskCode: string;
  required: boolean;
  completed: boolean;
  evidence: string | null;
  completedByUid: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateOrganisationProfileInput {
  tradingName: string;
  name: string;
  gphcNumber: string;
  superintendentName: string;
  address: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  locality?: string | null;
  county?: string | null;
  postcode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  mainContactName: string | null;
  mainContactPhone: string | null;
  mainContactEmail: string | null;
}

export interface UpdateOrganisationBrandInput {
  primaryColour: string;
  logoText: string;
  portalName: string;
}

export interface OrganisationDomainRecord {
  id: string;
  hostname: string;
}

export interface OrganisationRepositoryPort {
  findOrganisationById(id: string): Promise<OrganisationRecord | null>;
  listOrganisations(): Promise<OrganisationRecord[]>;
  updateOrganisationProfile(id: string, input: UpdateOrganisationProfileInput): Promise<void>;
  updateOrganisationBrand(id: string, input: UpdateOrganisationBrandInput): Promise<void>;
  updateOrganisationClassification(id: string, classification: OrganisationRecord['classification']): Promise<void>;
  updateOrganisationStatus(id: string, status: OrganisationRecord['status']): Promise<void>;
  updateOrganisationPaymentRoute(id: string, defaultPaymentRoute: OrganisationRecord['defaultPaymentRoute'], worldpayEnabled: boolean): Promise<void>;
  updateOrganisationPharmacyDelivery(id: string, enabled: boolean): Promise<void>;
  updateOrganisationIntakeEnabled(id: string, intakeEnabled: boolean): Promise<void>;
  findDirectoryByTokenHash(tokenHash: string): Promise<PublicPharmacyResolution | null>;
  findReferralTokenByHash(tokenHash: string): Promise<ReferralTokenRecord | null>;
  createReferralToken(params: {
    organisationId: string;
    tokenHash: string;
    intakeVersion: 'v2';
    createdByUid?: string | null;
  }): Promise<void>;
  createOrganisation(input: CreateOrganisationRecordInput): Promise<void>;
  createOrganisationDomain(organisationId: string, hostname: string): Promise<void>;
  listOrganisationDomains(organisationId: string): Promise<OrganisationDomainRecord[]>;
  listAllOrganisationDomains(): Promise<Array<OrganisationDomainRecord & { organisationId: string }>>;
  deleteOrganisationDomain(id: string): Promise<void>;
  listSetupTasks(organisationId: string): Promise<SetupTaskRecord[]>;
  upsertSetupTask(params: {
    organisationId: string;
    taskCode: string;
    completed: boolean;
    evidence?: string | null;
    completedByUid?: string | null;
  }): Promise<void>;
  updateStaffPreferences(uid: string, preferences: unknown): Promise<void>;
}
