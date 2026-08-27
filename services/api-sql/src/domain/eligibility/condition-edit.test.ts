import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { conditionEditDiff, conditionEditFailureMessage, validateConditionEdit } from './condition-edit.js';

describe('staff edits to a patient condition list', () => {
  it('accepts more conditions than the public form allows', () => {
    // The intake form caps a patient at three; staff working from a clinic
    // letter are not capped, or the record could not match the prescription.
    const result = validateConditionEdit({
      conditionCodes: ['chronic-pain', 'anxiety', 'insomnia', 'migraine', 'fibromyalgia'],
      primaryConditionCode: 'migraine',
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.conditionCodes.length, 5);
    assert.equal(result.ok && result.records.filter(record => record.primary).length, 1);
    assert.equal(result.ok && result.primaryConditionCode, 'migraine');
  });

  it('marks exactly the chosen condition as primary', () => {
    const result = validateConditionEdit({
      conditionCodes: ['chronic-pain', 'anxiety'],
      primaryConditionCode: 'anxiety',
    });
    assert.ok(result.ok);
    assert.deepEqual(result.records, [
      { conditionCode: 'chronic-pain', primary: false },
      { conditionCode: 'anxiety', primary: true },
    ]);
  });

  it('collapses a duplicate pick rather than rejecting the edit', () => {
    const result = validateConditionEdit({
      conditionCodes: ['chronic-pain', 'chronic-pain', ' chronic-pain '],
      primaryConditionCode: 'chronic-pain',
    });
    assert.ok(result.ok);
    assert.deepEqual(result.conditionCodes, ['chronic-pain']);
  });

  it('refuses a code that is not in the catalogue instead of dropping it silently', () => {
    const result = validateConditionEdit({
      conditionCodes: ['chronic-pain', 'not-a-real-condition'],
      primaryConditionCode: 'chronic-pain',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(!result.ok && result.failure, { reason: 'unknown-codes', codes: ['not-a-real-condition'] });
  });

  it('refuses to leave a patient with no recorded condition', () => {
    assert.equal(validateConditionEdit({ conditionCodes: [], primaryConditionCode: 'chronic-pain' }).ok, false);
    assert.equal(validateConditionEdit({ conditionCodes: ['  '], primaryConditionCode: '' }).ok, false);
    assert.equal(validateConditionEdit({ conditionCodes: 'chronic-pain', primaryConditionCode: 'chronic-pain' }).ok, false);
  });

  it('refuses a primary that is not among the selected conditions', () => {
    const result = validateConditionEdit({
      conditionCodes: ['chronic-pain'],
      primaryConditionCode: 'anxiety',
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failure.reason, 'primary-not-selected');
  });

  it('explains a rejection in words staff can act on', () => {
    assert.equal(
      conditionEditFailureMessage({ reason: 'unknown-codes', codes: ['zzz'] }),
      'These conditions are not in the catalogue: zzz.',
    );
    assert.equal(
      conditionEditFailureMessage({ reason: 'empty' }),
      'A patient record must list at least one condition.',
    );
  });

  it('records what changed, not merely that something did', () => {
    const diff = conditionEditDiff(
      [{ conditionCode: 'chronic-pain', primary: true }, { conditionCode: 'anxiety', primary: false }],
      [{ conditionCode: 'chronic-pain', primary: false }, { conditionCode: 'migraine', primary: true }],
    );
    assert.deepEqual(diff.added, ['migraine']);
    assert.deepEqual(diff.removed, ['anxiety']);
    assert.equal(diff.primaryBefore, 'chronic-pain');
    assert.equal(diff.primaryAfter, 'migraine');
    assert.equal(diff.primaryChanged, true);
  });

  it('reports a reorder that changes nothing as no change', () => {
    const diff = conditionEditDiff(
      [{ conditionCode: 'chronic-pain', primary: true }, { conditionCode: 'anxiety', primary: false }],
      [{ conditionCode: 'anxiety', primary: false }, { conditionCode: 'chronic-pain', primary: true }],
    );
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.primaryChanged, false);
  });
});
