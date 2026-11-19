import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import { worldpayAnswersDraftSchema } from '../../domain/worldpay-application/answers.js';
import type {
  PlatformContentRepository,
  WorldpayApplicationRecord,
  WorldpayApplicationRepository,
  WorldpayApplicationStatus,
  WorldpayApplicationSummaryFields,
  WorldpaySubmissionFields,
} from '../ports/worldpay-application.port.js';

const FIELDS = `
  id organisationId onboardingRequestId gphcNumber status reference answers version
  legalName tradingName usesHhhWebsite companyNumber companyStatus companyLookedUpAt companyName
  submittedAt submittedByUid submitterName submitterEmail signerName signerPosition
  pdfStoragePath xlsxStoragePath sentAt deliveryError
  statusNote statusChangedAt statusChangedByUid sensitiveDeletedAt createdAt updatedAt
`;

const BY_ID_GQL = `
  query WorldpayApplicationById($id: UUID!) {
    worldpayApplication(key: { id: $id }) { ${FIELDS} }
  }
`;

const FOR_ORGANISATION_GQL = `
  query WorldpayApplicationForOrganisation($organisationId: UUID!) {
    worldpayApplications(where: { organisationId: { eq: $organisationId } }, orderBy: [{ createdAt: DESC }], limit: 1) { ${FIELDS} }
  }
`;

const FOR_REQUEST_GQL = `
  query WorldpayApplicationForRequest($onboardingRequestId: UUID!) {
    worldpayApplications(where: { onboardingRequestId: { eq: $onboardingRequestId } }, orderBy: [{ createdAt: DESC }], limit: 1) { ${FIELDS} }
  }
`;

const CREATE_GQL = `
  mutation CreateWorldpayApplication(
    $organisationId: UUID, $onboardingRequestId: UUID, $gphcNumber: String!, $answers: Any!,
    $legalName: String, $tradingName: String, $usesHhhWebsite: Boolean,
    $companyNumber: String, $companyStatus: String, $companyLookedUpAt: Timestamp, $companyName: String
  ) {
    worldpayApplication_insert(data: {
      organisationId: $organisationId
      onboardingRequestId: $onboardingRequestId
      gphcNumber: $gphcNumber
      status: DRAFT
      answers: $answers
      legalName: $legalName
      tradingName: $tradingName
      usesHhhWebsite: $usesHhhWebsite
      companyNumber: $companyNumber
      companyStatus: $companyStatus
      companyLookedUpAt: $companyLookedUpAt
      companyName: $companyName
    })
  }
`;

const SAVE_DRAFT_GQL = `
  mutation SaveWorldpayDraft(
    $id: UUID!, $version: Int!, $answers: Any!,
    $legalName: String, $tradingName: String, $usesHhhWebsite: Boolean,
    $companyNumber: String, $companyStatus: String, $companyLookedUpAt: Timestamp, $companyName: String
  ) {
    saved: worldpayApplication_updateMany(
      where: { id: { eq: $id }, status: { eq: DRAFT }, version: { eq: $version } }
      data: {
        answers: $answers
        version_update: [{ inc: 1 }]
        legalName: $legalName
        tradingName: $tradingName
        usesHhhWebsite: $usesHhhWebsite
        companyNumber: $companyNumber
        companyStatus: $companyStatus
        companyLookedUpAt: $companyLookedUpAt
        companyName: $companyName
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const SUBMIT_GQL = `
  mutation SubmitWorldpayApplication(
    $id: UUID!, $version: Int!, $reference: String!, $answers: Any!, $submittedAt: Timestamp!,
    $submittedByUid: String, $submitterName: String!, $submitterEmail: String!, $signerName: String!, $signerPosition: String!,
    $pdfStoragePath: String!, $xlsxStoragePath: String!,
    $legalName: String, $tradingName: String, $usesHhhWebsite: Boolean,
    $companyNumber: String, $companyStatus: String, $companyLookedUpAt: Timestamp, $companyName: String
  ) {
    submitted: worldpayApplication_updateMany(
      where: { id: { eq: $id }, status: { eq: DRAFT }, version: { eq: $version } }
      data: {
        status: SUBMITTED
        reference: $reference
        answers: $answers
        version_update: [{ inc: 1 }]
        submittedAt: $submittedAt
        submittedByUid: $submittedByUid
        submitterName: $submitterName
        submitterEmail: $submitterEmail
        signerName: $signerName
        signerPosition: $signerPosition
        pdfStoragePath: $pdfStoragePath
        xlsxStoragePath: $xlsxStoragePath
        legalName: $legalName
        tradingName: $tradingName
        usesHhhWebsite: $usesHhhWebsite
        companyNumber: $companyNumber
        companyStatus: $companyStatus
        companyLookedUpAt: $companyLookedUpAt
        companyName: $companyName
        statusChangedAt: $submittedAt
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const LAST_REFERENCE_GQL = `
  query LastWorldpayReference($from: String!, $to: String!) {
    worldpayApplications(where: { reference: { ge: $from, lt: $to } }, orderBy: [{ reference: DESC }], limit: 1) { reference }
  }
`;

const RECORD_SENT_GQL = `
  mutation RecordWorldpaySent($id: UUID!, $sentAt: Timestamp!) {
    worldpayApplication_update(key: { id: $id }, data: { sentAt: $sentAt, deliveryError: null, updatedAt_expr: "request.time" })
  }
`;

const RECORD_FAILED_GQL = `
  mutation RecordWorldpayFailed($id: UUID!, $deliveryError: String!) {
    worldpayApplication_update(key: { id: $id }, data: { deliveryError: $deliveryError, updatedAt_expr: "request.time" })
  }
`;

const SET_STATUS_GQL = `
  mutation SetWorldpayStatus($id: UUID!, $status: WorldpayApplicationStatus!, $note: String, $byUid: String, $at: Timestamp!) {
    worldpayApplication_update(key: { id: $id }, data: {
      status: $status
      statusNote: $note
      statusChangedByUid: $byUid
      statusChangedAt: $at
      updatedAt_expr: "request.time"
    })
  }
`;

const LIST_GQL = `
  query ListWorldpayApplications($limit: Int!) {
    worldpayApplications(where: { status: { ne: DRAFT } }, orderBy: [{ submittedAt: DESC }], limit: $limit) { ${FIELDS} }
  }
`;

const LINK_GQL = `
  mutation LinkWorldpayApplications($onboardingRequestId: UUID!, $organisationId: UUID!) {
    worldpayApplication_updateMany(
      where: { onboardingRequestId: { eq: $onboardingRequestId }, organisationId: { isNull: true } }
      data: { organisationId: $organisationId, updatedAt_expr: "request.time" }
    )
  }
`;

const RETENTION_CLOSED_GQL = `
  query WorldpayRetentionClosed($closedBefore: Timestamp!) {
    worldpayApplications(where: {
      status: { in: [ACCOUNT_OPEN, CONNECTED, WITHDRAWN, DECLINED] }
      statusChangedAt: { lt: $closedBefore }
      sensitiveDeletedAt: { isNull: true }
    }, limit: 200) { ${FIELDS} }
  }
`;

const RETENTION_DRAFTS_GQL = `
  query WorldpayRetentionDrafts($draftBefore: Timestamp!) {
    worldpayApplications(where: { status: { eq: DRAFT }, updatedAt: { lt: $draftBefore } }, limit: 200) { ${FIELDS} }
  }
`;

const CLEAR_SENSITIVE_GQL = `
  mutation ClearWorldpaySensitive($id: UUID!, $answers: Any!, $at: Timestamp!) {
    worldpayApplication_update(key: { id: $id }, data: {
      answers: $answers
      pdfStoragePath: null
      xlsxStoragePath: null
      sensitiveDeletedAt: $at
      updatedAt_expr: "request.time"
    })
  }
`;

const DELETE_DRAFT_GQL = `
  mutation DeleteWorldpayDraft($id: UUID!) {
    worldpayApplication_deleteMany(where: { id: { eq: $id }, status: { eq: DRAFT } })
  }
`;

const READ_CONTENT_GQL = `
  query ReadPlatformContent($keys: [String!]!) {
    platformContents(where: { key: { in: $keys } }) { key value }
  }
`;

const WRITE_CONTENT_GQL = `
  mutation WritePlatformContent($key: String!, $value: Any!, $byUid: String) {
    platformContent_upsert(data: { key: $key, value: $value, updatedByUid: $byUid, updatedAt_expr: "request.time" })
  }
`;

type Row = Omit<WorldpayApplicationRecord, 'answers'> & { answers: unknown };

/** Stored answers are re-read through the draft schema, so an old shape still loads. */
function toRecord(row: Row | null | undefined): WorldpayApplicationRecord | null {
  if (!row) return null;
  return { ...row, answers: worldpayAnswersDraftSchema.parse(row.answers ?? {}) };
}

function summaryVars(summary: WorldpayApplicationSummaryFields) {
  return {
    legalName: summary.legalName || null,
    tradingName: summary.tradingName || null,
    usesHhhWebsite: summary.usesHhhWebsite,
    companyNumber: summary.companyNumber,
    companyStatus: summary.companyStatus,
    companyLookedUpAt: summary.companyLookedUpAt,
    companyName: summary.companyName,
  };
}

export class SqlWorldpayApplicationRepository implements WorldpayApplicationRepository {
  async findById(id: string) {
    const result = await dataConnect.executeGraphql<{ worldpayApplication: Row | null }, { id: string }>(BY_ID_GQL, { variables: { id: asUuid(id) } });
    return toRecord(result.data.worldpayApplication);
  }

  async findForOrganisation(organisationId: string) {
    const result = await dataConnect.executeGraphql<{ worldpayApplications: Row[] }, { organisationId: string }>(FOR_ORGANISATION_GQL, { variables: { organisationId: asUuid(organisationId) } });
    return toRecord(result.data.worldpayApplications[0]);
  }

  async findForRequest(onboardingRequestId: string) {
    const result = await dataConnect.executeGraphql<{ worldpayApplications: Row[] }, { onboardingRequestId: string }>(FOR_REQUEST_GQL, { variables: { onboardingRequestId: asUuid(onboardingRequestId) } });
    return toRecord(result.data.worldpayApplications[0]);
  }

  async create(input: Parameters<WorldpayApplicationRepository['create']>[0]) {
    const result = await dataConnect.executeGraphql<{ worldpayApplication_insert: { id: string } }, Record<string, unknown>>(CREATE_GQL, {
      variables: {
        organisationId: input.organisationId ? asUuid(input.organisationId) : null,
        onboardingRequestId: input.onboardingRequestId ? asUuid(input.onboardingRequestId) : null,
        gphcNumber: input.gphcNumber,
        answers: input.answers,
        ...summaryVars(input),
      },
    });
    return result.data.worldpayApplication_insert.id;
  }

  async saveDraft(id: string, version: number, answers: WorldpayApplicationRecord['answers'], summary: WorldpayApplicationSummaryFields) {
    const result = await dataConnect.executeGraphql<{ saved: number }, Record<string, unknown>>(SAVE_DRAFT_GQL, {
      variables: { id: asUuid(id), version, answers, ...summaryVars(summary) },
    });
    return result.data.saved === 1;
  }

  async markSubmitted(id: string, version: number, fields: WorldpaySubmissionFields) {
    const result = await dataConnect.executeGraphql<{ submitted: number }, Record<string, unknown>>(SUBMIT_GQL, {
      variables: {
        id: asUuid(id),
        version,
        reference: fields.reference,
        answers: fields.answers,
        submittedAt: fields.submittedAt,
        submittedByUid: fields.submittedByUid,
        submitterName: fields.submitterName,
        submitterEmail: fields.submitterEmail,
        signerName: fields.signerName,
        signerPosition: fields.signerPosition,
        pdfStoragePath: fields.pdfStoragePath,
        xlsxStoragePath: fields.xlsxStoragePath,
        ...summaryVars(fields),
      },
    });
    return result.data.submitted === 1;
  }

  async lastReference(prefix: string) {
    const result = await dataConnect.executeGraphql<{ worldpayApplications: Array<{ reference: string | null }> }, { from: string; to: string }>(LAST_REFERENCE_GQL, {
      variables: { from: prefix, to: `${prefix}~` },
    });
    return result.data.worldpayApplications[0]?.reference ?? null;
  }

  async recordDelivery(id: string, result: { sentAt: string } | { deliveryError: string }) {
    if ('sentAt' in result) {
      await dataConnect.executeGraphql(RECORD_SENT_GQL, { variables: { id: asUuid(id), sentAt: result.sentAt } });
    } else {
      await dataConnect.executeGraphql(RECORD_FAILED_GQL, { variables: { id: asUuid(id), deliveryError: result.deliveryError.slice(0, 300) } });
    }
  }

  async setStatus(id: string, status: WorldpayApplicationStatus, change: { note: string | null; byUid: string | null; at: string }) {
    await dataConnect.executeGraphql(SET_STATUS_GQL, { variables: { id: asUuid(id), status, note: change.note, byUid: change.byUid, at: change.at } });
  }

  async list(limit: number) {
    const result = await dataConnect.executeGraphql<{ worldpayApplications: Row[] }, { limit: number }>(LIST_GQL, { variables: { limit } });
    return result.data.worldpayApplications.map(row => toRecord(row)!);
  }

  async linkRequestToOrganisation(onboardingRequestId: string, organisationId: string) {
    await dataConnect.executeGraphql(LINK_GQL, { variables: { onboardingRequestId: asUuid(onboardingRequestId), organisationId: asUuid(organisationId) } });
  }

  async listForRetention(closedBefore: string, draftBefore: string) {
    const [closed, drafts] = await Promise.all([
      dataConnect.executeGraphql<{ worldpayApplications: Row[] }, { closedBefore: string }>(RETENTION_CLOSED_GQL, { variables: { closedBefore } }),
      dataConnect.executeGraphql<{ worldpayApplications: Row[] }, { draftBefore: string }>(RETENTION_DRAFTS_GQL, { variables: { draftBefore } }),
    ]);
    return [...closed.data.worldpayApplications, ...drafts.data.worldpayApplications].map(row => toRecord(row)!);
  }

  async clearSensitive(id: string, answers: WorldpayApplicationRecord['answers'], at: string) {
    await dataConnect.executeGraphql(CLEAR_SENSITIVE_GQL, { variables: { id: asUuid(id), answers, at } });
  }

  async deleteDraft(id: string) {
    await dataConnect.executeGraphql(DELETE_DRAFT_GQL, { variables: { id: asUuid(id) } });
  }
}

export class SqlPlatformContentRepository implements PlatformContentRepository {
  async read(keys: string[]) {
    if (keys.length === 0) return {};
    const result = await dataConnect.executeGraphql<{ platformContents: Array<{ key: string; value: unknown }> }, { keys: string[] }>(READ_CONTENT_GQL, { variables: { keys } });
    return Object.fromEntries(result.data.platformContents.map(row => [row.key, row.value]));
  }

  async write(key: string, value: unknown, byUid: string | null) {
    await dataConnect.executeGraphql(WRITE_CONTENT_GQL, { variables: { key, value, byUid } });
  }
}
