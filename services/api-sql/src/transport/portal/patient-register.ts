import { createHash } from 'node:crypto';
import { formConditionRecords, primaryConditionCode } from '../../domain/eligibility/form-conditions.js';
import type { PlatformSubmissionRecord } from '../../repositories/ports/intake.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';

export interface PatientRegisterFilters {
  query: string;
  organisationId: string;
  status: string;
  from: string | null;
  to: string | null;
}

export interface PatientRegisterRow {
  id: string;
  name: string;
  email: string;
  mobile: string;
  dob: string;
  organisationId: string;
  pharmacyName: string;
  gphcNumber: string;
  stage: string;
  date: string | null;
  /**
   * Carried on the row because HHH admin has no other source for them: the
   * pharmacy directory is a pharmacy-staff route, and a referred application
   * has left the intake queue.
   */
  conditions: string[];
  primaryCondition: string | null;
}

function londonDateKey(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function patientStage(status: PatientRecord['status']) {
  if (status === 'ACTIVE') return 'HHH approved';
  if (status === 'REFERRED') return 'Referred';
  return 'Suspended';
}

function submissionStage(record: PlatformSubmissionRecord) {
  if (record.onboardingDecision === 'APPROVED') return 'Approved';
  if (record.onboardingDecision === 'DECLINED' || record.outcomeStatus === 'DECLINED') return 'Declined';
  if (record.followUpStatus === 'NOT_STARTED') return 'New';
  return 'Under HHH review';
}

export function buildPatientRegister(
  patients: PatientRecord[],
  submissions: PlatformSubmissionRecord[],
  organisations: OrganisationRecord[],
  filters: PatientRegisterFilters,
) {
  const organisationById = new Map(organisations.map(organisation => [organisation.id, organisation]));
  const rowsByOwnerAndEmail = new Map<string, PatientRegisterRow>();

  for (const patient of patients) {
    const organisation = organisationById.get(patient.organisationId);
    if (!patient.organisationId || !patient.email) continue;
    // Same precedence as the pharmacy's own view: the application's answers, then the patient's rows.
    const conditions = formConditionRecords({
      conditionCodes: patient.sourceSubmission?.conditionCodes,
      primaryConditionCode: patient.sourceSubmission?.primaryConditionCode,
      conditions: patient.conditions,
    });
    rowsByOwnerAndEmail.set(`${patient.organisationId}:${patient.email.toLowerCase()}`, {
      conditions: conditions.map(condition => condition.conditionCode),
      primaryCondition: primaryConditionCode(conditions),
      id: patient.id,
      name: `${patient.firstName} ${patient.surname}`.trim(),
      email: patient.email,
      mobile: patient.mobile,
      dob: patient.dob,
      organisationId: patient.organisationId,
      pharmacyName: organisation?.name || 'Unknown pharmacy',
      gphcNumber: organisation?.gphcNumber ?? '',
      stage: patientStage(patient.status),
      date: patient.updatedAt || patient.createdAt || null,
    });
  }

  for (const submission of submissions) {
    const organisationId = submission.assignedOrganisationId ?? submission.sourceOrganisationId;
    if (!organisationId || !submission.email) continue;
    const key = `${organisationId}:${submission.email.toLowerCase()}`;
    if (rowsByOwnerAndEmail.has(key)) continue;
    const organisation = organisationById.get(organisationId);
    const conditions = formConditionRecords({
      conditionCodes: submission.conditionCodes,
      primaryConditionCode: submission.primaryConditionCode,
    });
    rowsByOwnerAndEmail.set(key, {
      conditions: conditions.map(condition => condition.conditionCode),
      primaryCondition: primaryConditionCode(conditions),
      id: `sub-${submission.id}`,
      name: `${submission.firstName} ${submission.surname}`.trim(),
      email: submission.email,
      mobile: submission.mobile,
      dob: submission.dob,
      organisationId,
      pharmacyName: organisation?.name || 'Unknown pharmacy',
      gphcNumber: organisation?.gphcNumber ?? '',
      stage: submissionStage(submission),
      date: submission.updatedAt || submission.submittedAt || null,
    });
  }

  const query = filters.query.trim().toLowerCase();
  const rows = [...rowsByOwnerAndEmail.values()].filter(row => {
    if (filters.organisationId !== 'all' && row.organisationId !== filters.organisationId) return false;
    if (filters.status !== 'all' && row.stage !== filters.status) return false;
    const date = londonDateKey(row.date);
    if (filters.from && (!date || date < filters.from)) return false;
    if (filters.to && (!date || date > filters.to)) return false;
    const formattedDob = /^\d{4}-\d{2}-\d{2}$/.test(row.dob) ? row.dob.split('-').reverse().join('/') : row.dob;
    return !query || `${row.name} ${row.email} ${row.mobile} ${row.dob} ${formattedDob} ${row.pharmacyName}`.toLowerCase().includes(query);
  }).sort((left, right) => left.name.localeCompare(right.name));

  const recordScopeHash = createHash('sha256')
    .update(rows.map(row => `${row.organisationId}:${row.id}`).sort().join('|'))
    .digest('hex');
  return { rows, resultCount: rows.length, generatedAt: new Date().toISOString(), recordScopeHash };
}
