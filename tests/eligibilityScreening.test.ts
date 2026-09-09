import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  declineReasonForScreeningFlag,
  screeningFlagFor,
  screeningQuestionClause,
} from '../services/api-sql/src/domain/eligibility/screening.ts';

describe('screening at submission', () => {
  it('raises no flag for an application that meets both criteria', () => {
    assert.equal(screeningFlagFor({ triedTwoTreatments: true, psychiatricExclusion: false }), null);
  });

  it('flags an application when two licensed treatments have not been tried', () => {
    assert.equal(screeningFlagFor({ triedTwoTreatments: false, psychiatricExclusion: false }), 'TREATMENTS_NOT_TRIED');
  });

  it('flags a psychosis or schizophrenia history', () => {
    assert.equal(screeningFlagFor({ triedTwoTreatments: true, psychiatricExclusion: true }), 'PSYCHOSIS_HISTORY');
  });

  it('records only the treatments flag when both criteria fail', () => {
    assert.equal(screeningFlagFor({ triedTwoTreatments: false, psychiatricExclusion: true }), 'TREATMENTS_NOT_TRIED');
  });

  it('names the question and offers the matching decline reason', () => {
    assert.equal(screeningQuestionClause('TREATMENTS_NOT_TRIED'), 'the treatments question');
    assert.equal(screeningQuestionClause('PSYCHOSIS_HISTORY'), 'the family-history question');
    assert.equal(declineReasonForScreeningFlag('TREATMENTS_NOT_TRIED'), 'ELIGIBILITY_NOT_MET');
    assert.equal(declineReasonForScreeningFlag('PSYCHOSIS_HISTORY'), 'PSYCHIATRIC_EXCLUSION');
  });
});

describe('a failed screening is a flag for HHH admin, never a decision', () => {
  const v2 = readFileSync(new URL('../services/api-sql/src/transport/public/intake-v2.router.ts', import.meta.url), 'utf8');
  const v1 = readFileSync(new URL('../services/api-sql/src/transport/public/eligibility.router.ts', import.meta.url), 'utf8');
  const form = readFileSync(new URL('../apps/eligibility/src/EligibilityApp.tsx', import.meta.url), 'utf8');

  it('leaves every new application open with the flag recorded', () => {
    for (const source of [v2, v1]) {
      assert.match(source, /outcomeStatus: 'OPEN'/);
      assert.match(source, /declineRule: screeningFlag/);
      assert.doesNotMatch(source, /outcomeStatus: declineRule \? 'DECLINED'/);
      assert.doesNotMatch(source, /auto_declined/);
    }
  });

  it('does not tell the patient they have been declined at submission', () => {
    assert.doesNotMatch(form, /cannot refer you at the moment/);
    assert.doesNotMatch(form, /This was an automatic check/);
  });
});
