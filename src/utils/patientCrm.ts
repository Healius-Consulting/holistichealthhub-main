import type { PatientJourneyStage } from './pharmacyPatientDirectory';

export const PATIENT_CRM_FILTERS = ['all', 'enquiries', 'active', 'on-order', 'needs-action', 'ready', 'declined'] as const;
export type PatientDirectoryFilter = (typeof PATIENT_CRM_FILTERS)[number];

export const PATIENT_CRM_PRIMARY_FILTERS: Array<{ key: PatientDirectoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'enquiries', label: 'Enquiries' },
  { key: 'active', label: 'Active' },
  { key: 'on-order', label: 'On order' },
];

export const PATIENT_CRM_SECONDARY_FILTERS: Array<{ key: PatientDirectoryFilter; label: string }> = [
  { key: 'needs-action', label: 'Needs action' },
  { key: 'ready', label: 'Ready to collect' },
  { key: 'declined', label: 'Declined' },
];

export type PatientCrmKind = 'enquiry' | 'patient';
export type PatientCrmTone = 'warning' | 'danger' | 'ready' | 'paid' | 'info' | 'neutral' | 'collected' | 'curaleaf-picking';
export type PatientCrmIcon = 'inbox' | 'alert' | 'package' | 'check' | 'users' | 'clock' | 'lock';
export type PatientCrmGroup = 'needs-action' | 'enquiries' | 'ready' | 'on-order' | 'care' | 'declined';

export interface PatientCrmFilterInput {
  kind: PatientCrmKind;
  journey: PatientJourneyStage;
  hasCrmRecord: boolean;
  hasOpenOrder: boolean;
  needsAction: boolean;
  readyForCollection: boolean;
}

export function isSupportedPatientCrmFilter(value: string): value is PatientDirectoryFilter {
  return (PATIENT_CRM_FILTERS as readonly string[]).includes(value);
}

export function recordMatchesPatientFilter(record: PatientCrmFilterInput, filter: PatientDirectoryFilter) {
  switch (filter) {
    case 'all':
      return true;
    case 'enquiries':
      return record.kind === 'enquiry';
    case 'active':
      return record.kind === 'patient' && record.hasCrmRecord && record.journey !== 'declined' && record.journey !== 'suspended';
    case 'on-order':
      return record.hasOpenOrder;
    case 'needs-action':
      return record.needsAction;
    case 'ready':
      return record.readyForCollection;
    case 'declined':
      return record.journey === 'declined' || record.journey === 'suspended';
  }
}

export function patientCrmGroup(record: PatientCrmFilterInput): PatientCrmGroup {
  if (record.needsAction) return 'needs-action';
  if (record.kind === 'enquiry') return record.journey === 'declined' ? 'declined' : 'enquiries';
  if (record.readyForCollection) return 'ready';
  if (record.hasOpenOrder) return 'on-order';
  if (record.journey === 'declined' || record.journey === 'suspended') return 'declined';
  return 'care';
}

export type PatientCrmLane = 'needs-action' | 'enquiries' | 'ready' | 'on-order' | 'care' | 'declined';

export const PATIENT_CRM_LANES: Array<{ key: PatientCrmLane; label: string; detail: string }> = [
  { key: 'needs-action', label: 'Needs action', detail: 'Exceptions, refunds and cancellations' },
  { key: 'enquiries', label: 'New enquiries', detail: 'Assigned to you; HHH may still move them' },
  { key: 'ready', label: 'Ready to collect', detail: 'Arrived at pharmacy and waiting for the patient' },
  { key: 'on-order', label: 'On order', detail: 'Draft, payment or fulfilment' },
  { key: 'care', label: 'Referred & active', detail: 'In care after HHH referral' },
];

export const PATIENT_CRM_CLOSED_LANE: { key: PatientCrmLane; label: string; detail: string } = {
  key: 'declined',
  label: 'Declined & suspended',
  detail: 'Closed to ordering',
};

export function patientCrmLane(record: PatientCrmFilterInput): PatientCrmLane {
  if (record.needsAction) return 'needs-action';
  if (record.kind === 'enquiry') return record.journey === 'declined' ? 'declined' : 'enquiries';
  if (record.journey === 'declined' || record.journey === 'suspended') return 'declined';
  if (record.readyForCollection) return 'ready';
  if (record.hasOpenOrder) return 'on-order';
  return 'care';
}

export const PATIENT_DIRECTORY_CHIPS = ['all', 'Enquiries', 'Referred', 'Active', 'Inactive', 'Declined'] as const;
export type PatientDirectoryChip = (typeof PATIENT_DIRECTORY_CHIPS)[number];
export type PatientEnquiryDirectoryStatus = 'New enquiry' | 'In progress' | 'Declined' | 'Withdrawn';
export type PatientDirectoryStatus = Exclude<PatientDirectoryChip, 'all' | 'Enquiries'> | PatientEnquiryDirectoryStatus;

/**
 * Enquiries assigned to this pharmacy: New until HHH records a review status, then
 * In progress until HHH refers (a patient record takes over), declines or the patient withdraws.
 */
export function enquiryDirectoryStatus(displayStatus: string): PatientEnquiryDirectoryStatus {
  if (displayStatus === 'Declined' || displayStatus === 'Withdrawn' || displayStatus === 'In progress') return displayStatus;
  return displayStatus === 'Under HHH review' ? 'In progress' : 'New enquiry';
}

export function isOpenEnquiryStatus(status: PatientDirectoryStatus) {
  return status === 'New enquiry' || status === 'In progress';
}

export function directoryStatusMatchesChip(status: PatientDirectoryStatus, chip: PatientDirectoryChip) {
  if (chip === 'all') return true;
  if (chip === 'Enquiries') return isOpenEnquiryStatus(status);
  if (chip === 'Declined') return status === 'Declined' || status === 'Withdrawn';
  return status === chip;
}

/** The referral period narrows the Referred tag only; other tags list every referral date. */
export function referralPeriodApplies(chip: PatientDirectoryChip) {
  return chip === 'Referred';
}

export function patientCrmRecordKey(kind: PatientCrmKind, id: string) {
  return `${kind}:${id}`;
}

export function parsePatientCrmRecordKey(value: string | null): { kind: PatientCrmKind; id: string } | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if ((kind !== 'enquiry' && kind !== 'patient') || !id) return null;
  return { kind, id };
}

export function patientCrmStatusMeta(input: PatientCrmFilterInput & { statusLabel?: string }) {
  const group = patientCrmGroup(input);
  const label = (input.statusLabel ?? '').toLowerCase();
  if (group === 'needs-action') {
    if (label.includes('refund')) {
      return { label: 'Refund pending', description: 'Confirm the patient refund before closing this case.', tone: 'warning' as const, icon: 'alert' as const };
    }
    return { label: 'Needs action', description: 'A paid order or cancellation needs pharmacy follow-up.', tone: 'danger' as const, icon: 'alert' as const };
  }
  if (group === 'enquiries') {
    if (label === 'in progress') {
      return { label: 'In progress', description: 'HHH is reviewing this enquiry. HHH may still move them; orders stay locked until referral.', tone: 'warning' as const, icon: 'clock' as const };
    }
    return { label: 'New enquiry', description: 'Assigned to this pharmacy. HHH may still move them; orders stay locked until referral.', tone: 'info' as const, icon: 'inbox' as const };
  }
  if (group === 'declined' && input.kind === 'enquiry') {
    return label === 'withdrawn'
      ? { label: 'Withdrawn', description: 'The patient withdrew this enquiry. It will not be referred.', tone: 'neutral' as const, icon: 'lock' as const }
      : { label: 'Declined', description: 'HHH declined this enquiry. It will not be referred.', tone: 'neutral' as const, icon: 'lock' as const };
  }
  if (group === 'ready') {
    return { label: 'Ready to collect', description: 'Medicine is checked in and waiting for patient collection.', tone: 'ready' as const, icon: 'package' as const };
  }
  if (group === 'on-order') {
    if (label.includes('awaiting payment')) {
      return { label: 'Awaiting payment', description: 'Payment link is with the patient.', tone: 'warning' as const, icon: 'clock' as const };
    }
    return { label: 'On order', description: 'A prescription order is in payment or fulfilment.', tone: 'curaleaf-picking' as const, icon: 'package' as const };
  }
  if (group === 'declined') {
    return { label: input.journey === 'suspended' ? 'Suspended' : 'Declined', description: 'This record is closed to ordering.', tone: 'neutral' as const, icon: 'lock' as const };
  }
  if (input.journey === 'referred') {
    return { label: 'Referred', description: 'HHH has referred this patient. Ordering unlocks when the workspace is live.', tone: 'paid' as const, icon: 'check' as const };
  }
  return { label: 'Active', description: 'This patient is in care with no open order needing attention.', tone: 'paid' as const, icon: 'check' as const };
}
