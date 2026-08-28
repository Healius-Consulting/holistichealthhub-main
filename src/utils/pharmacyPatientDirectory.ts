import type { PortalPatientRecord, PortalPendingEnquiryRecord } from '../shared/contracts';

export type PharmacyCrmStatus = 'Referred' | 'HHH approved' | 'Suspended';

export interface PharmacyDirectoryPatient {
  id: string;
  organisationId: string;
  name: string;
  email: string;
  mobile: string;
  dob?: string;
  address?: string;
  postcode?: string;
  conditions?: string[];
  primaryCondition?: string | null;
  referralSource?: string | null;
  marketingConsent?: boolean | null;
  triedTwoTreatments?: boolean | null;
  psychiatricExclusion?: boolean | null;
  heardAbout?: string | null;
  status: PharmacyCrmStatus;
}

export interface PharmacyTrainingSubmission {
  status: string;
  conditions: string[];
  primaryCondition: string;
  source: string;
  marketing: boolean;
  tried2: boolean;
  psychExclusion: boolean;
}

export type PatientJourneyStage = 'enquiry' | 'referred' | 'active' | 'declined' | 'suspended';

export interface PatientClinicalProfile {
  conditions: string[];
  primaryCondition: string;
  referralSource: string | null;
  heardAbout: string | null;
  marketingConsent: boolean | null;
  triedTwoTreatments: boolean | null;
  psychiatricExclusion: boolean | null;
  onboardingLabel: string | null;
  onboardingPillStatus: string | null;
  fromSubmission: boolean;
}

export function mapPortalPatientRecord(record: PortalPatientRecord): PharmacyDirectoryPatient {
  return {
    id: record.id,
    organisationId: record.organisationId,
    name: `${record.firstName} ${record.surname}`.trim(),
    email: record.email,
    mobile: record.mobile,
    dob: record.dob,
    address: [record.address, record.postcode].filter(Boolean).join(', '),
    postcode: record.postcode,
    conditions: record.conditions ?? (record.primaryCondition ? [record.primaryCondition] : []),
    primaryCondition: record.primaryCondition ?? record.conditions?.[0] ?? null,
    referralSource: record.referralSource ?? null,
    marketingConsent: record.marketingConsent ?? null,
    triedTwoTreatments: record.triedTwoTreatments ?? null,
    psychiatricExclusion: record.psychiatricExclusion ?? null,
    heardAbout: record.heardAbout ?? null,
    status: record.status === 'active' ? 'HHH approved' : record.status === 'referred' ? 'Referred' : 'Suspended',
  };
}

export function mapPortalEnquiryRecord(organisationId: string, record: PortalPendingEnquiryRecord) {
  return { ...record, organisationId };
}

export function portalSourceLabel(sourceType: PortalPendingEnquiryRecord['sourceType'] | string | null | undefined) {
  switch (sourceType) {
    case 'future_pharmacy_qr':
      return 'Pharmacy QR link';
    case 'legacy_pharmacy_qr':
      return 'Legacy pharmacy QR';
    case 'general_hhh_website':
      return 'HHH website';
    default:
      return null;
  }
}

export function patientClinicalProfile(input: {
  crmPatient: PharmacyDirectoryPatient | null;
  submission: PharmacyTrainingSubmission | null;
}): PatientClinicalProfile {
  const { crmPatient, submission } = input;
  if (submission) {
    return {
      conditions: submission.conditions,
      primaryCondition: submission.primaryCondition,
      referralSource: submission.source,
      heardAbout: null,
      marketingConsent: submission.marketing,
      triedTwoTreatments: submission.tried2,
      psychiatricExclusion: submission.psychExclusion,
      onboardingLabel: submission.status,
      onboardingPillStatus: submission.status,
      fromSubmission: true,
    };
  }
  return {
    conditions: crmPatient?.conditions ?? [],
    primaryCondition: crmPatient?.primaryCondition ?? crmPatient?.conditions?.[0] ?? '',
    referralSource: crmPatient?.referralSource ?? null,
    heardAbout: crmPatient?.heardAbout ?? null,
    marketingConsent: crmPatient?.marketingConsent ?? null,
    triedTwoTreatments: crmPatient?.triedTwoTreatments ?? null,
    psychiatricExclusion: crmPatient?.psychiatricExclusion ?? null,
    onboardingLabel: crmPatient?.status ?? null,
    onboardingPillStatus: crmPatient?.status === 'Referred' ? 'Approved' : crmPatient?.status ?? null,
    fromSubmission: false,
  };
}

export function derivePatientJourneyStage(input: {
  crmPatient: PharmacyDirectoryPatient | null;
  submission: PharmacyTrainingSubmission | null;
  orderCount: number;
  isNegativeEligibility: (status: string) => boolean;
}): PatientJourneyStage {
  const { crmPatient, submission, orderCount, isNegativeEligibility } = input;
  if (submission && isNegativeEligibility(submission.status)) return 'declined';
  if (crmPatient?.status === 'Suspended') return 'suspended';
  if (orderCount > 0 || crmPatient?.status === 'HHH approved') return 'active';
  if (submission?.status === 'Approved' || crmPatient?.status === 'Referred') return 'referred';
  if (submission && (submission.status === 'New' || submission.status === 'Under HHH review')) return 'enquiry';
  if (crmPatient) return crmPatient.status === 'Referred' ? 'referred' : 'active';
  return 'enquiry';
}

export const PATIENT_JOURNEY_STEPS = [
  { key: 'enquiry' as const, label: 'Enquiry' },
  { key: 'referred' as const, label: 'Referred' },
  { key: 'active' as const, label: 'Active care' },
] as const;

export function patientJourneyStepIndex(stage: PatientJourneyStage) {
  if (stage === 'referred') return 1;
  if (stage === 'active') return 2;
  return 0;
}
