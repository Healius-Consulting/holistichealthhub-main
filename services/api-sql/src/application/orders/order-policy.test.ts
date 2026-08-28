import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateOrderNumber, pharmacyDeliveryChargeAllowed, pharmacyDeliveryPermitted } from './order-policy.js';

describe('Pharmacy Delivery policy', () => {
  it('grandfathers drafts created while delivery was enabled', () => {
    assert.equal(pharmacyDeliveryPermitted({ draftEnabledAtCreation: true, organisationEnabled: false }), true);
  });

  it('does not enable a draft created while disabled after the organisation turns it on', () => {
    assert.equal(pharmacyDeliveryPermitted({ draftEnabledAtCreation: false, organisationEnabled: true }), false);
  });

  it('uses the current organisation setting for direct orders', () => {
    assert.equal(pharmacyDeliveryPermitted({ organisationEnabled: true }), true);
    assert.equal(pharmacyDeliveryPermitted({ organisationEnabled: false }), false);
  });

  it('rejects malformed, excessive, and ineligible charges', () => {
    assert.equal(pharmacyDeliveryChargeAllowed(1_500, true), true);
    assert.equal(pharmacyDeliveryChargeAllowed(1_501, true), false);
    assert.equal(pharmacyDeliveryChargeAllowed(500.5, true), false);
    assert.equal(pharmacyDeliveryChargeAllowed(500, false), false);
    assert.equal(pharmacyDeliveryChargeAllowed(0, false), true);
  });
});

describe('server-generated order numbers', () => {
  it('uses the canonical time and cryptographic-suffix shape', () => {
    assert.equal(generateOrderNumber(1_700_000_000_000, 'A1B2C3D4E5'), 'ORD-LOYW3V28-A1B2C3D4E5');
  });

  it('does not repeat across a practical sample', () => {
    const references = new Set(Array.from({ length: 250 }, () => generateOrderNumber(1_700_000_000_000)));
    assert.equal(references.size, 250);
  });
});
