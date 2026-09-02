import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../common/errors.js';
import { assertCuraleafTestPaymentAllowed, curaleafTestPaymentAllowed } from './curaleaf-payment-lock.js';

const primary = { id: '70913a30-71c3-4a41-952e-d532927af58c' };
const eastwood = { id: '6d0176bb-89a0-4e32-9bce-c934c9557c42' };
const namedPrimary = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

describe('curaleaf test payment lock', () => {
  it('lets Primary and Alternate send for payment on Curaleaf test', () => {
    assert.equal(curaleafTestPaymentAllowed(primary, 'TEST'), true);
    assert.equal(curaleafTestPaymentAllowed({ id: 'f486a221-2236-44a5-b072-f06de399ab0e' }, 'TEST'), true);
    assert.doesNotThrow(() => assertCuraleafTestPaymentAllowed(primary, 'TEST'));
  });

  it('locks every other pharmacy while Curaleaf is test, including one named Primary Branch', () => {
    assert.equal(curaleafTestPaymentAllowed(eastwood, 'TEST'), false);
    assert.equal(curaleafTestPaymentAllowed(namedPrimary, 'TEST'), false);
    assert.throws(
      () => assertCuraleafTestPaymentAllowed(eastwood, 'TEST'),
      (error: unknown) => error instanceof HttpError && error.code === 'CURALEAF_TEST_PAYMENT_LOCKED',
    );
  });

  it('unlocks production Curaleaf for any pharmacy', () => {
    assert.equal(curaleafTestPaymentAllowed(eastwood, 'PRODUCTION'), true);
    assert.equal(curaleafTestPaymentAllowed(primary, 'PRODUCTION'), true);
  });
});
