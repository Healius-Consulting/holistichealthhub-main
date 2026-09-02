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

export interface DeclineSubmissionInput {
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
}
