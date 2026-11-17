import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { screeningFlagFor, screeningFlagsFor } from './screening.js';

describe('screening flags', () => {
  it('lists every failed check for admin, while the recorded rule stays treatments-first', () => {
    const both = { triedTwoTreatments: false, psychiatricExclusion: true };
    assert.deepEqual(screeningFlagsFor(both), ['TREATMENTS_NOT_TRIED', 'PSYCHOSIS_HISTORY']);
    assert.equal(screeningFlagFor(both), 'TREATMENTS_NOT_TRIED');
    assert.deepEqual(screeningFlagsFor({ triedTwoTreatments: true, psychiatricExclusion: true }), ['PSYCHOSIS_HISTORY']);
    assert.deepEqual(screeningFlagsFor({ triedTwoTreatments: true, psychiatricExclusion: false }), []);
  });
});
