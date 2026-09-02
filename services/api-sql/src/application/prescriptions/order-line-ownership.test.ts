import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prescriptionCorrelationKey, prescriptionOwnershipError } from './order-line-ownership.js';

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

  it('accepts create-order payloads that name prescriptions with clientKey', () => {
    assert.equal(prescriptionCorrelationKey({ clientKey: '101' }, 0), '101');
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ clientKey: '101' }, { clientKey: '102' }, { clientKey: '103' }],
      lineItems: [
        { localPrescriptionId: '101' },
        { localPrescriptionId: '102' },
        { localPrescriptionId: '103' },
      ],
    }), null);
  });

  it('accepts the live create-order shape whose clientKeys collide with array indexes', () => {
    // Drafts number prescriptions from 1. The payload sends clientKey, not id, so
    // a naive `id || index` fallback would key them as "0"/"1" and reject "2".
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ clientKey: '1' }, { clientKey: '2' }],
      lineItems: [
        { localPrescriptionId: '1' },
        { localPrescriptionId: '2' },
      ],
    }), null);
  });

  it('rejects lines whose localPrescriptionId is not a prescription clientKey', () => {
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ clientKey: '101' }, { clientKey: '102' }],
      lineItems: [
        { localPrescriptionId: '101' },
        { localPrescriptionId: '0' },
      ],
    }), 'Every medicine line must identify its prescription.');
  });

  it('keeps legacy single-prescription requests valid', () => {
    assert.equal(prescriptionOwnershipError({
      prescriptions: [{ id: '1' }],
      lineItems: [{}, {}],
    }), null);
  });
});
