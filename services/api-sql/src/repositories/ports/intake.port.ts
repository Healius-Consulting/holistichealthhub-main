import type { FormConditionRecord } from '../../domain/eligibility/form-conditions.js';
export interface CreateSubmissionInput {
  sourceOrganisationId?: string | null;
  assignedOrganisationId?: string | null;
  sourceType: 'GENERAL_HHH_WEBSITE' | 'PHARMACY_QR' | 'LEGACY_PHARMACY_QR';
  firstName: string;
  surname: string;
  dob: string;
  mobile: string;
  email: string;
  emailHash: string;
  postcode: string;
  triedTwoTreatments: boolean;
  psychiatricExclusion: boolean;
  heardAbout?: string | null;
  conditionCodes: string[];
  primaryConditionCode: string;
  idempotencyKeyHash: string;
  assignmentStatus: 'AWAITING_HHH_ALLOCATION' | 'PROVISIONAL' | 'CONFIRMED';
  pharmacyAccessStatus: 'WITHHELD' | 'ACTIVATED';
  consentVersion: string;
  referralConsent: boolean;
  dataSharingConsent: boolean;
  marketingConsent: boolean;
  privacyNoticeVersion: string;
  termsVersion?: string | null;
  referralConsentVersion?: string | null;
  dataSharingConsentVersion?: string | null;
  marketingConsentVersion?: string | null;
  submissionIpHash?: string | null;
  outcomeStatus?: 'OPEN' | 'DECLINED';
  declineRule?: string | null;
  declinedAt?: string | null;
}

export interface SubmissionQueueItem {
  id: string;
  firstName: string;
  surname: string;
  dob: string;
  mobile: string;
  email: string;
  postcode: string;
  assignmentStatus: string;
  pharmacyReviewStatus: string;
  outcomeStatus: string;
  followUpStatus: string;
  submittedAt: string;
  updatedAt: string;
}

export interface RetentionCandidateRecord {
  id: string;
  outcomeStatus: 'OPEN' | 'COMPLETED' | 'DECLINED' | 'WITHDRAWN';
  completedAt: string | null;
  /** Stands in for "last activity": any write to the case touches it. */
  updatedAt: string;
  minimalRecordSince: string | null;
}

export interface DeclinedSubmissionRecord {
  id: string;
  submittedAt: string;
  sourceType: 'GENERAL_HHH_WEBSITE' | 'PHARMACY_QR' | 'LEGACY_PHARMACY_QR';
  firstName: string;
  surname: string;
  dob: string;
  email: string;
  mobile: string;
  postcode: string;
  assignedOrganisationId: string | null;
  declineRule: string | null;
  declinedAt: string | null;
  reviewRequestedAt: string | null;
  reviewRequestedNote: string | null;
}

export interface TenantPendingEnquiryRecord {
  id: string;
  submittedAt: string;
  followUpStatus: string;
  sourceType: 'GENERAL_HHH_WEBSITE' | 'PHARMACY_QR' | 'LEGACY_PHARMACY_QR';
  firstName: string;
  surname: string;
  dob: string;
  email: string;
  mobile: string;
  postcode: string;
  conditionCodes?: string[] | null;
  primaryConditionCode?: string | null;
  triedTwoTreatments?: boolean | null;
  psychiatricExclusion?: boolean | null;
  heardAbout?: string | null;
}

export interface IdempotentSubmissionRecord {
  id: string;
  assignedOrganisationId: string | null;
  assignmentStatus: string;
  submittedAt: string;
}

export interface PlatformSubmissionRecord extends SubmissionQueueItem {
  sourceOrganisationId: string | null;
  assignedOrganisationId: string | null;
  sourceType: 'GENERAL_HHH_WEBSITE' | 'PHARMACY_QR' | 'LEGACY_PHARMACY_QR';
  emailHash: string;
  triedTwoTreatments: boolean;
  psychiatricExclusion: boolean;
  heardAbout: string | null;
  conditionCodes?: string[] | null;
  primaryConditionCode?: string | null;
  assignmentVersion: number;
  pharmacyAccessStatus: string;
  onboardingDecision: string;
  assignmentReason: string | null;
  privateAllocationNote: string | null;
  privateOnboardingNote: string | null;
  declineReason?: string | null;
  consentVersion: string;
  referralConsent: boolean;
  dataSharingConsent: boolean;
  marketingConsent: boolean;
  privacyNoticeVersion: string;
  allocationCompletedAt: string | null;
  operationalStartedAt: string | null;
  reviewedAt: string | null;
  completedAt: string | null;
}

export interface SubmissionConditionRecord {
  conditionCode: string;
  primary: boolean;
}

export interface ReassignSubmissionInput {
  id: string;
  newOrganisationId: string;
  expectedAssignmentVersion: number;
  newAssignmentVersion: number;
  actorUid: string;
  reasonCode: string;
  note: string | null;
  /** How the patient agreed to the transfer, and when. Required once a pharmacy is assigned. */
  patientAgreementChannel: string | null;
}

export interface UpdateSubmissionFollowUpInput {
  id: string;
  expectedAssignmentVersion: number;
  newAssignmentVersion: number;
  followUpStatus: 'NOT_STARTED' | 'DUE' | 'ATTEMPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNABLE_TO_CONTACT';
}

export interface ActivateSubmissionInput {
  id: string;
  patientId: string;
  organisationId: string;
  expectedAssignmentVersion: number;
  newAssignmentVersion: number;
  firstName: string;
  surname: string;
  dob: string;
  email: string;
  emailHash: string;
  mobile: string;
  postcode: string;
  onboardingNote: string | null;
}

/**
 * Why an administrator declined an application. Never quoted to the patient; it
 * chooses which wording they are sent and it explains the decision in the audit log.
 */
export type DeclineReason =
  | 'ELIGIBILITY_NOT_MET'
  | 'PSYCHIATRIC_EXCLUSION'
  | 'CLINICAL_UNSUITABILITY'
  | 'INCOMPLETE_INFORMATION'
  | 'NO_RESPONSE'
  | 'OTHER';

export const DECLINE_REASONS: readonly DeclineReason[] = [
  'ELIGIBILITY_NOT_MET',
  'PSYCHIATRIC_EXCLUSION',
  'CLINICAL_UNSUITABILITY',
  'INCOMPLETE_INFORMATION',
  'NO_RESPONSE',
  'OTHER',
];

export interface DeclineSubmissionInput {
  id: string;
  expectedAssignmentVersion: number;
  newAssignmentVersion: number;
  onboardingNote: string | null;
  reason: DeclineReason;
}

export interface WithdrawSubmissionInput {
  id: string;
  expectedAssignmentVersion: number;
  newAssignmentVersion: number;
  onboardingNote: string | null;
}

export interface IntakeRepositoryPort {
  createSubmission(input: CreateSubmissionInput): Promise<{ id?: string }>;
  findSubmissionById(id: string): Promise<any | null>;
  findSubmissionByIdempotencyHash(idempotencyKeyHash: string): Promise<IdempotentSubmissionRecord | null>;
  saveSubmissionConditions(submissionId: string, conditionCodes: string[], primaryConditionCode: string): Promise<void>;
  listTenantPendingEnquiries(organisationId: string, limit?: number): Promise<TenantPendingEnquiryRecord[]>;
  listPlatformSubmissions(limit?: number): Promise<PlatformSubmissionRecord[]>;
  listDeclinedSubmissions(limit?: number): Promise<DeclinedSubmissionRecord[]>;
  listRetentionCandidates(limit?: number): Promise<RetentionCandidateRecord[]>;
  reduceToMinimalRecord(id: string): Promise<void>;
  deleteSubmission(id: string): Promise<void>;
  markReviewRequested(id: string, note?: string | null): Promise<void>;
  listSubmissionConditions(submissionId: string): Promise<SubmissionConditionRecord[]>;
  reassignPendingSubmission(input: ReassignSubmissionInput): Promise<void>;
  updateSubmissionFollowUp(input: UpdateSubmissionFollowUpInput): Promise<void>;
  activateSubmission(input: ActivateSubmissionInput): Promise<void>;
  copySubmissionConditionsToPatient(patientId: string, submissionId: string): Promise<void>;
  /** Replace a submission's conditions with exactly this set, removing any dropped. */
  rewriteSubmissionConditions(submissionId: string, records: FormConditionRecord[]): Promise<void>;
  /** Replace a patient's condition rows with exactly this set, removing any dropped. */
  rewritePatientConditions(patientId: string, existing: FormConditionRecord[], records: FormConditionRecord[]): Promise<void>;
  declineSubmission(input: DeclineSubmissionInput): Promise<void>;
  withdrawSubmission(input: WithdrawSubmissionInput): Promise<void>;
}
