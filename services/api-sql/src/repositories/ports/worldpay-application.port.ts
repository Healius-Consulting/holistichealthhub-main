import type { WorldpayAnswers } from '../../domain/worldpay-application/answers.js';

export type WorldpayApplicationStatus =
  | 'DRAFT' | 'SUBMITTED' | 'WITH_WORLDPAY' | 'QUERY' | 'ACCOUNT_OPEN' | 'CONNECTED' | 'WITHDRAWN' | 'DECLINED';

export interface WorldpayApplicationRecord {
  id: string;
  organisationId: string | null;
  onboardingRequestId: string | null;
  gphcNumber: string;
  status: WorldpayApplicationStatus;
  reference: string | null;
  answers: WorldpayAnswers;
  version: number;
  legalName: string | null;
  tradingName: string | null;
  usesHhhWebsite: boolean | null;
  companyNumber: string | null;
  companyStatus: string | null;
  companyLookedUpAt: string | null;
  companyName: string | null;
  submittedAt: string | null;
  submittedByUid: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  signerName: string | null;
  signerPosition: string | null;
  pdfStoragePath: string | null;
  xlsxStoragePath: string | null;
  sentAt: string | null;
  deliveryError: string | null;
  statusNote: string | null;
  statusChangedAt: string | null;
  statusChangedByUid: string | null;
  sensitiveDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The copies of answer fields kept in their own columns for the admin list and admin checks. */
export interface WorldpayApplicationSummaryFields {
  legalName: string;
  tradingName: string;
  usesHhhWebsite: boolean;
  companyNumber: string | null;
  companyStatus: string | null;
  companyLookedUpAt: string | null;
  companyName: string | null;
}

export interface WorldpaySubmissionFields extends WorldpayApplicationSummaryFields {
  reference: string;
  answers: WorldpayAnswers;
  submittedAt: string;
  submittedByUid: string | null;
  submitterName: string;
  submitterEmail: string;
  signerName: string;
  signerPosition: string;
  pdfStoragePath: string;
  xlsxStoragePath: string;
}

export interface WorldpayApplicationRepository {
  findById(id: string): Promise<WorldpayApplicationRecord | null>;
  /** The branch's latest application. */
  findForOrganisation(organisationId: string): Promise<WorldpayApplicationRecord | null>;
  /** The latest application started on the onboarding page for this request. */
  findForRequest(onboardingRequestId: string): Promise<WorldpayApplicationRecord | null>;
  create(input: { organisationId: string | null; onboardingRequestId: string | null; gphcNumber: string; answers: WorldpayAnswers } & WorldpayApplicationSummaryFields): Promise<string>;
  /** Saves a draft only if it is still a draft at `version`; false when someone else saved first or it was submitted. */
  saveDraft(id: string, version: number, answers: WorldpayAnswers, summary: WorldpayApplicationSummaryFields): Promise<boolean>;
  /** Submits a draft at `version`; false when it is no longer that draft. */
  markSubmitted(id: string, version: number, fields: WorldpaySubmissionFields): Promise<boolean>;
  /** The highest reference given so far with this prefix (e.g. `HHH-WP-2026-`). */
  lastReference(prefix: string): Promise<string | null>;
  recordDelivery(id: string, result: { sentAt: string } | { deliveryError: string }): Promise<void>;
  setStatus(id: string, status: WorldpayApplicationStatus, change: { note: string | null; byUid: string | null; at: string }): Promise<void>;
  list(limit: number): Promise<WorldpayApplicationRecord[]>;
  /** At activation: the request's applications become the branch's. */
  linkRequestToOrganisation(onboardingRequestId: string, organisationId: string): Promise<void>;
  /** Closed applications whose last status change is before `closedBefore` and still hold sensitive data, and drafts untouched since `draftBefore`. */
  listForRetention(closedBefore: string, draftBefore: string): Promise<WorldpayApplicationRecord[]>;
  clearSensitive(id: string, answers: WorldpayAnswers, at: string): Promise<void>;
  deleteDraft(id: string): Promise<void>;
}

export interface PlatformContentRepository {
  read(keys: string[]): Promise<Record<string, unknown>>;
  write(key: string, value: unknown, byUid: string | null): Promise<void>;
}
