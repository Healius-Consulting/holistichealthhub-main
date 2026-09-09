import { createHash } from 'node:crypto';
import { formConditionRecords, primaryConditionCode } from '../../domain/eligibility/form-conditions.js';
import { applicationStage, isClosedApplicationStage, patientStage } from '../../domain/eligibility/record-stage.js';
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

/** One stage's share of the scope, per pharmacy so the client can leave test pharmacies out. */
export interface PatientRegisterScopeCount {
  organisationId: string;
  stage: string;
  count: number;
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

/**
 * An open application belongs to the intake queue, not the register: listing it
 * in both is what made the two counts disagree. The register holds patients and
 * closed applications only — declined, or withdrawn by the patient.
 */
function registerStage(record: PlatformSubmissionRecord) {
  const stage = applicationStage(record);
  return isClosedApplicationStage(stage) ? stage : null;
}

export function buildPatientRegister(
  patients: PatientRecord[],
  submissions: PlatformSubmissionRecord[],
  organisations: OrganisationRecord[],
  filters: PatientRegisterFilters,
) {
  const organisationById = new Map(organisations.map(organisation => [organisation.id, organisation]));
  const rows: PatientRegisterRow[] = [];
  const patientKeys = new Set<string>();
  const referredSubmissionIds = new Set(patients.map(patient => patient.sourceSubmissionId).filter(Boolean));

  for (const patient of patients) {
    const organisation = organisationById.get(patient.organisationId);
    if (!patient.organisationId || !patient.email) continue;
    // Same precedence as the pharmacy's own view: the application's answers, then the patient's rows.
    const conditions = formConditionRecords({
      conditionCodes: patient.sourceSubmission?.conditionCodes,
      primaryConditionCode: patient.sourceSubmission?.primaryConditionCode,
      conditions: patient.conditions,
    });
    patientKeys.add(`${patient.organisationId}:${patient.email.toLowerCase()}`);
    rows.push({
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
    const stage = registerStage(submission);
    if (!stage) continue;
    const organisationId = submission.assignedOrganisationId ?? submission.sourceOrganisationId;
    if (!organisationId || !submission.email) continue;
    // A referral is the same event as the patient row it produced, so it is
    // not listed twice. A declined or withdrawn application is its own record:
    // a patient who sent two forms and had one withdrawn has both, and the
    // register says so rather than folding the withdrawal into the patient.
    if (stage === 'Referred' && (referredSubmissionIds.has(submission.id) || patientKeys.has(`${organisationId}:${submission.email.toLowerCase()}`))) continue;
    const organisation = organisationById.get(organisationId);
    const conditions = formConditionRecords({
      conditionCodes: submission.conditionCodes,
      primaryConditionCode: submission.primaryConditionCode,
    });
    rows.push({
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
      stage,
      date: submission.updatedAt || submission.submittedAt || null,
    });
  }

  const query = filters.query.trim().toLowerCase();
  // The scope is everything the search, pharmacy and date filters admit. The
  // stage filter narrows the rows within it, but the scope counts are reported
  // for every stage so the stage buttons can say what each one would show.
  const scope = rows.filter(row => {
    if (filters.organisationId !== 'all' && row.organisationId !== filters.organisationId) return false;
    const date = londonDateKey(row.date);
    if (filters.from && (!date || date < filters.from)) return false;
    if (filters.to && (!date || date > filters.to)) return false;
    const formattedDob = /^\d{4}-\d{2}-\d{2}$/.test(row.dob) ? row.dob.split('-').reverse().join('/') : row.dob;
    return !query || `${row.name} ${row.email} ${row.mobile} ${row.dob} ${formattedDob} ${row.pharmacyName}`.toLowerCase().includes(query);
  });
  const countsByKey = new Map<string, PatientRegisterScopeCount>();
  for (const row of scope) {
    const key = `${row.organisationId}|${row.stage}`;
    const entry = countsByKey.get(key) ?? { organisationId: row.organisationId, stage: row.stage, count: 0 };
    entry.count += 1;
    countsByKey.set(key, entry);
  }
  const matched = scope
    .filter(row => filters.status === 'all' || row.stage === filters.status)
    .sort((left, right) => left.name.localeCompare(right.name) || (right.date ?? '').localeCompare(left.date ?? ''));

  const recordScopeHash = createHash('sha256')
    .update(matched.map(row => `${row.organisationId}:${row.id}`).sort().join('|'))
    .digest('hex');
  return { rows: matched, resultCount: matched.length, scopeCounts: [...countsByKey.values()], generatedAt: new Date().toISOString(), recordScopeHash };
}
