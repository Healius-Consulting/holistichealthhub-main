import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uuidParam } from './uuid-param.js';

describe('uuidParam', () => {
  it('accepts the hyphen-free ids Data Connect returns, and hyphenates them', () => {
    assert.equal(uuidParam.parse('cfb68e4ebe4d4805b4a67b48ab225a4c'), 'cfb68e4e-be4d-4805-b4a6-7b48ab225a4c');
  });

  it('keeps hyphenated ids as they are, lower-cased', () => {
    assert.equal(uuidParam.parse('CFB68E4E-BE4D-4805-B4A6-7B48AB225A4C'), 'cfb68e4e-be4d-4805-b4a6-7b48ab225a4c');
  });

  it('still rejects anything that is not a uuid', () => {
    for (const value of ['', 'not-a-uuid', 'cfb68e4ebe4d4805b4a67b48ab225a4', '../etc/passwd']) {
      assert.equal(uuidParam.safeParse(value).success, false, value);
    }
  });
});
