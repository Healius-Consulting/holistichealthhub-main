import type { PlatformSubmissionRecord, SubmissionConditionRecord } from '../../repositories/ports/intake.port.js';
import { portalSourceType } from './intake-source.js';

function lower(value: string) {
  return value.toLowerCase();
}

export function isDedicatedSqlIntake(sourceType: PlatformSubmissionRecord['sourceType']) {
  return sourceType === 'PHARMACY_QR' || sourceType === 'LEGACY_PHARMACY_QR';
}

export function sqlIntakeCaseReference(id: string, submittedAt: string) {
  const day = submittedAt.slice(0, 10).replaceAll('-', '');
  return `HHH-${day}-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

export function sqlIntakeDisplayStatus(record: PlatformSubmissionRecord) {
  if (record.pharmacyAccessStatus !== 'ACTIVATED') return 'Awaiting referral decision';
  if (record.assignmentStatus !== 'CONFIRMED') return 'Pending allocation review';
  if (record.pharmacyReviewStatus === 'NOT_OPENED') return 'Assignment confirmed';
  return 'Under pharmacy review';
}

export function isOpenSqlIntake(record: PlatformSubmissionRecord) {
  return !['COMPLETED', 'DECLINED', 'WITHDRAWN'].includes(record.outcomeStatus);
}

export function toAdminIntakeQueueItem(record: PlatformSubmissionRecord) {
  return {
    id: record.id,
    caseReference: sqlIntakeCaseReference(record.id, record.submittedAt),
    patientDisplayName: `${record.firstName} ${record.surname}`.trim(),
    submittedAt: record.submittedAt,
    displayStatus: sqlIntakeDisplayStatus(record),
    assignmentStatus: lower(record.assignmentStatus),
    pharmacyReviewStatus: lower(record.pharmacyReviewStatus),
    outcomeStatus: lower(record.outcomeStatus),
    version: record.assignmentVersion,
    legacy: record.sourceType === 'LEGACY_PHARMACY_QR',
    sourceType: portalSourceType(record.sourceType) ?? 'legacy_pharmacy_qr',
    sourceOrganisationId: record.sourceOrganisationId,
    assignedOrganisationId: record.assignedOrganisationId,
    firstName: record.firstName,
    surname: record.surname,
    mobile: record.mobile,
    email: record.email,
    postcode: record.postcode,
    followUpStatus: lower(record.followUpStatus),
    nextFollowUpAt: null,
    pharmacyActivated: record.pharmacyAccessStatus === 'ACTIVATED',
    destinationLocked: false,
    /** Which screening check the answers failed, if any; the admin decides what it means. */
    screeningFlag: record.declineRule ?? null,
  };
}

export function toAdminIntakeDetail(
  record: PlatformSubmissionRecord,
  conditions: SubmissionConditionRecord[],
  organisationNames: Map<string, string>,
) {
  const queue = toAdminIntakeQueueItem(record);
  const primary = conditions.find(condition => condition.primary)?.conditionCode ?? null;
  return {
    ...record,
    ...queue,
    psychosisExclusion: record.psychiatricExclusion,
    conditions: conditions.map(condition => condition.conditionCode),
    primaryCondition: primary,
    assignmentVersion: record.assignmentVersion,
    pharmacyAccessStatus: lower(record.pharmacyAccessStatus),
    programmeOnboardingDecision: lower(record.onboardingDecision),
    effectiveAssignedOrganisationId: record.assignedOrganisationId,
    sourceOrganisationName: record.sourceOrganisationId
      ? organisationNames.get(record.sourceOrganisationId) ?? null
      : null,
    locationPreferenceOrganisationName: null,
    assignedOrganisationName: record.assignedOrganisationId
      ? organisationNames.get(record.assignedOrganisationId) ?? null
      : null,
    allocationRequirements: {},
    followUpAttemptCount: 0,
    followUpTimeline: [],
  };
}
