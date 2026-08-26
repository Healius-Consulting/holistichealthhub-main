import assert from 'node:assert/strict';
import test from 'node:test';
import { hasEnrolledTotp } from './staff-activation.js';

test('accepts an enabled Firebase user with an enrolled TOTP factor', () => {
  assert.equal(hasEnrolledTotp({
    disabled: false,
    multiFactor: { enrolledFactors: [{ factorId: 'totp' }] },
  }), true);
});

test('rejects users without TOTP and disabled Firebase users', () => {
  assert.equal(hasEnrolledTotp({ disabled: false, multiFactor: { enrolledFactors: [] } }), false);
  assert.equal(hasEnrolledTotp({
    disabled: true,
    multiFactor: { enrolledFactors: [{ factorId: 'totp' }] },
  }), false);
});
