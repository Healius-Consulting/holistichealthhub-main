import type { PartnerTermsDocumentRecord, PartnerTermsPromptRecord } from '../../domain/pharmacy-onboarding/partner-terms.js';

export interface PartnerTermsRepository {
  insertDocument(record: PartnerTermsDocumentRecord): Promise<void>;
  listDocuments(): Promise<PartnerTermsDocumentRecord[]>;
  findDocument(id: string): Promise<PartnerTermsDocumentRecord | null>;
  publishDocument(id: string, at: string, byUid: string | null): Promise<void>;
  withdrawDocument(id: string, at: string, byUid: string | null): Promise<void>;
  /** Whether any pharmacy has signed this version (withdrawal is refused once one has). */
  hasAcceptances(documentId: string): Promise<boolean>;
  findPrompt(organisationId: string, documentId: string): Promise<PartnerTermsPromptRecord | null>;
  savePrompt(record: PartnerTermsPromptRecord): Promise<void>;
  listPrompts(documentId: string): Promise<PartnerTermsPromptRecord[]>;
}
