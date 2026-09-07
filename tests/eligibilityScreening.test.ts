import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  automaticDeclineRule,
  declineReasonClause,
  isAutomaticallyDeclined,
} from '../services/api-sql/src/domain/eligibility/screening.ts';

describe('automatic screening', () => {
  it('passes an application that meets both criteria', () => {
    const answers = { triedTwoTreatments: true, psychiatricExclusion: false };
    assert.equal(automaticDeclineRule(answers), null);
    assert.equal(isAutomaticallyDeclined(answers), false);
  });

  it('declines when two licensed treatments have not been tried', () => {
    assert.equal(
      automaticDeclineRule({ triedTwoTreatments: false, psychiatricExclusion: false }),
      'TREATMENTS_NOT_TRIED',
    );
  });

  it('declines on a psychosis or schizophrenia history', () => {
    assert.equal(
      automaticDeclineRule({ triedTwoTreatments: true, psychiatricExclusion: true }),
      'PSYCHOSIS_HISTORY',
    );
  });

  it('records only the treatments rule when both criteria fail', () => {
    assert.equal(
      automaticDeclineRule({ triedTwoTreatments: false, psychiatricExclusion: true }),
      'TREATMENTS_NOT_TRIED',
    );
  });

  it('names the question the patient is told about', () => {
    assert.equal(declineReasonClause('TREATMENTS_NOT_TRIED'), 'the treatments question');
    assert.equal(declineReasonClause('PSYCHOSIS_HISTORY'), 'the family-history question');
  });
});
