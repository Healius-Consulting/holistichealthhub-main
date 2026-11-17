import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import { assertNoIdentityClash, changedPatientFields, normalisePatientDetails, patientDetailsInputSchema } from './patient-details.js';

const input = { firstName: ' Casey ', surname: 'Reed ', dob: '1991-04-12', email: ' Casey@Example.TEST ', mobile: ' 07700 900001 ', postcode: 'ls15hd' };

const patient = (overrides: Partial<PatientRecord>): PatientRecord => ({
  id: 'p1', organisationId: 'o1', sourceSubmissionId: null, firstName: 'Casey', surname: 'Reed', dob: '1991-04-12',
  email: 'casey@example.test', mobile: '07700 900001', address: null, postcode: 'LS1 5HD', status: 'REFERRED',
  activatedAt: null, statusChangedAt: null, version: 1, createdAt: '', updatedAt: '', conditions: [], sourceSubmission: null,
  ...overrides,
});

describe('patient details', () => {
  it('normalises like the public form', () => {
    assert.deepEqual(normalisePatientDetails(patientDetailsInputSchema.parse(input)), {
      firstName: 'Casey', surname: 'Reed', dob: '1991-04-12', email: 'casey@example.test', mobile: '07700 900001', postcode: 'LS1 5HD',
    });
  });

  it('refuses an under-18 date of birth, a bad email and a bad postcode', () => {
    const nextYear = `${new Date().getUTCFullYear() - 10}-01-01`;
    assert.equal(patientDetailsInputSchema.safeParse({ ...input, dob: nextYear }).success, false);
    assert.equal(patientDetailsInputSchema.safeParse({ ...input, email: 'not-an-email' }).success, false);
    assert.equal(patientDetailsInputSchema.safeParse({ ...input, extra: 'x' }).success, false);
    assert.throws(() => normalisePatientDetails(patientDetailsInputSchema.parse({ ...input, postcode: 'NOPE' })), /valid UK postcode/);
  });

  it('lists only the fields that changed, email case-blind', () => {
    const before = normalisePatientDetails(patientDetailsInputSchema.parse(input));
    assert.deepEqual(changedPatientFields(before, { ...before, email: 'CASEY@example.test' }), []);
    assert.deepEqual(changedPatientFields(before, { ...before, mobile: '07700 900002', surname: 'Reid' }), ['surname', 'mobile']);
  });

  it('refuses an edit that matches another patient on email and date of birth', () => {
    const next = normalisePatientDetails(patientDetailsInputSchema.parse(input));
    assert.doesNotThrow(() => assertNoIdentityClash('p1', next, [patient({ id: 'p1' })]));
    assert.doesNotThrow(() => assertNoIdentityClash('p1', next, [patient({ id: 'p2', dob: '1990-01-01' })]));
    assert.throws(() => assertNoIdentityClash('p1', next, [patient({ id: 'p2', email: 'Casey@Example.test' })]), /already has that email/);
  });
});
