import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import { buildPatientRegister } from './patient-register.js';

const organisation = {
  id: '70913a3071c34a41952ed532927af58c', tradingName: 'Primary Branch', name: 'Primary Branch Ltd', gphcNumber: '1234567',
} as OrganisationRecord;
const patient = {
  id: '11111111111141118111111111111111', organisationId: organisation.id, sourceSubmissionId: null,
  firstName: 'Avery', surname: 'Morgan', dob: '1991-04-12', email: 'avery@example.test', mobile: '07000000000',
  address: null, postcode: 'SW1A 1AA', status: 'ACTIVE', activatedAt: null, statusChangedAt: null,
  version: 1, createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-17T10:00:00.000Z',
  conditions: [], sourceSubmission: null,
} satisfies PatientRecord;

describe('SQL admin patient register', () => {
  it('projects and filters migrated patients by tenant without changing attribution', () => {
    const result = buildPatientRegister([patient], [], [organisation], {
      query: 'primary', organisationId: organisation.id, status: 'HHH approved', from: '2026-08-17', to: '2026-08-17',
    });
    assert.equal(result.resultCount, 1);
    assert.equal(result.rows[0]?.organisationId, organisation.id);
    assert.equal(result.rows[0]?.stage, 'HHH approved');
    assert.match(result.recordScopeHash, /^[a-f0-9]{64}$/);
  });

  it('does not return a patient for another pharmacy filter', () => {
    const result = buildPatientRegister([patient], [], [organisation], {
      query: '', organisationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'all', from: null, to: null,
    });
    assert.equal(result.resultCount, 0);
  });
});

describe('register rows carry conditions', () => {
  it('keeps a referred patient’s conditions from the application they came from', () => {
    const referred = {
      ...patient, id: '22222222222241118111111111111111', email: 'jordan@example.test', status: 'REFERRED',
      sourceSubmissionId: '33333333333341118111111111111111', conditions: [],
      sourceSubmission: { sourceType: 'PHARMACY_QR', triedTwoTreatments: true, psychiatricExclusion: false, heardAbout: null, marketingConsent: false, conditionCodes: ['chronic-pain', 'insomnia'], primaryConditionCode: 'insomnia' },
    } as unknown as PatientRecord;
    const result = buildPatientRegister([referred], [], [organisation], { query: '', organisationId: 'all', status: 'all', from: null, to: null });
    assert.deepEqual(result.rows[0]?.conditions, ['chronic-pain', 'insomnia']);
    assert.equal(result.rows[0]?.primaryCondition, 'insomnia');
  });

  it('falls back to the patient’s own condition rows when the application has none', () => {
    const migrated = { ...patient, conditions: [{ conditionCode: 'migraine', primary: true }] } as PatientRecord;
    const result = buildPatientRegister([migrated], [], [organisation], { query: '', organisationId: 'all', status: 'all', from: null, to: null });
    assert.deepEqual(result.rows[0]?.conditions, ['migraine']);
    assert.equal(result.rows[0]?.primaryCondition, 'migraine');
  });
});
