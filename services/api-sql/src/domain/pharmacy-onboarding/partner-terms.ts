import { nameBasedUuid, uuidKey } from '../common/uuid.js';

/**
 * The Partner Terms as uploaded, versioned PDFs (19 Nov 2026 brief, section 4: the
 * Terms are with a solicitor, so acceptance stays off until HHH switches it on).
 *
 * Each upload is a draft until published. The current version is the one pharmacies
 * sign; every new published version asks each activated branch to sign again at its
 * next login (skippable, tracked per branch in PartnerTermsPrompt). New sign-ups must
 * sign it while acceptance is on.
 */

export type PartnerTermsDocumentRecord = {
  id: string;
  version: string;
  storagePath: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByUid: string | null;
  publishedAt: string | null;
  publishedByUid: string | null;
  withdrawnAt: string | null;
  withdrawnByUid: string | null;
};

export type PartnerTermsPromptRecord = {
  id: string;
  organisationId: string;
  documentId: string;
  firstViewedAt: string | null;
  firstViewedByUid: string | null;
  firstViewedByEmail: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  skipCount: number;
  lastSkippedAt: string | null;
  lastSkippedByUid: string | null;
  reminderSentAt: string | null;
  signedAt: string | null;
};

/** One row per branch and version; the upsert matches on this fixed id. */
export function partnerTermsPromptId(organisationId: string, documentId: string) {
  return nameBasedUuid('partner-terms-prompt', uuidKey(organisationId), uuidKey(documentId));
}

export function emptyPrompt(organisationId: string, documentId: string): PartnerTermsPromptRecord {
  return {
    id: partnerTermsPromptId(organisationId, documentId),
    organisationId,
    documentId,
    firstViewedAt: null,
    firstViewedByUid: null,
    firstViewedByEmail: null,
    lastViewedAt: null,
    viewCount: 0,
    skipCount: 0,
    lastSkippedAt: null,
    lastSkippedByUid: null,
    reminderSentAt: null,
    signedAt: null,
  };
}

/** Days after first being shown, unsigned, before the reminder email. */
export const PARTNER_TERMS_REMINDER_DAYS = 7;

/** Branch statuses that can log in and so are asked to sign. */
export const PROMPTED_BRANCH_STATUSES = new Set(['ONBOARDING', 'INTAKE_LIVE', 'LIVE']);

export const MAX_PARTNER_TERMS_PDF_BYTES = 10 * 1024 * 1024;
