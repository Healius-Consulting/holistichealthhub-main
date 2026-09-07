import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlatformSubmissionRecord } from '../../repositories/ports/intake.port.js';
import { isOpenSqlIntake, toAdminIntakeDetail, toAdminIntakeQueueItem } from './intake-contracts.js';

const submission: PlatformSubmissionRecord = {
  id: '12345678-1234-4123-8123-123456789012',
  sourceOrganisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  assignedOrganisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceType: 'PHARMACY_QR',
  firstName: 'Avery', surname: 'Morgan', dob: '1991-04-12', mobile: '07000000000',
  email: 'avery@example.test', emailHash: 'example-hash', postcode: 'NG16 3AA', triedTwoTreatments: true,
  psychiatricExclusion: false, heardAbout: null, assignmentStatus: 'PROVISIONAL',
  assignmentVersion: 0, pharmacyAccessStatus: 'WITHHELD', followUpStatus: 'NOT_STARTED',
  pharmacyReviewStatus: 'NOT_OPENED', outcomeStatus: 'OPEN', onboardingDecision: 'PENDING',
  assignmentReason: null, privateAllocationNote: null, privateOnboardingNote: null,
  consentVersion: 'pharmacy-qr-v2.1', referralConsent: true, dataSharingConsent: true,
  marketingConsent: false, privacyNoticeVersion: '2026-v2.1',
  submittedAt: '2026-08-17T10:00:00.000Z', allocationCompletedAt: null,
  operationalStartedAt: null, reviewedAt: null, completedAt: null,
  updatedAt: '2026-08-17T10:00:00.000Z',
};

describe('SQL admin intake projections', () => {
  it('keeps a dedicated intake unactivated until referral', () => {
    const projected = toAdminIntakeQueueItem(submission);
    assert.equal(projected.caseReference, 'HHH-20260817-12345678');
    assert.equal(projected.sourceType, 'future_pharmacy_qr');
    assert.equal(projected.destinationLocked, false);
    assert.equal(projected.pharmacyActivated, false);
    assert.equal(projected.displayStatus, 'Awaiting referral decision');
  });

  it('includes selected conditions only in the authorised detail projection', () => {
    const detail = toAdminIntakeDetail(submission, [
      { conditionCode: 'chronic-pain', primary: true },
      { conditionCode: 'sleep-disorders', primary: false },
    ], new Map([[submission.sourceOrganisationId!, 'Eastwood Health Ltd']]));
    assert.deepEqual(detail.conditions, ['chronic-pain', 'sleep-disorders']);
    assert.equal(detail.primaryCondition, 'chronic-pain');
    assert.equal(detail.sourceOrganisationName, 'Eastwood Health Ltd');
    assert.equal(detail.psychosisExclusion, false);
  });

  it('excludes completed outcomes from active queues', () => {
    assert.equal(isOpenSqlIntake(submission), true);
    assert.equal(isOpenSqlIntake({ ...submission, outcomeStatus: 'COMPLETED' }), false);
  });
});
