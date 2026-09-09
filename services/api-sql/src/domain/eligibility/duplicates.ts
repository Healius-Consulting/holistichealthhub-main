import type { PlatformSubmissionRecord } from '../../repositories/ports/intake.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import { applicationStage, patientStage } from './record-stage.js';

/**
 * Another record that appears to be the same person as an application in the
 * intake queue. A tag for the admin, who decides what it means: a second form
 * is usually a re-submission, occasionally a relative sharing an email.
 */
export interface DuplicateRecordMatch {
  kind: 'patient' | 'application';
  id: string;
  organisationId: string | null;
  organisationName: string | null;
  stage: string;
  name: string;
  email: string;
  date: string | null;
  matchedOn: 'email' | 'identity';
}

interface Identity {
  id: string;
  email: string;
  firstName: string;
  surname: string;
  dob: string;
}

function emailKey(email: string) {
  return email.trim().toLowerCase();
}

function identityKey(record: Identity) {
  const part = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!record.dob || !record.surname) return null;
  return `${part(record.firstName)}|${part(record.surname)}|${record.dob.trim()}`;
}

/**
 * Indexes every patient and application once so the queue can tag each of its
 * records in constant time. A record never matches itself, nor the patient
 * row its own referral produced.
 */
export function buildDuplicateIndex(
  patients: PatientRecord[],
  submissions: PlatformSubmissionRecord[],
  organisationNames: Map<string, string>,
) {
  type Candidate = DuplicateRecordMatch & { sourceSubmissionId: string | null; identity: Identity };
  const byEmail = new Map<string, Candidate[]>();
  const byIdentity = new Map<string, Candidate[]>();
  const add = (map: Map<string, Candidate[]>, key: string | null, candidate: Candidate) => {
    if (!key) return;
    map.set(key, [...(map.get(key) ?? []), candidate]);
  };
  const index = (candidate: Candidate) => {
    add(byEmail, emailKey(candidate.identity.email), candidate);
    add(byIdentity, identityKey(candidate.identity), candidate);
  };

  for (const patient of patients) {
    index({
      kind: 'patient', id: patient.id, organisationId: patient.organisationId,
      organisationName: organisationNames.get(patient.organisationId) ?? null,
      stage: patientStage(patient.status), name: `${patient.firstName} ${patient.surname}`.trim(),
      email: patient.email, date: patient.updatedAt || patient.createdAt || null, matchedOn: 'email',
      sourceSubmissionId: patient.sourceSubmissionId, identity: patient,
    });
  }
  for (const submission of submissions) {
    const organisationId = submission.assignedOrganisationId ?? submission.sourceOrganisationId;
    index({
      kind: 'application', id: submission.id, organisationId,
      organisationName: organisationId ? organisationNames.get(organisationId) ?? null : null,
      stage: applicationStage(submission), name: `${submission.firstName} ${submission.surname}`.trim(),
      email: submission.email, date: submission.updatedAt || submission.submittedAt || null, matchedOn: 'email',
      sourceSubmissionId: null, identity: submission,
    });
  }

  return (record: Identity): DuplicateRecordMatch[] => {
    const seen = new Set<string>();
    const matches: DuplicateRecordMatch[] = [];
    const collect = (candidates: Candidate[] | undefined, matchedOn: DuplicateRecordMatch['matchedOn']) => {
      for (const candidate of candidates ?? []) {
        if (candidate.id === record.id || candidate.sourceSubmissionId === record.id) continue;
        const key = `${candidate.kind}:${candidate.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { sourceSubmissionId: _source, identity: _identity, ...match } = candidate;
        matches.push({ ...match, matchedOn });
      }
    };
    collect(byEmail.get(emailKey(record.email)), 'email');
    const identity = identityKey(record);
    if (identity) collect(byIdentity.get(identity), 'identity');
    // The record that matters most first: a patient row, then the newest application.
    return matches.sort((left, right) =>
      (left.kind === right.kind ? 0 : left.kind === 'patient' ? -1 : 1) || (right.date ?? '').localeCompare(left.date ?? ''));
  };
}
