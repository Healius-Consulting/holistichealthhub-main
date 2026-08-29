import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prescriptionOwnershipError } from './order-line-ownership.js';

describe('multi-prescription order line ownership', () => {
  it('rejects three prescriptions when every pack is attributed to prescription 1', () => {
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ id: '1' }, { id: '2' }, { id: '3' }],
      lineItems: [
        { localPrescriptionId: '1' },
        { localPrescriptionId: '1' },
        { localPrescriptionId: '1' },
      ],
    }), 'Every prescription must have its own medicine lines.');
  });

  it('accepts distinct ownership for three prescriptions', () => {
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ id: '1' }, { id: '2' }, { id: '3' }],
      lineItems: [
        { localPrescriptionId: '1' },
        { localPrescriptionId: '2' },
        { localPrescriptionId: '3' },
      ],
    }), null);
  });

  it('keeps legacy single-prescription requests valid', () => {
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ id: '1' }],
      lineItems: [{}, {}],
    }), null);
  });
});
