import { dataConnect } from '../../bootstrap/firebase.js';
import { SqlWorldpayApplicationRepository } from './worldpay-application.sql.js';
import { asUuid } from '../../domain/common/uuid.js';
import {
  isOnboardingHoldReason,
  type PharmacyOnboardingRequestRecord,
  type PharmacyOnboardingStatus,
} from '../../domain/pharmacy-onboarding/request.js';
import type { OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import type { PharmacyOnboardingDeferralRecord } from '../../domain/pharmacy-onboarding/deferral.js';
import type { WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';

const REQUEST_FIELDS = `
  id
  status
  pharmacistName
  pharmacyName
  registeredCompanyName
  invoiceAddress
  deliveryAddress
  gphcNumber
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
  holdReason
  heldAt
  decidedAt
  decidedByUid
  idempotencyKey
  createdAt
`;

type RawRequest = Omit<PharmacyOnboardingRequestRecord, 'status' | 'createdAt' | 'decidedAt' | 'holdReason' | 'heldAt'> & {
  status: string;
  holdReason?: string | null;
  heldAt?: string | null;
  createdAt?: string | null;
  decidedAt?: string | null;
};

function asStatus(value: string): PharmacyOnboardingStatus {
  if (value === 'ACTIVATED' || value === 'ON_HOLD' || value === 'PENDING') return value;
  return 'PENDING';
}

function toRecord(row: RawRequest | null | undefined): PharmacyOnboardingRequestRecord | null {
  if (!row) return null;
  return {
    ...row,
    status: asStatus(row.status),
    faxNumber: row.faxNumber ?? null,
    organisationId: row.organisationId ?? null,
    holdReason: isOnboardingHoldReason(row.holdReason) ? row.holdReason : null,
    heldAt: row.heldAt ?? null,
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
      status
    }
  }
`;

const BY_ORGANISATION_GQL = `
  query PharmacyOnboardingRequestByOrganisation($organisationId: UUID!) {
    pharmacyOnboardingRequests(where: { organisationId: { eq: $organisationId } }, limit: 1) {
      ${REQUEST_FIELDS}
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

const OPEN_BY_GPHC_GQL = `
  query OpenPharmacyOnboardingByGphc($gphcNumber: String!) {
    pharmacyOnboardingRequests(
      where: { gphcNumber: { eq: $gphcNumber }, status: { in: [PENDING, ON_HOLD] } }
      orderBy: [{ createdAt: DESC }]
      limit: 1
    ) {
      id
      status
      gphcNumber
      idempotencyKey
    }
  }
`;

const LATEST_BY_GPHC_GQL = `
  query LatestPharmacyOnboardingByGphc($gphcNumber: String!) {
    pharmacyOnboardingRequests(
      where: { gphcNumber: { eq: $gphcNumber } }
      orderBy: [{ createdAt: DESC }]
      limit: 1
    ) {
      id
      status
      pharmacyName
      registeredCompanyName
      holdReason
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

const DEFERRAL_BY_IDEMPOTENCY_GQL = `
  query PharmacyOnboardingDeferralByIdempotency($idempotencyKey: String!) {
    pharmacyOnboardingDeferrals(where: { idempotencyKey: { eq: $idempotencyKey } }, limit: 1) {
      id
    }
  }
`;

const INSERT_DEFERRAL_GQL = `
  mutation CreatePharmacyOnboardingDeferral(
    $id: UUID!
    $gphcNumber: String!
    $pharmsmartPharmacyId: String
    $personName: String
    $personEmail: String
    $idempotencyKey: String!
  ) {
    pharmacyOnboardingDeferral_insert(data: {
      id: $id
      gphcNumber: $gphcNumber
      pharmsmartPharmacyId: $pharmsmartPharmacyId
      personName: $personName
      personEmail: $personEmail
      idempotencyKey: $idempotencyKey
    })
  }
`;

const WORLDPAY_FIELDS = `
  id
  gphcNumber
  tradingName
  submittedAt
  idempotencyKey
`;

const LIST_WORLDPAY_GQL = `
  query ListPharmacyWorldpaySubmissions($limit: Int!) {
    pharmacyWorldpaySubmissions(orderBy: [{ submittedAt: DESC }], limit: $limit) {
      ${WORLDPAY_FIELDS}
    }
  }
`;

/** The branch's latest note: sent from its portal, or from the onboarding page under its GPhC. */
const WORLDPAY_FOR_BRANCH_GQL = `
  query PharmacyWorldpaySubmissionForBranch($organisationId: UUID!, $gphcNumber: String!) {
    pharmacyWorldpaySubmissions(
      where: { _or: [{ organisationId: { eq: $organisationId } }, { gphcNumber: { eq: $gphcNumber } }] }
      orderBy: [{ submittedAt: DESC }]
      limit: 1
    ) {
      ${WORLDPAY_FIELDS}
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

/** Sets a hold, or changes the reason of one already set. organisationId is left alone. */
const HOLD_GQL = `
  mutation HoldPharmacyOnboardingRequest(
    $id: UUID!
    $holdReason: OnboardingHoldReason!
    $heldAt: Timestamp!
    $decidedByUid: String!
  ) {
    pharmacyOnboardingRequest_update(
      key: { id: $id }
      data: {
        status: ON_HOLD
        holdReason: $holdReason
        heldAt: $heldAt
        decidedAt: $heldAt
        decidedByUid: $decidedByUid
      }
    )
  }
`;

/**
 * Lifts the hold: back to PENDING, or ACTIVATED when the request already has a branch.
 * The reason and heldAt stay on the row as history.
 */
const UNHOLD_GQL = `
  mutation UnholdPharmacyOnboardingRequest($id: UUID!, $status: PharmacyOnboardingRequestStatus!) {
    pharmacyOnboardingRequest_update(
      key: { id: $id }
      data: { status: $status }
    )
  }
`;

const TERMS_FIELDS = `
  id
  onboardingRequestId
  organisationId
  termsVersion
  signerName
  signerRole
  signerRoleOther
  signerEmail
  signerGphcNumber
  registeredCompanyName
  acceptedAt
  ipAddress
  source
  nameMatchesPharmsmart
`;

const TERMS_BY_REQUEST_GQL = `
  query PartnerTermsAcceptancesByRequest($onboardingRequestId: UUID!) {
    partnerTermsAcceptances(
      where: { onboardingRequestId: { eq: $onboardingRequestId } }
      orderBy: [{ acceptedAt: DESC }]
    ) {
      ${TERMS_FIELDS}
    }
  }
`;

const LIST_TERMS_GQL = `
  query ListPartnerTermsAcceptances($limit: Int!) {
    partnerTermsAcceptances(orderBy: [{ acceptedAt: DESC }], limit: $limit) {
      ${TERMS_FIELDS}
    }
  }
`;

const REQUEST_IDS_BY_GPHC_GQL = `
  query PharmacyOnboardingRequestIdsByGphc($gphcNumber: String!) {
    pharmacyOnboardingRequests(where: { gphcNumber: { eq: $gphcNumber } }) {
      id
    }
  }
`;

/** Acceptances signed from the branch's portal (no onboarding request) or linked to it at Activate. */
const TERMS_BY_ORGANISATION_GQL = `
  query PartnerTermsAcceptancesByOrganisation($organisationId: UUID!) {
    partnerTermsAcceptances(
      where: { organisationId: { eq: $organisationId } }
      orderBy: [{ acceptedAt: DESC }]
    ) {
      ${TERMS_FIELDS}
    }
  }
`;

const TERMS_FOR_REQUESTS_GQL = `
  query PartnerTermsAcceptedForRequests($ids: [UUID!]!) {
    partnerTermsAcceptances(where: { onboardingRequestId: { in: $ids } }, limit: 1) {
      id
    }
  }
`;

/** Append-only: a new row each time. Nothing updates or deletes these rows except the Activate link below. */
const INSERT_TERMS_GQL = `
  mutation CreatePartnerTermsAcceptance(
    $id: UUID!
    $onboardingRequestId: UUID
    $organisationId: UUID
    $termsVersion: String!
    $signerName: String!
    $signerRole: String!
    $signerRoleOther: String
    $signerEmail: String!
    $signerGphcNumber: String
    $registeredCompanyName: String!
    $acceptedAt: Timestamp!
    $ipAddress: String
    $source: String!
    $nameMatchesPharmsmart: Boolean
  ) {
    partnerTermsAcceptance_insert(data: {
      id: $id
      onboardingRequestId: $onboardingRequestId
      organisationId: $organisationId
      termsVersion: $termsVersion
      signerName: $signerName
      signerRole: $signerRole
      signerRoleOther: $signerRoleOther
      signerEmail: $signerEmail
      signerGphcNumber: $signerGphcNumber
      registeredCompanyName: $registeredCompanyName
      acceptedAt: $acceptedAt
      ipAddress: $ipAddress
      source: $source
      nameMatchesPharmsmart: $nameMatchesPharmsmart
    })
  }
`;

/** The one update these rows allow: Activate names the branch the request became. */
const LINK_TERMS_GQL = `
  mutation LinkPartnerTermsToOrganisation($onboardingRequestId: UUID!, $organisationId: UUID!) {
    partnerTermsAcceptance_updateMany(
      where: { onboardingRequestId: { eq: $onboardingRequestId }, organisationId: { isNull: true } }
      data: { organisationId: $organisationId }
    )
  }
`;

type RawTerms = Omit<PartnerTermsAcceptanceRecord, 'source'> & { source: string };

function toTerms(row: RawTerms): PartnerTermsAcceptanceRecord {
  return {
    ...row,
    organisationId: row.organisationId ?? null,
    signerGphcNumber: row.signerGphcNumber ?? null,
    ipAddress: row.ipAddress ?? null,
    source: row.source === 'reacceptance' ? 'reacceptance' : 'signup',
    nameMatchesPharmsmart: row.nameMatchesPharmsmart ?? null,
  };
}

export class SqlPharmacyOnboardingRepository {
  /** At activation, a Worldpay application started on the onboarding page moves to the branch. */
  async linkWorldpayApplications(onboardingRequestId: string, organisationId: string) {
    await new SqlWorldpayApplicationRepository().linkRequestToOrganisation(onboardingRequestId, organisationId);
  }

  async listOrganisationGphcNumbers(): Promise<Array<{ id: string; gphcNumber: string; status?: string }>> {
    const result = await dataConnect.executeGraphql<{
      organisations: Array<{ id: string; gphcNumber: string; status?: string }>;
    }, Record<string, never>>(LIST_GPHC_GQL);
    return result.data.organisations ?? [];
  }

  async findByOrganisationId(organisationId: string): Promise<PharmacyOnboardingRequestRecord | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: RawRequest[];
    }, { organisationId: string }>(BY_ORGANISATION_GQL, { variables: { organisationId: asUuid(organisationId) } });
    return toRecord(result.data.pharmacyOnboardingRequests?.[0]);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<PharmacyOnboardingRequestRecord | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: RawRequest[];
    }, { idempotencyKey: string }>(BY_IDEMPOTENCY_GQL, { variables: { idempotencyKey } });
    return toRecord(result.data.pharmacyOnboardingRequests?.[0]);
  }

  /** The GPhC's waiting or held request, if any. */
  async findOpenByGphc(gphcNumber: string): Promise<{ id: string; status: PharmacyOnboardingStatus; idempotencyKey: string } | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: Array<{ id: string; status: string; idempotencyKey: string }>;
    }, { gphcNumber: string }>(OPEN_BY_GPHC_GQL, { variables: { gphcNumber } });
    const row = result.data.pharmacyOnboardingRequests?.[0];
    return row ? { id: row.id, status: asStatus(row.status), idempotencyKey: row.idempotencyKey } : null;
  }

  async findLatestByGphc(gphcNumber: string): Promise<{
    id: string;
    status: PharmacyOnboardingStatus;
    pharmacyName: string;
    registeredCompanyName: string;
    holdReason: OnboardingHoldReason | null;
  } | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: Array<{ id: string; status: string; pharmacyName: string; registeredCompanyName: string; holdReason?: string | null }>;
    }, { gphcNumber: string }>(LATEST_BY_GPHC_GQL, { variables: { gphcNumber } });
    const row = result.data.pharmacyOnboardingRequests?.[0];
    return row ? { ...row, status: asStatus(row.status), holdReason: isOnboardingHoldReason(row.holdReason) ? row.holdReason : null } : null;
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

  async insert(input: Omit<PharmacyOnboardingRequestRecord, 'status' | 'organisationId' | 'holdReason' | 'heldAt' | 'decidedAt' | 'decidedByUid' | 'createdAt'>): Promise<void> {
    await dataConnect.executeGraphql<unknown, typeof input>(INSERT_GQL, { variables: input });
  }

  async findDeferralByIdempotencyKey(idempotencyKey: string): Promise<{ id: string } | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyOnboardingDeferrals: Array<{ id: string }>;
    }, { idempotencyKey: string }>(DEFERRAL_BY_IDEMPOTENCY_GQL, { variables: { idempotencyKey } });
    return result.data.pharmacyOnboardingDeferrals?.[0] ?? null;
  }

  async listWorldpaySubmissions(limit = 500): Promise<WorldpaySubmissionNote[]> {
    const result = await dataConnect.executeGraphql<{
      pharmacyWorldpaySubmissions: WorldpaySubmissionNote[];
    }, { limit: number }>(LIST_WORLDPAY_GQL, { variables: { limit } });
    return result.data.pharmacyWorldpaySubmissions ?? [];
  }

  async findWorldpaySubmissionForBranch(organisationId: string, gphcNumber: string): Promise<WorldpaySubmissionNote | null> {
    const result = await dataConnect.executeGraphql<{
      pharmacyWorldpaySubmissions: WorldpaySubmissionNote[];
    }, { organisationId: string; gphcNumber: string }>(WORLDPAY_FOR_BRANCH_GQL, {
      variables: { organisationId: asUuid(organisationId), gphcNumber },
    });
    return result.data.pharmacyWorldpaySubmissions?.[0] ?? null;
  }

  async insertDeferral(record: PharmacyOnboardingDeferralRecord): Promise<void> {
    await dataConnect.executeGraphql<unknown, PharmacyOnboardingDeferralRecord>(INSERT_DEFERRAL_GQL, {
      variables: { ...record, id: asUuid(record.id) },
    });
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

  async hold(id: string, reason: OnboardingHoldReason, heldAt: string, decidedByUid: string): Promise<void> {
    await dataConnect.executeGraphql<unknown, {
      id: string;
      holdReason: OnboardingHoldReason;
      heldAt: string;
      decidedByUid: string;
    }>(HOLD_GQL, {
      variables: { id: asUuid(id), holdReason: reason, heldAt, decidedByUid },
    });
  }

  async unhold(id: string, status: 'PENDING' | 'ACTIVATED'): Promise<void> {
    await dataConnect.executeGraphql<unknown, { id: string; status: 'PENDING' | 'ACTIVATED' }>(UNHOLD_GQL, {
      variables: { id: asUuid(id), status },
    });
  }

  async findTermsAcceptances(onboardingRequestId: string): Promise<PartnerTermsAcceptanceRecord[]> {
    const result = await dataConnect.executeGraphql<{
      partnerTermsAcceptances: RawTerms[];
    }, { onboardingRequestId: string }>(TERMS_BY_REQUEST_GQL, { variables: { onboardingRequestId: asUuid(onboardingRequestId) } });
    return (result.data.partnerTermsAcceptances ?? []).map(toTerms);
  }

  async listTermsAcceptances(limit = 500): Promise<PartnerTermsAcceptanceRecord[]> {
    const result = await dataConnect.executeGraphql<{
      partnerTermsAcceptances: RawTerms[];
    }, { limit: number }>(LIST_TERMS_GQL, { variables: { limit } });
    return (result.data.partnerTermsAcceptances ?? []).map(toTerms);
  }

  /** Whether any onboarding request for this GPhC has had the Partner Terms accepted. */
  async hasAcceptedTermsForGphc(gphcNumber: string): Promise<boolean> {
    const requests = await dataConnect.executeGraphql<{
      pharmacyOnboardingRequests: Array<{ id: string }>;
    }, { gphcNumber: string }>(REQUEST_IDS_BY_GPHC_GQL, { variables: { gphcNumber } });
    const ids = (requests.data.pharmacyOnboardingRequests ?? []).map(row => row.id);
    if (ids.length === 0) return false;
    const accepted = await dataConnect.executeGraphql<{
      partnerTermsAcceptances: Array<{ id: string }>;
    }, { ids: string[] }>(TERMS_FOR_REQUESTS_GQL, { variables: { ids } });
    return (accepted.data.partnerTermsAcceptances ?? []).length > 0;
  }

  async findTermsAcceptancesForOrganisation(organisationId: string): Promise<PartnerTermsAcceptanceRecord[]> {
    const result = await dataConnect.executeGraphql<{
      partnerTermsAcceptances: RawTerms[];
    }, { organisationId: string }>(TERMS_BY_ORGANISATION_GQL, { variables: { organisationId: asUuid(organisationId) } });
    return (result.data.partnerTermsAcceptances ?? []).map(toTerms);
  }

  /** organisationId is set only for an acceptance made from the branch's own portal. */
  async insertTermsAcceptance(record: Omit<PartnerTermsAcceptanceRecord, 'organisationId'> & { organisationId?: string | null }): Promise<void> {
    await dataConnect.executeGraphql<unknown, Omit<PartnerTermsAcceptanceRecord, 'organisationId'> & { organisationId: string | null }>(INSERT_TERMS_GQL, {
      variables: {
        ...record,
        id: asUuid(record.id),
        onboardingRequestId: record.onboardingRequestId ? asUuid(record.onboardingRequestId) : null,
        organisationId: record.organisationId ? asUuid(record.organisationId) : null,
      },
    });
  }

  async linkTermsAcceptances(onboardingRequestId: string, organisationId: string): Promise<void> {
    await dataConnect.executeGraphql<unknown, { onboardingRequestId: string; organisationId: string }>(LINK_TERMS_GQL, {
      variables: { onboardingRequestId: asUuid(onboardingRequestId), organisationId: asUuid(organisationId) },
    });
  }
}
