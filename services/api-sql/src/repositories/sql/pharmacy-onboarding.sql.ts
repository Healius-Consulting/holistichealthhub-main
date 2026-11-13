import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import type {
  PharmacyOnboardingRequestRecord,
  PharmacyOnboardingStatus,
} from '../../domain/pharmacy-onboarding/request.js';

const REQUEST_FIELDS = `
  id
  status
  pharmacistName
  pharmacyName
  registeredCompanyName
  invoiceAddress
  deliveryAddress
  gphcNumber
  wdaNumber
  licenceDetails
  pharmacyEmail
  accountsEmail
  pharmacyPhone
  accountsPhone
  faxNumber
  signatureName
  signedOn
  licenceStoragePath
  licenceContentType
  licenceFilename
  filledFormStoragePath
  organisationId
  declineReason
  decidedAt
  decidedByUid
  idempotencyKey
  createdAt
`;

type RawRequest = Omit<PharmacyOnboardingRequestRecord, 'status' | 'createdAt' | 'decidedAt'> & {
  status: string;
  createdAt?: string | null;
  decidedAt?: string | null;
};

function asStatus(value: string): PharmacyOnboardingStatus {
  if (value === 'ACTIVATED' || value === 'DECLINED' || value === 'PENDING') return value;
  return 'PENDING';
}

function toRecord(row: RawRequest | null | undefined): PharmacyOnboardingRequestRecord | null {
  if (!row) return null;
  return {
    ...row,
    status: asStatus(row.status),
    faxNumber: row.faxNumber ?? null,
    organisationId: row.organisationId ?? null,
    declineReason: row.declineReason ?? null,
    decidedAt: row.decidedAt ?? null,
    decidedByUid: row.decidedByUid ?? null,
    createdAt: row.createdAt ?? null,
  };
}

const LIST_GPHC_GQL = `
  query ListOrganisationGphcNumbers {
    organisations(where: { archivedAt: { isNull: true } }) {
      id
      gphcNumber
    }
  }
`;

const BY_IDEMPOTENCY_GQL = `
  query PharmacyOnboardingRequestByIdempotency($idempotencyKey: String!) {
    pharmacyOnboardingRequests(where: { idempotencyKey: { eq: $idempotencyKey } }, limit: 1) {
      ${REQUEST_FIELDS}
    }
  }
`;

const PENDING_BY_GPHC_GQL = `
  query PendingPharmacyOnboardingByGphc($gphcNumber: String!) {
    pharmacyOnboardingRequests(
      where: { gphcNumber: { eq: $gphcNumber }, status: { eq: PENDING } }
      limit: 1
    ) {
      id
      status
      gphcNumber
      idempotencyKey
    }
  }
`;

const GET_GQL = `
  query GetPharmacyOnboardingRequest($id: UUID!) {
    pharmacyOnboardingRequest(key: { id: $id }) {
      ${REQUEST_FIELDS}
    }
  }
`;

const LIST_GQL = `
  query ListPharmacyOnboardingRequests($limit: Int!) {
    pharmacyOnboardingRequests(orderBy: [{ createdAt: DESC }], limit: $limit) {
      ${REQUEST_FIELDS}
    }
  }
`;

const INSERT_GQL = `
  mutation CreatePharmacyOnboardingRequest(
    $id: UUID!
    $pharmacistName: String!
    $pharmacyName: String!
    $registeredCompanyName: String!
    $invoiceAddress: String!
    $deliveryAddress: String!
    $gphcNumber: String!
    $wdaNumber: String!
    $licenceDetails: String!
    $pharmacyEmail: String!
    $accountsEmail: String!
    $pharmacyPhone: String!
    $accountsPhone: String!
    $faxNumber: String
    $signatureName: String!
    $signedOn: String!
    $licenceStoragePath: String!
    $licenceContentType: String!
    $licenceFilename: String!
    $filledFormStoragePath: String!
    $idempotencyKey: String!
  ) {
    pharmacyOnboardingRequest_insert(data: {
      id: $id
      pharmacistName: $pharmacistName
      pharmacyName: $pharmacyName
      registeredCompanyName: $registeredCompanyName
      invoiceAddress: $invoiceAddress
      deliveryAddress: $deliveryAddress
      gphcNumber: $gphcNumber
      wdaNumber: $wdaNumber
      licenceDetails: $licenceDetails
      pharmacyEmail: $pharmacyEmail
      accountsEmail: $accountsEmail
      pharmacyPhone: $pharmacyPhone
      accountsPhone: $accountsPhone
      faxNumber: $faxNumber
      signatureName: $signatureName
      signedOn: $signedOn
      licenceStoragePath: $licenceStoragePath
      licenceContentType: $licenceContentType
      licenceFilename: $licenceFilename
      filledFormStoragePath: $filledFormStoragePath
      idempotencyKey: $idempotencyKey
      status: PENDING
    })
  }
`;

const ACTIVATE_GQL = `
  mutation ActivatePharmacyOnboardingRequest(
    $id: UUID!
    $organisationId: UUID!
    $decidedAt: Timestamp!
    $decidedByUid: String!
  ) {
    pharmacyOnboardingRequest_update(
      key: { id: $id }
      data: {
        status: ACTIVATED
        organisationId: $organisationId
        decidedAt: $decidedAt
        decidedByUid: $decidedByUid
      }
    )
  }
`;

const DECLINE_GQL = `
  mutation DeclinePharmacyOnboardingRequest(
    $id: UUID!
    $declineReason: String!
    $decidedAt: Timestamp!
    $decidedByUid: String!
  ) {
    pharmacyOnboardingRequest_update(
      key: { id: $id }
      data: {
        status: DECLINED
        declineReason: $declineReason
        decidedAt: $decidedAt
        decidedByUid: $decidedByUid
      }
    )
  }
`;

export class SqlPharmacyOnboardingRepository {
  async listOrganisationGphcNumbers(): Promise<Array<{ id: string; gphcNumber: string }>> {
    const result = await dataConnect.executeGraphql<{
      organisations: Array<{ id: string; gphcNumber: string }>;
    }, Record<string, never>>(LIST_GPHC_GQL);
    return result.data.organisations ?? [];
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PharmacyOnboardingRequestRecord | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: RawRequest[];
    }, { idempotencyKey: string }>(BY_IDEMPOTENCY_GQL, { variables: { idempotencyKey } });
    return toRecord(result.data.pharmacyOnboardingRequests?.[0]);
  }

  async findPendingByGphc(gphcNumber: string): Promise<{ id: string; idempotencyKey: string } | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: Array<{ id: string; idempotencyKey: string }>;
    }, { gphcNumber: string }>(PENDING_BY_GPHC_GQL, { variables: { gphcNumber } });
    return result.data.pharmacyOnboardingRequests?.[0] ?? null;
  }

  async findById(id: string): Promise<PharmacyOnboardingRequestRecord | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequest: RawRequest | null;
    }, { id: string }>(GET_GQL, { variables: { id: asUuid(id) } });
    return toRecord(result.data.pharmacyOnboardingRequest);
  }

  async list(limit = 200): Promise<PharmacyOnboardingRequestRecord[]> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: RawRequest[];
    }, { limit: number }>(LIST_GQL, { variables: { limit } });
    return (result.data.pharmacyOnboardingRequests ?? []).map(row => toRecord(row)!);
  }

  async insert(input: Omit<PharmacyOnboardingRequestRecord, 'status' | 'organisationId' | 'declineReason' | 'decidedAt' | 'decidedByUid' | 'createdAt'>): Promise<void> {
    await dataConnect.executeGraphql<unknown, typeof input>(INSERT_GQL, { variables: input });
  }

  async activate(id: string, organisationId: string, decidedAt: string, decidedByUid: string): Promise<void> {
    await dataConnect.executeGraphql<unknown, {
      id: string;
      organisationId: string;
      decidedAt: string;
      decidedByUid: string;
    }>(ACTIVATE_GQL, {
      variables: { id: asUuid(id), organisationId: asUuid(organisationId), decidedAt, decidedByUid },
    });
  }

  async decline(id: string, declineReason: string, decidedAt: string, decidedByUid: string): Promise<void> {
    await dataConnect.executeGraphql<unknown, {
      id: string;
      declineReason: string;
      decidedAt: string;
      decidedByUid: string;
    }>(DECLINE_GQL, {
      variables: { id: asUuid(id), declineReason, decidedAt, decidedByUid },
    });
  }
}
