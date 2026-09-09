import type { PlatformSubmissionRecord } from '../../repositories/ports/intake.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';

/** The stage words the admin register and intake share for a patient row. */
export function patientStage(status: PatientRecord['status']) {
  if (status === 'ACTIVE') return 'HHH approved';
  if (status === 'REFERRED') return 'Referred';
  return 'Suspended';
}

/** Where an application stands, open or closed, in the same words the register uses. */
export function applicationStage(record: Pick<PlatformSubmissionRecord, 'outcomeStatus' | 'onboardingDecision' | 'followUpStatus'>) {
  if (record.outcomeStatus === 'WITHDRAWN') return 'Withdrawn';
  if (record.onboardingDecision === 'DECLINED' || record.outcomeStatus === 'DECLINED') return 'Declined';
  if (record.onboardingDecision === 'APPROVED' || record.outcomeStatus === 'COMPLETED') return 'Referred';
  if (record.followUpStatus === 'NOT_STARTED') return 'New';
  return 'Under HHH review';
}

export function isClosedApplicationStage(stage: string): stage is 'Referred' | 'Declined' | 'Withdrawn' {
  return stage === 'Referred' || stage === 'Declined' || stage === 'Withdrawn';
}
