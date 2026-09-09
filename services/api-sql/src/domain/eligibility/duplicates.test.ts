import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlatformSubmissionRecord } from '../../repositories/ports/intake.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import { buildDuplicateIndex } from './duplicates.js';

const org = '70913a3071c34a41952ed532927af58c';
const names = new Map([[org, 'Primary Branch']]);
const patient = {
  id: 'p1', organisationId: org, sourceSubmissionId: 's0', firstName: 'Avery', surname: 'Morgan', dob: '1991-04-12',
  email: 'avery@example.test', status: 'ACTIVE', createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-17T10:00:00.000Z',
} as PatientRecord;
const application = (overrides: Partial<PlatformSubmissionRecord>) => ({
  id: 's1', firstName: 'Avery', surname: 'Morgan', dob: '1991-04-12', email: 'avery@example.test',
  sourceOrganisationId: org, assignedOrganisationId: null, outcomeStatus: 'OPEN', onboardingDecision: 'PENDING',
  followUpStatus: 'NOT_STARTED', submittedAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
} as PlatformSubmissionRecord);

describe('duplicate record index', () => {
  it('tags a second form with the patient record it duplicates, and where that record stands', () => {
    const second = application({ id: 's1' });
    const matches = buildDuplicateIndex([patient], [second], names)(second);
    assert.deepEqual(matches.map(match => [match.kind, match.stage, match.organisationName, match.matchedOn]),
      [['patient', 'HHH approved', 'Primary Branch', 'email']]);
  });

  it('matches on name and date of birth when the email differs', () => {
    const second = application({ id: 's1', email: 'other@example.test' });
    const matches = buildDuplicateIndex([patient], [second], names)(second);
    assert.equal(matches[0]?.matchedOn, 'identity');
  });

  it('never tags a record with itself or with the patient row its own referral produced', () => {
    const first = application({ id: 's0', outcomeStatus: 'COMPLETED', onboardingDecision: 'APPROVED' });
    assert.deepEqual(buildDuplicateIndex([patient], [first], names)(first), []);
  });

  it('lists a withdrawn earlier form beside the open one, patient row first', () => {
    const withdrawn = application({ id: 's2', outcomeStatus: 'WITHDRAWN' });
    const open = application({ id: 's3', followUpStatus: 'IN_PROGRESS' });
    const matches = buildDuplicateIndex([patient], [withdrawn, open], names)(open);
    assert.deepEqual(matches.map(match => `${match.kind}:${match.stage}`), ['patient:HHH approved', 'application:Withdrawn']);
  });

  it('does not treat two different people at the same pharmacy as duplicates', () => {
    const other = application({ id: 's4', firstName: 'Jordan', surname: 'Taylor', dob: '1980-01-01', email: 'jordan@example.test' });
    assert.deepEqual(buildDuplicateIndex([patient], [other], names)(other), []);
  });
});
