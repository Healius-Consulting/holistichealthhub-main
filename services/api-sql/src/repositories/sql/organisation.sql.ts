import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import type {
  OrganisationRecord,
  OrganisationRepositoryPort,
  PublicPharmacyResolution,
  ReferralTokenRecord,
  CreateOrganisationRecordInput,
  OrganisationDomainRecord,
  SetupTaskRecord,
  UpdateOrganisationBrandInput,
  UpdateOrganisationProfileInput,
} from '../ports/organisation.port.js';
import { organisationAddressSummary } from '../ports/directory.port.js';
import { canAcceptPublicIntake } from '../../domain/organisation/access.js';

const GET_ORGANISATION_BY_ID_GQL = `
  query GetOrganisationById($id: UUID!) {
    organisation(key: { id: $id }) {
      id
      companyId
      name
      tradingName
      gphcNumber
      superintendentName
      mainContactName
      mainContactPhone
      mainContactEmail
      address
      addressLine1
      addressLine2
      locality
      county
      postcode
      latitude
      longitude
      primaryColour
      logoText
      status
      classification
      portalName
      intakeEnabled
      prescriptionEnabled
      paymentsEnabled
      supplierOrdersEnabled
      patientsEnabled
      resourcesEnabled
      worldpayEnabled
      defaultPaymentRoute
      autoPlacementEnabled
      gdprComplianceFlag
      pausedReason
      pausedAt
      version
      archivedAt
      company {
        companyNumber
      }
    }
  }
`;

const LIST_ORGANISATIONS_GQL = `
  query ListOrganisations {
    organisations(
      where: { archivedAt: { isNull: true } }
      orderBy: { tradingName: ASC }
    ) {
      id
      companyId
      name
      tradingName
      gphcNumber
      superintendentName
      mainContactName
      mainContactPhone
      mainContactEmail
      address
      addressLine1
      addressLine2
      locality
      county
      postcode
      latitude
      longitude
      primaryColour
      logoText
      status
      classification
      portalName
      intakeEnabled
      prescriptionEnabled
      paymentsEnabled
      supplierOrdersEnabled
      patientsEnabled
      resourcesEnabled
      worldpayEnabled
      defaultPaymentRoute
      autoPlacementEnabled
      gdprComplianceFlag
      pausedReason
      pausedAt
      version
      archivedAt
      company {
        companyNumber
      }
    }
  }
`;

const GET_PHARMACY_DIRECTORY_BY_TOKEN_GQL = `
  query GetPharmacyDirectoryByToken($tokenHash: String!) {
    referralTokens(where: { tokenHash: { eq: $tokenHash }, revokedAt: { isNull: true } }, limit: 1) {
      id
      organisationId
      intakeVersion
      organisation {
        id
        name
        tradingName
        gphcNumber
        superintendentName
        address
        addressLine1
        addressLine2
        locality
        county
        postcode
        latitude
        longitude
        primaryColour
        logoText
        status
        classification
        intakeEnabled
        archivedAt
      }
    }
  }
`;

const GET_REFERRAL_TOKEN_BY_HASH_GQL = `
  query GetReferralTokenByHash($tokenHash: String!) {
    referralTokens(where: { tokenHash: { eq: $tokenHash } }, limit: 1) {
      id
      organisationId
      tokenHash
      intakeVersion
      createdByUid
      createdAt
      revokedAt
    }
  }
`;

const CREATE_REFERRAL_TOKEN_GQL = `
  mutation CreateReferralToken(
    $organisationId: UUID!
    $tokenHash: String!
    $intakeVersion: String!
    $createdByUid: String
  ) {
    referralToken_insert(data: {
      organisationId: $organisationId
      tokenHash: $tokenHash
      intakeVersion: $intakeVersion
      createdByUid: $createdByUid
    })
  }
`;

const CREATE_ORGANISATION_GQL = `
  mutation CreateOrganisation(
    $id: UUID!
    $name: String!
    $tradingName: String!
    $gphcNumber: String!
    $superintendentName: String!
    $mainContactName: String
    $mainContactPhone: String
    $mainContactEmail: String
    $address: String!
    $primaryColour: String!
    $logoText: String!
    $portalName: String!
  ) {
    organisation_insert(data: {
      id: $id
      name: $name
      tradingName: $tradingName
      gphcNumber: $gphcNumber
      superintendentName: $superintendentName
      mainContactName: $mainContactName
      mainContactPhone: $mainContactPhone
      mainContactEmail: $mainContactEmail
      address: $address
      primaryColour: $primaryColour
      logoText: $logoText
      portalName: $portalName
      status: ONBOARDING
      classification: STANDARD
      intakeEnabled: true
      prescriptionEnabled: true
      paymentsEnabled: true
      supplierOrdersEnabled: true
      patientsEnabled: true
      resourcesEnabled: true
      worldpayEnabled: false
      defaultPaymentRoute: MANUAL
    })
  }
`;

const CREATE_ORGANISATION_DOMAIN_GQL = `
  mutation CreateOrganisationDomain($organisationId: UUID!, $hostname: String!) {
    organisationDomain_insert(data: {
      organisationId: $organisationId
      hostname: $hostname
    })
  }
`;

const LIST_ORGANISATION_DOMAINS_GQL = `
  query ListOrganisationDomains($organisationId: UUID!) {
    organisationDomains(where: { organisationId: { eq: $organisationId } }) {
      id
      hostname
    }
  }
`;

const LIST_ALL_ORGANISATION_DOMAINS_GQL = `
  query ListAllOrganisationDomains {
    organisationDomains {
      id
      organisationId
      hostname
    }
  }
`;

const DELETE_ORGANISATION_DOMAIN_GQL = `
  mutation DeleteOrganisationDomain($id: UUID!) {
    organisationDomain_delete(key: { id: $id })
  }
`;

const LIST_SETUP_TASKS_GQL = `
  query ListSetupTasksByOrg($organisationId: UUID!) {
    setupTasks(where: { organisationId: { eq: $organisationId } }) {
      id
      organisationId
      taskCode
      required
      completed
      evidence
      completedByUid
      completedAt
      createdAt
      updatedAt
    }
  }
`;

const UPSERT_SETUP_TASK_GQL = `
  mutation UpsertSetupTask(
    $organisationId: UUID!
    $taskCode: String!
    $completed: Boolean!
    $evidence: String
    $completedByUid: String
    $completedAt: Timestamp
  ) {
    setupTask_upsert(data: {
      organisationId: $organisationId
      taskCode: $taskCode
      completed: $completed
      evidence: $evidence
      completedByUid: $completedByUid
      completedAt: $completedAt
    })
  }
`;

const UPDATE_ORGANISATION_PROFILE_GQL = `
  mutation UpdateOrganisationProfile(
    $id: UUID!
    $tradingName: String!
    $name: String!
    $gphcNumber: String!
    $superintendentName: String!
    $address: String!
    $addressLine1: String
    $addressLine2: String
    $locality: String
    $county: String
    $postcode: String
    $latitude: Float
    $longitude: Float
    $mainContactName: String
    $mainContactPhone: String
    $mainContactEmail: String
  ) {
    organisation_update(
      key: { id: $id }
      data: {
        tradingName: $tradingName
        name: $name
        gphcNumber: $gphcNumber
        superintendentName: $superintendentName
        address: $address
        addressLine1: $addressLine1
        addressLine2: $addressLine2
        locality: $locality
        county: $county
        postcode: $postcode
        latitude: $latitude
        longitude: $longitude
        mainContactName: $mainContactName
        mainContactPhone: $mainContactPhone
        mainContactEmail: $mainContactEmail
      }
    )
  }
`;

const UPDATE_ORGANISATION_BRAND_GQL = `
  mutation UpdateOrganisationBrand(
    $id: UUID!
    $primaryColour: String!
    $logoText: String!
    $portalName: String!
  ) {
    organisation_update(
      key: { id: $id }
      data: {
        primaryColour: $primaryColour
        logoText: $logoText
        portalName: $portalName
      }
    )
  }
`;

const UPDATE_ORGANISATION_CLASSIFICATION_GQL = `
  mutation UpdateOrganisationClassification(
    $id: UUID!
    $classification: WorkspaceClassification!
  ) {
    organisation_update(
      key: { id: $id }
      data: {
        classification: $classification
      }
    )
  }
`;

const UPDATE_ORGANISATION_STATUS_GQL = `
  mutation UpdateOrganisationStatus(
    $id: UUID!
    $status: OrganisationStatus!
  ) {
    organisation_update(
      key: { id: $id }
      data: {
        status: $status
      }
    )
  }
`;

const UPDATE_ORGANISATION_PAYMENT_ROUTE_GQL = `
  mutation UpdateOrganisationPaymentRoute(
    $id: UUID!
    $defaultPaymentRoute: PaymentRoute!
    $worldpayEnabled: Boolean!
  ) {
    organisation_update(
      key: { id: $id }
      data: {
        defaultPaymentRoute: $defaultPaymentRoute
        worldpayEnabled: $worldpayEnabled
      }
    )
  }
`;

const UPDATE_ORGANISATION_INTAKE_ENABLED_GQL = `
  mutation UpdateOrganisationIntakeEnabled(
    $id: UUID!
    $intakeEnabled: Boolean!
  ) {
    organisation_update(
      key: { id: $id }
      data: {
        intakeEnabled: $intakeEnabled
      }
    )
  }
`;

const UPDATE_STAFF_PREFERENCES_GQL = `
  mutation UpdateStaffPreferences(
    $uid: String!
    $preferences: Any!
  ) {
    staffUser_update(
      key: { uid: $uid }
      data: {
        preferences: $preferences
      }
    )
  }
`;

type OrganisationRow = OrganisationRecord & { company?: { companyNumber: string } | null };

function mapOrganisation(row: OrganisationRow | null): OrganisationRecord | null {
  if (!row) return null;
  const { company, ...organisation } = row;
  return {
    ...organisation,
    companyNumber: company?.companyNumber ?? organisation.companyNumber ?? null,
  };
}

export class SqlOrganisationRepository implements OrganisationRepositoryPort {
  async findOrganisationById(id: string): Promise<OrganisationRecord | null> {
    const result = await dataConnect.executeGraphql<{ organisation: OrganisationRow | null }, any>(
      GET_ORGANISATION_BY_ID_GQL,
      { variables: { id: asUuid(id) } }
    );
    return mapOrganisation(result.data.organisation);
  }

  async listOrganisations(): Promise<OrganisationRecord[]> {
    const result = await dataConnect.executeGraphql<{ organisations: OrganisationRow[] }, any>(
      LIST_ORGANISATIONS_GQL
    );
    return (result.data.organisations ?? []).flatMap(row => {
      const mapped = mapOrganisation(row);
      return mapped ? [mapped] : [];
    });
  }

  async updateOrganisationProfile(id: string, input: UpdateOrganisationProfileInput): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORGANISATION_PROFILE_GQL, {
      variables: {
        id,
        tradingName: input.tradingName,
        name: input.name,
        gphcNumber: input.gphcNumber,
        superintendentName: input.superintendentName,
        address: input.address,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        locality: input.locality ?? null,
        county: input.county ?? null,
        postcode: input.postcode ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        mainContactName: input.mainContactName,
        mainContactPhone: input.mainContactPhone,
        mainContactEmail: input.mainContactEmail,
      },
    });
  }

  async updateOrganisationBrand(id: string, input: UpdateOrganisationBrandInput): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORGANISATION_BRAND_GQL, {
      variables: {
        id: asUuid(id),
        primaryColour: input.primaryColour,
        logoText: input.logoText,
        portalName: input.portalName,
      },
    });
  }

  async updateOrganisationClassification(id: string, classification: OrganisationRecord['classification']): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORGANISATION_CLASSIFICATION_GQL, {
      variables: { id: asUuid(id), classification },
    });
  }

  async updateOrganisationStatus(id: string, status: OrganisationRecord['status']): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORGANISATION_STATUS_GQL, {
      variables: { id: asUuid(id), status },
    });
  }

  async updateOrganisationPaymentRoute(
    id: string,
    defaultPaymentRoute: OrganisationRecord['defaultPaymentRoute'],
    worldpayEnabled: boolean,
  ): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORGANISATION_PAYMENT_ROUTE_GQL, {
      variables: { id: asUuid(id), defaultPaymentRoute, worldpayEnabled },
    });
  }

  async updateOrganisationIntakeEnabled(id: string, intakeEnabled: boolean): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORGANISATION_INTAKE_ENABLED_GQL, {
      variables: { id: asUuid(id), intakeEnabled },
    });
  }

  async findDirectoryByTokenHash(tokenHash: string): Promise<PublicPharmacyResolution | null> {
    const result = await dataConnect.executeGraphql<{
      referralTokens: Array<{
        id: string;
        organisationId: string;
        intakeVersion: string;
        organisation: {
          id: string;
          name: string;
          tradingName: string;
          gphcNumber: string;
          superintendentName: string;
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
          status: OrganisationRecord['status'];
          classification: OrganisationRecord['classification'];
          intakeEnabled: boolean;
          archivedAt: string | null;
        };
      }>;
    }, any>(GET_PHARMACY_DIRECTORY_BY_TOKEN_GQL, { variables: { tokenHash } });

    const match = result.data.referralTokens?.[0];
    if (!match || !match.organisation) return null;

    const org = match.organisation;
    if (!canAcceptPublicIntake({
      ...org,
      companyId: null,
      mainContactName: null,
      mainContactPhone: null,
      mainContactEmail: null,
      portalName: org.name,
      prescriptionEnabled: true,
      paymentsEnabled: true,
      supplierOrdersEnabled: true,
      patientsEnabled: true,
      resourcesEnabled: true,
      worldpayEnabled: false,
      defaultPaymentRoute: 'MANUAL',
      autoPlacementEnabled: false,
      gdprComplianceFlag: true,
      pausedReason: null,
      pausedAt: null,
      version: 1,
    })) return null;
    return {
      type: match.intakeVersion === 'v1' ? 'legacy_pharmacy_qr' : 'future_pharmacy_qr',
      intakeVersion: match.intakeVersion === 'v1' ? 'v1' : 'v2',
      pharmacy: {
        id: org.id,
        name: org.name,
        tradingName: org.tradingName,
        logoText: org.logoText,
        gphcNumber: org.gphcNumber,
        superintendent: org.superintendentName,
        address: organisationAddressSummary(org),
        primaryColour: org.primaryColour,
      },
    };
  }

  async findReferralTokenByHash(tokenHash: string): Promise<ReferralTokenRecord | null> {
    const result = await dataConnect.executeGraphql<{ referralTokens: ReferralTokenRecord[] }, any>(
      GET_REFERRAL_TOKEN_BY_HASH_GQL,
      { variables: { tokenHash } }
    );
    return result.data.referralTokens?.[0] ?? null;
  }

  async createReferralToken(params: {
    organisationId: string;
    tokenHash: string;
    intakeVersion: 'v2';
    createdByUid?: string | null;
  }): Promise<void> {
    await dataConnect.executeGraphql<any, any>(CREATE_REFERRAL_TOKEN_GQL, {
      variables: {
        organisationId: params.organisationId,
        tokenHash: params.tokenHash,
        intakeVersion: params.intakeVersion,
        createdByUid: params.createdByUid ?? null,
      },
    });
  }

  async createOrganisation(input: CreateOrganisationRecordInput): Promise<void> {
    await dataConnect.executeGraphql<any, any>(CREATE_ORGANISATION_GQL, { variables: input });
  }

  async createOrganisationDomain(organisationId: string, hostname: string): Promise<void> {
    await dataConnect.executeGraphql<any, any>(CREATE_ORGANISATION_DOMAIN_GQL, {
      variables: { organisationId: asUuid(organisationId), hostname },
    });
  }

  async listOrganisationDomains(organisationId: string): Promise<OrganisationDomainRecord[]> {
    const result = await dataConnect.executeGraphql<{ organisationDomains: OrganisationDomainRecord[] }, any>(
      LIST_ORGANISATION_DOMAINS_GQL,
      { variables: { organisationId: asUuid(organisationId) } },
    );
    return result.data.organisationDomains ?? [];
  }

  async listAllOrganisationDomains(): Promise<Array<OrganisationDomainRecord & { organisationId: string }>> {
    const result = await dataConnect.executeGraphql<{
      organisationDomains: Array<OrganisationDomainRecord & { organisationId: string }>;
    }, any>(LIST_ALL_ORGANISATION_DOMAINS_GQL);
    return result.data.organisationDomains ?? [];
  }

  async deleteOrganisationDomain(id: string): Promise<void> {
    await dataConnect.executeGraphql<any, any>(DELETE_ORGANISATION_DOMAIN_GQL, {
      variables: { id: asUuid(id) },
    });
  }

  async listSetupTasks(organisationId: string): Promise<SetupTaskRecord[]> {
    const result = await dataConnect.executeGraphql<{ setupTasks: SetupTaskRecord[] }, any>(
      LIST_SETUP_TASKS_GQL,
      { variables: { organisationId } }
    );
    return result.data.setupTasks ?? [];
  }

  async upsertSetupTask(params: {
    organisationId: string;
    taskCode: string;
    completed: boolean;
    evidence?: string | null;
    completedByUid?: string | null;
  }): Promise<void> {
    const completedAt = params.completed ? new Date().toISOString() : null;
    await dataConnect.executeGraphql<any, any>(UPSERT_SETUP_TASK_GQL, {
      variables: {
        organisationId: params.organisationId,
        taskCode: params.taskCode,
        completed: params.completed,
        evidence: params.evidence ?? null,
        completedByUid: params.completedByUid ?? null,
        completedAt,
      },
    });
  }

  async updateStaffPreferences(uid: string, preferences: unknown): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_STAFF_PREFERENCES_GQL, {
      variables: { uid, preferences },
    });
  }
}
