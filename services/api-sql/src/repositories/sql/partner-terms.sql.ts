import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import { partnerTermsPromptId, type PartnerTermsDocumentRecord, type PartnerTermsPromptRecord } from '../../domain/pharmacy-onboarding/partner-terms.js';
import type { PartnerTermsRepository } from '../ports/partner-terms.port.js';

const DOCUMENT_FIELDS = `
  id
  version
  storagePath
  filename
  sizeBytes
  uploadedAt
  uploadedByUid
  publishedAt
  publishedByUid
  withdrawnAt
  withdrawnByUid
`;

const PROMPT_FIELDS = `
  id
  organisationId
  documentId
  firstViewedAt
  firstViewedByUid
  firstViewedByEmail
  lastViewedAt
  viewCount
  skipCount
  lastSkippedAt
  lastSkippedByUid
  reminderSentAt
  signedAt
`;

const INSERT_DOCUMENT_GQL = `
  mutation CreatePartnerTermsDocument(
    $id: UUID!
    $version: String!
    $storagePath: String!
    $filename: String!
    $sizeBytes: Int!
    $uploadedAt: Timestamp!
    $uploadedByUid: String
  ) {
    partnerTermsDocument_insert(data: {
      id: $id
      version: $version
      storagePath: $storagePath
      filename: $filename
      sizeBytes: $sizeBytes
      uploadedAt: $uploadedAt
      uploadedByUid: $uploadedByUid
    })
  }
`;

const LIST_DOCUMENTS_GQL = `
  query ListPartnerTermsDocuments {
    partnerTermsDocuments(orderBy: [{ uploadedAt: DESC }], limit: 200) {
      ${DOCUMENT_FIELDS}
    }
  }
`;

const FIND_DOCUMENT_GQL = `
  query FindPartnerTermsDocument($id: UUID!) {
    partnerTermsDocument(key: { id: $id }) {
      ${DOCUMENT_FIELDS}
    }
  }
`;

const PUBLISH_DOCUMENT_GQL = `
  mutation PublishPartnerTermsDocument($id: UUID!, $at: Timestamp!, $byUid: String) {
    partnerTermsDocument_update(key: { id: $id }, data: { publishedAt: $at, publishedByUid: $byUid })
  }
`;

const WITHDRAW_DOCUMENT_GQL = `
  mutation WithdrawPartnerTermsDocument($id: UUID!, $at: Timestamp!, $byUid: String) {
    partnerTermsDocument_update(key: { id: $id }, data: { withdrawnAt: $at, withdrawnByUid: $byUid })
  }
`;

const ACCEPTANCES_FOR_DOCUMENT_GQL = `
  query PartnerTermsAcceptedForDocument($documentId: UUID!) {
    partnerTermsAcceptances(where: { documentId: { eq: $documentId } }, limit: 1) {
      id
    }
  }
`;

const FIND_PROMPT_GQL = `
  query FindPartnerTermsPrompt($id: UUID!) {
    partnerTermsPrompt(key: { id: $id }) {
      ${PROMPT_FIELDS}
    }
  }
`;

/** One row per branch and version (unique on both); the upsert matches on the row's fixed id. */
const SAVE_PROMPT_GQL = `
  mutation SavePartnerTermsPrompt(
    $id: UUID!
    $organisationId: UUID!
    $documentId: UUID!
    $firstViewedAt: Timestamp
    $firstViewedByUid: String
    $firstViewedByEmail: String
    $lastViewedAt: Timestamp
    $viewCount: Int!
    $skipCount: Int!
    $lastSkippedAt: Timestamp
    $lastSkippedByUid: String
    $reminderSentAt: Timestamp
    $signedAt: Timestamp
  ) {
    partnerTermsPrompt_upsert(data: {
      id: $id
      organisationId: $organisationId
      documentId: $documentId
      firstViewedAt: $firstViewedAt
      firstViewedByUid: $firstViewedByUid
      firstViewedByEmail: $firstViewedByEmail
      lastViewedAt: $lastViewedAt
      viewCount: $viewCount
      skipCount: $skipCount
      lastSkippedAt: $lastSkippedAt
      lastSkippedByUid: $lastSkippedByUid
      reminderSentAt: $reminderSentAt
      signedAt: $signedAt
    })
  }
`;

const LIST_PROMPTS_GQL = `
  query ListPartnerTermsPrompts($documentId: UUID!) {
    partnerTermsPrompts(where: { documentId: { eq: $documentId } }, limit: 2000) {
      ${PROMPT_FIELDS}
    }
  }
`;

type RawDocument = Omit<PartnerTermsDocumentRecord, 'uploadedByUid' | 'publishedAt' | 'publishedByUid' | 'withdrawnAt' | 'withdrawnByUid'> & Partial<Record<'uploadedByUid' | 'publishedAt' | 'publishedByUid' | 'withdrawnAt' | 'withdrawnByUid', string | null>>;

function toDocument(row: RawDocument): PartnerTermsDocumentRecord {
  return {
    ...row,
    sizeBytes: Number(row.sizeBytes ?? 0),
    uploadedByUid: row.uploadedByUid ?? null,
    publishedAt: row.publishedAt ?? null,
    publishedByUid: row.publishedByUid ?? null,
    withdrawnAt: row.withdrawnAt ?? null,
    withdrawnByUid: row.withdrawnByUid ?? null,
  };
}

function toPrompt(row: Partial<PartnerTermsPromptRecord> & Pick<PartnerTermsPromptRecord, 'id' | 'organisationId' | 'documentId'>): PartnerTermsPromptRecord {
  return {
    id: row.id,
    organisationId: row.organisationId,
    documentId: row.documentId,
    firstViewedAt: row.firstViewedAt ?? null,
    firstViewedByUid: row.firstViewedByUid ?? null,
    firstViewedByEmail: row.firstViewedByEmail ?? null,
    lastViewedAt: row.lastViewedAt ?? null,
    viewCount: Number(row.viewCount ?? 0),
    skipCount: Number(row.skipCount ?? 0),
    lastSkippedAt: row.lastSkippedAt ?? null,
    lastSkippedByUid: row.lastSkippedByUid ?? null,
    reminderSentAt: row.reminderSentAt ?? null,
    signedAt: row.signedAt ?? null,
  };
}

export class SqlPartnerTermsRepository implements PartnerTermsRepository {
  async insertDocument(record: PartnerTermsDocumentRecord): Promise<void> {
    await dataConnect.executeGraphql<unknown, Record<string, unknown>>(INSERT_DOCUMENT_GQL, {
      variables: {
        id: asUuid(record.id),
        version: record.version,
        storagePath: record.storagePath,
        filename: record.filename,
        sizeBytes: record.sizeBytes,
        uploadedAt: record.uploadedAt,
        uploadedByUid: record.uploadedByUid,
      },
    });
  }

  async listDocuments(): Promise<PartnerTermsDocumentRecord[]> {
    const result = await dataConnect.executeGraphql<{ partnerTermsDocuments: RawDocument[] }, Record<string, never>>(LIST_DOCUMENTS_GQL, { variables: {} });
    return (result.data.partnerTermsDocuments ?? []).map(toDocument);
  }

  async findDocument(id: string): Promise<PartnerTermsDocumentRecord | null> {
    const result = await dataConnect.executeGraphql<{ partnerTermsDocument: RawDocument | null }, { id: string }>(FIND_DOCUMENT_GQL, { variables: { id: asUuid(id) } });
    return result.data.partnerTermsDocument ? toDocument(result.data.partnerTermsDocument) : null;
  }

  async publishDocument(id: string, at: string, byUid: string | null): Promise<void> {
    await dataConnect.executeGraphql<unknown, { id: string; at: string; byUid: string | null }>(PUBLISH_DOCUMENT_GQL, { variables: { id: asUuid(id), at, byUid } });
  }

  async withdrawDocument(id: string, at: string, byUid: string | null): Promise<void> {
    await dataConnect.executeGraphql<unknown, { id: string; at: string; byUid: string | null }>(WITHDRAW_DOCUMENT_GQL, { variables: { id: asUuid(id), at, byUid } });
  }

  async hasAcceptances(documentId: string): Promise<boolean> {
    const result = await dataConnect.executeGraphql<{ partnerTermsAcceptances: Array<{ id: string }> }, { documentId: string }>(ACCEPTANCES_FOR_DOCUMENT_GQL, {
      variables: { documentId: asUuid(documentId) },
    });
    return (result.data.partnerTermsAcceptances ?? []).length > 0;
  }

  async findPrompt(organisationId: string, documentId: string): Promise<PartnerTermsPromptRecord | null> {
    const result = await dataConnect.executeGraphql<{ partnerTermsPrompt: PartnerTermsPromptRecord | null }, { id: string }>(FIND_PROMPT_GQL, {
      variables: { id: partnerTermsPromptId(organisationId, documentId) },
    });
    return result.data.partnerTermsPrompt ? toPrompt(result.data.partnerTermsPrompt) : null;
  }

  async savePrompt(record: PartnerTermsPromptRecord): Promise<void> {
    await dataConnect.executeGraphql<unknown, Record<string, unknown>>(SAVE_PROMPT_GQL, {
      variables: {
        ...record,
        id: asUuid(record.id),
        organisationId: asUuid(record.organisationId),
        documentId: asUuid(record.documentId),
      },
    });
  }

  async listPrompts(documentId: string): Promise<PartnerTermsPromptRecord[]> {
    const result = await dataConnect.executeGraphql<{ partnerTermsPrompts: PartnerTermsPromptRecord[] }, { documentId: string }>(LIST_PROMPTS_GQL, {
      variables: { documentId: asUuid(documentId) },
    });
    return (result.data.partnerTermsPrompts ?? []).map(toPrompt);
  }
}
