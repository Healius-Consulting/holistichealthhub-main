import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ageInYearsOn,
  isEligibleAge,
  latestEligibleDateOfBirth,
} from '../services/api-sql/src/domain/eligibility/age.ts';

const today = new Date('2026-09-07T12:00:00.000Z');

describe('eligibility age check', () => {
  it('accepts an adult', () => {
    assert.equal(ageInYearsOn('1990-01-01', today), 36);
    assert.equal(isEligibleAge('1990-01-01', today), true);
  });

  it('accepts someone who turns 18 today', () => {
    assert.equal(isEligibleAge('2008-09-07', today), true);
  });

  it('rejects someone who turns 18 tomorrow', () => {
    assert.equal(ageInYearsOn('2008-09-08', today), 17);
    assert.equal(isEligibleAge('2008-09-08', today), false);
  });

  it('rejects a child', () => {
    assert.equal(isEligibleAge('2015-06-01', today), false);
  });

  it('rejects a future date of birth', () => {
    assert.equal(ageInYearsOn('2027-01-01', today), null);
    assert.equal(isEligibleAge('2027-01-01', today), false);
  });

  it('rejects a date that is not real, rather than letting it roll over', () => {
    assert.equal(ageInYearsOn('2000-02-30', today), null);
    assert.equal(ageInYearsOn('not-a-date', today), null);
  });

  it('offers the newest date of birth the form may accept', () => {
    assert.equal(latestEligibleDateOfBirth(today), '2008-09-07');
    assert.equal(isEligibleAge(latestEligibleDateOfBirth(today), today), true);
  });

  it('handles a 29 February birthday in a non-leap year', () => {
    assert.equal(ageInYearsOn('2008-02-29', new Date('2026-02-28T12:00:00.000Z')), 17);
    assert.equal(ageInYearsOn('2008-02-29', new Date('2026-03-01T12:00:00.000Z')), 18);
  });
});
